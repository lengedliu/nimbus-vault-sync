const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const INDEX_DIR = path.join(DATA_DIR, 'indexes');
const SEARCHABLE_EXT_RE = /\.(md|txt|json|js|ts|css|html|yaml|yml|csv|canvas|py|sh|sql)$/i;
const MAX_INDEXABLE_BYTES = 2 * 1024 * 1024; // 2MB

// BM25 parameters
const K1 = 1.2;
const B = 0.75;

/**
 * High-performance CJK + Latin Tokenizer.
 * Extracts word tokens, subwords, and CJK unigrams/bigrams for precise phrase matching.
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  const tokens = [];
  const lower = text.toLowerCase();
  
  // 1. Match Latin words / numbers / identifiers
  const latinMatches = lower.matchAll(/[a-z0-9_\-\.]{2,}/g);
  for (const m of latinMatches) {
    tokens.push({ term: m[0], pos: m.index });
  }

  // 2. Match CJK characters (Chinese, Japanese, Korean) with unigrams & bigrams
  const cjkRegex = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g;
  let lastCjk = null;
  let lastPos = -1;
  let match;

  while ((match = cjkRegex.exec(lower)) !== null) {
    const char = match[0];
    const pos = match.index;
    // Unigram
    tokens.push({ term: char, pos });

    // Bigram if adjacent
    if (lastCjk !== null && pos === lastPos + 1) {
      tokens.push({ term: lastCjk + char, pos: lastPos });
    }
    lastCjk = char;
    lastPos = pos;
  }

  return tokens;
}

class VaultFTSIndex {
  constructor(vaultId) {
    this.vaultId = vaultId;
    // term -> Map(path -> { freq: number, positions: number[] })
    this.postings = new Map();
    // path -> { mtime: number, size: number, hash: string, docLength: number, lineBreaks: number[] }
    this.docs = new Map();
    this.totalDocLength = 0;
    this.isIndexing = false;
    this.isLoaded = false;
    this.dirty = false;
    this.persistTimer = null;
  }

  get docCount() {
    return this.docs.size;
  }

  get avgDocLength() {
    return this.docCount > 0 ? this.totalDocLength / this.docCount : 1;
  }

  removeDocument(relPath) {
    const doc = this.docs.get(relPath);
    if (!doc) return;

    this.totalDocLength -= (doc.docLength || 0);
    this.docs.delete(relPath);

    // Remove from postings
    for (const [term, postingMap] of this.postings.entries()) {
      if (postingMap.has(relPath)) {
        postingMap.delete(relPath);
        if (postingMap.size === 0) {
          this.postings.delete(term);
        }
      }
    }
    this._schedulePersist();
  }

  addOrUpdateDocument(relPath, text, meta) {
    // If already exists, remove old first
    if (this.docs.has(relPath)) {
      this.removeDocument(relPath);
    }

    if (!text || typeof text !== 'string') return;

    const tokens = tokenize(text);
    const docLength = tokens.length;
    this.totalDocLength += docLength;

    // Build line breaks index for fast snippet location
    const lineBreaks = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') lineBreaks.push(i);
    }

    this.docs.set(relPath, {
      mtime: meta?.mtime || Date.now(),
      size: meta?.size || text.length,
      hash: meta?.hash || '',
      docLength,
      lineBreaks,
    });

    for (const { term, pos } of tokens) {
      let postingMap = this.postings.get(term);
      if (!postingMap) {
        postingMap = new Map();
        this.postings.set(term, postingMap);
      }
      let entry = postingMap.get(relPath);
      if (!entry) {
        entry = { freq: 0, positions: [] };
        postingMap.set(relPath, entry);
      }
      entry.freq += 1;
      if (entry.positions.length < 50) {
        entry.positions.push(pos);
      }
    }

    this._schedulePersist();
  }

  _schedulePersist() {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.saveToDisk();
    }, 5000);
  }

  saveToDisk() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(INDEX_DIR, { recursive: true });
      const filePath = path.join(INDEX_DIR, `fts_${this.vaultId}.json`);
      const serializedDocs = {};
      for (const [k, v] of this.docs.entries()) {
        serializedDocs[k] = v;
      }
      const serializedPostings = {};
      for (const [term, pMap] of this.postings.entries()) {
        serializedPostings[term] = {};
        for (const [p, val] of pMap.entries()) {
          serializedPostings[term][p] = val;
        }
      }

      const data = {
        vaultId: this.vaultId,
        totalDocLength: this.totalDocLength,
        docs: serializedDocs,
        postings: serializedPostings,
      };

      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
      fs.renameSync(tmpPath, filePath);
      this.dirty = false;
    } catch (err) {
      console.error('[FTS] Save index error:', err.message);
    }
  }

  loadFromDisk() {
    if (this.isLoaded) return true;
    this.isLoaded = true;
    try {
      const filePath = path.join(INDEX_DIR, `fts_${this.vaultId}.json`);
      if (!fs.existsSync(filePath)) return false;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!raw || !raw.docs || !raw.postings) return false;

      this.totalDocLength = raw.totalDocLength || 0;
      this.docs.clear();
      for (const [k, v] of Object.entries(raw.docs)) {
        this.docs.set(k, v);
      }

      this.postings.clear();
      for (const [term, pObj] of Object.entries(raw.postings)) {
        const pMap = new Map();
        for (const [p, val] of Object.entries(pObj)) {
          pMap.set(p, val);
        }
        this.postings.set(term, pMap);
      }
      return true;
    } catch (err) {
      console.error('[FTS] Load index error:', err.message);
      return false;
    }
  }

  /**
   * Search index using BM25 relevance score and phrase proximity.
   */
  search(query, { limit = 50, folder = null, readContentFn = null } = {}) {
    if (!query || !query.trim()) return [];
    const qLower = query.trim().toLowerCase();
    const queryTokens = tokenize(query);

    const scoredDocs = new Map(); // path -> { score, pathMatch, matchCount, termPositions }
    const N = Math.max(this.docCount, 1);
    const avgDl = this.avgDocLength;

    // Check path matches
    for (const [docPath, docInfo] of this.docs.entries()) {
      if (folder && !docPath.startsWith(folder)) continue;
      const pathLower = docPath.toLowerCase();
      if (pathLower.includes(qLower)) {
        const score = 15.0 + (pathLower.endsWith('/' + qLower) ? 10 : 0);
        scoredDocs.set(docPath, {
          score,
          pathMatch: true,
          matchCount: 1,
          termPositions: [],
        });
      }
    }

    // Evaluate token matches via BM25
    for (const { term } of queryTokens) {
      const postingMap = this.postings.get(term);
      if (!postingMap) continue;

      const df = postingMap.size;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));

      for (const [docPath, entry] of postingMap.entries()) {
        if (folder && !docPath.startsWith(folder)) continue;
        const doc = this.docs.get(docPath);
        if (!doc) continue;

        const tf = entry.freq;
        const dl = doc.docLength || 1;
        const bm25 = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / avgDl))));

        let docScore = scoredDocs.get(docPath);
        if (!docScore) {
          docScore = {
            score: 0,
            pathMatch: false,
            matchCount: 0,
            termPositions: [],
          };
          scoredDocs.set(docPath, docScore);
        }
        docScore.score += bm25;
        docScore.matchCount += entry.freq;
        if (entry.positions && entry.positions.length > 0) {
          docScore.termPositions.push(...entry.positions);
        }
      }
    }

    if (scoredDocs.size === 0) {
      // Fallback: search doc paths if not in docs map (e.g. binary files)
      return [];
    }

    // Sort by score descending
    const sorted = Array.from(scoredDocs.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit);

    const results = [];
    for (const [docPath, info] of sorted) {
      const doc = this.docs.get(docPath);
      let snippet = '';
      let lineNumber = 1;

      if (readContentFn) {
        try {
          const text = readContentFn(docPath);
          if (text) {
            const lowerText = text.toLowerCase();
            let idx = lowerText.indexOf(qLower);
            if (idx === -1 && info.termPositions.length > 0) {
              idx = info.termPositions[0];
            }
            if (idx !== -1) {
              // Calculate line number
              let lineCount = 1;
              for (let i = 0; i < idx; i++) {
                if (text[i] === '\n') lineCount++;
              }
              lineNumber = lineCount;

              const start = Math.max(0, idx - 40);
              const end = Math.min(text.length, idx + qLower.length + 60);
              const rawSlice = text.slice(start, end).replace(/[\r\n]+/g, ' ');
              snippet = (start > 0 ? '…' : '') + rawSlice + (end < text.length ? '…' : '');
            }
          }
        } catch {}
      }

      results.push({
        path: docPath,
        size: doc ? doc.size : 0,
        mtime: doc ? doc.mtime : 0,
        score: Math.round(info.score * 100) / 100,
        isPathMatch: info.pathMatch,
        matchesCount: info.matchCount,
        lineNumber,
        snippet,
      });
    }

    return results;
  }
}

