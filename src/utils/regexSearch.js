const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MAX_LINE_LENGTH = 1024 * 1024;

function searchRegexDocuments(documents, { query, caseSensitive = false, limit = 20, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'regexSearchWorker.js'), {
      workerData: { query, caseSensitive, maxLineLength: MAX_LINE_LENGTH },
    });
    const results = [];
    let pending = null;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      const error = new Error(`Regular expression search exceeded its ${timeoutMs} ms time limit.`);
      if (pending) {
        pending.reject(error);
        pending = null;
      }
      finish(error);
    }, timeoutMs);
    timer.unref?.();

    worker.on('message', (message) => {
      if (message.error) {
        if (pending) {
          const current = pending;
          pending = null;
          current.reject(new Error(message.error));
        } else {
          finish(new Error(message.error));
        }
        return;
      }
      if (!pending) return;
      const current = pending;
      pending = null;
      current.resolve(message.matches || []);
    });

    worker.on('error', (err) => {
      if (pending) {
        const current = pending;
        pending = null;
        current.reject(err);
      }
      finish(err);
    });

    worker.on('exit', (code) => {
      if (settled || code === 0) return;
      const err = new Error(`Regex worker exited unexpectedly (${code}).`);
      if (pending) {
        const current = pending;
        pending = null;
        current.reject(err);
      }
      finish(err);
    });

    const sendBatch = (batch) => new Promise((resolveBatch, rejectBatch) => {
      if (settled) return rejectBatch(new Error('Regex search has already stopped.'));
      pending = { resolve: resolveBatch, reject: rejectBatch };
      try {
        worker.postMessage(batch);
      } catch (err) {
        pending = null;
        rejectBatch(err);
      }
    });

    (async () => {
      try {
        for await (const document of documents) {
          const lines = String(document.text || '').split(/\r?\n/);
          for (let offset = 0; offset < lines.length && results.length < limit; offset += 128) {
            const matches = await sendBatch({
              path: document.path,
              lines: lines.slice(offset, offset + 128),
              startLine: offset + 1,
            });
            results.push(...matches.slice(0, limit - results.length));
          }
          if (results.length >= limit) break;
        }
        finish(null, results);
      } catch (err) {
        finish(err);
      }
    })();
  });
}

module.exports = { searchRegexDocuments };