class FTSService {
  constructor() {
    this.vaultIndexes = new Map();
  }

  getIndex(vaultId) {
    let index = this.vaultIndexes.get(vaultId);
    if (!index) {
      index = new VaultFTSIndex(vaultId);
      index.loadFromDisk();
      this.vaultIndexes.set(vaultId, index);
    }
    return index;
  }

  onFileWrite(vaultId, relPath, text, meta) {
    if (!SEARCHABLE_EXT_RE.test(relPath) || (meta?.size || 0) > MAX_INDEXABLE_BYTES) {
      return;
    }
    const idx = this.getIndex(vaultId);
    idx.addOrUpdateDocument(relPath, text, meta);
  }

  onFileDelete(vaultId, relPath) {
    const idx = this.getIndex(vaultId);
    idx.removeDocument(relPath);
  }

  async buildVaultIndexAsync(vaultId, manifest, readFileFn) {
    const idx = this.getIndex(vaultId);
    if (idx.isIndexing) return;
    idx.isIndexing = true;

    try {
      const paths = Object.keys(manifest || {});
      const toIndex = [];

      for (const p of paths) {
        const meta = manifest[p];
        if (!SEARCHABLE_EXT_RE.test(p) || meta.size > MAX_INDEXABLE_BYTES) continue;
        const existing = idx.docs.get(p);
        if (!existing || existing.mtime !== meta.mtime || existing.size !== meta.size) {
          toIndex.push(p);
        }
      }

      // Remove deleted files
      for (const p of Array.from(idx.docs.keys())) {
        if (!manifest[p]) {
          idx.removeDocument(p);
        }
      }

      const BATCH = 20;
      for (let i = 0; i < toIndex.length; i += BATCH) {
        const chunk = toIndex.slice(i, i + BATCH);
        for (const p of chunk) {
          try {
            const buf = readFileFn(p);
            if (buf) {
              const text = buf.toString('utf8');
              idx.addOrUpdateDocument(p, text, manifest[p]);
            }
          } catch {}
        }
        await new Promise((resolve) => setImmediate(resolve));
      }

      idx.saveToDisk();
    } catch (err) {
      console.error('[FTS] Background build index error:', err.message);
    } finally {
      idx.isIndexing = false;
    }
  }

  searchVault(vaultId, query, { limit = 50, folder = null, readContentFn = null } = {}) {
    const idx = this.getIndex(vaultId);
    return idx.search(query, { limit, folder, readContentFn });
  }
}

const ftsService = new FTSService();
module.exports = ftsService;
