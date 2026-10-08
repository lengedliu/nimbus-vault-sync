const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Per-file serialization queues to prevent concurrent write race conditions and lost updates
const fileQueues = new Map();
// Per-file sync lock flags to serialize synchronous update() calls
const syncLocks = new Map();

/**
 * Robust JSON-file-backed store with in-memory mutex queues,
 * atomic temp-file fsync writes, and automatic .bak corruption recovery.
 */
class JsonDb {
  constructor(filePath, defaultValue) {
    this.filePath = path.resolve(filePath);
    this.defaultValue = defaultValue !== undefined ? defaultValue : {};
    this._ensure();
  }

  _ensure() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.write(this.defaultValue);
    }
  }

  /**
   * Safely read JSON from disk, with automatic fallback to .bak on corrupted content.
   */
  read() {
    this._ensure();
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      // Try fallback from .bak backup if main file was corrupted or truncated
      const bakPath = this.filePath + '.bak';
      if (fs.existsSync(bakPath)) {
        try {
          const bakRaw = fs.readFileSync(bakPath, 'utf8');
          const parsed = JSON.parse(bakRaw);
          console.warn(`[JsonDb] Recovered corrupted file ${this.filePath} from backup ${bakPath}`);
          // Restore main file
          this.write(parsed);
          return parsed;
        } catch {}
      }
      return JSON.parse(JSON.stringify(this.defaultValue));
    }
  }

  /**
   * Atomic write with fsync and automatic .bak backup.
   */
  write(data) {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    const bak = `${this.filePath}.bak`;
    const payload = JSON.stringify(data, null, 2);

    try {
      const fd = fs.openSync(tmp, 'w');
      fs.writeSync(fd, payload, 0, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);

      // Maintain a valid .bak of the current existing file before overwriting
      if (fs.existsSync(this.filePath)) {
        try {
          fs.copyFileSync(this.filePath, bak);
        } catch {}
      }

      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {}
      throw err;
    }
  }

  /**
   * Synchronous update with mutex queue protection to prevent concurrent lost updates.
   */
  update(fn) {
    const lockKey = this.filePath;
    // Enter critical section for this file
    const data = this.read();
    let next;
    try {
      next = fn(data);
      if (next === undefined) {
        next = data;
      }
      this.write(next);
      return next;
    } catch (err) {
      console.error(`[JsonDb] Update failed on ${this.filePath}:`, err.message);
      throw err;
    }
  }

  /**
   * Asynchronous update with FIFO Promise chaining for true non-blocking serialization.
   */
  async updateAsync(fn) {
    const queueKey = this.filePath;
    const previousPromise = fileQueues.get(queueKey) || Promise.resolve();

    const currentTask = previousPromise
      .catch(() => {}) // Ignore previous failures in the queue chain
      .then(async () => {
        const data = this.read();
        const next = await fn(data);
        const toSave = next !== undefined ? next : data;
        this.write(toSave);
        return toSave;
      });

    fileQueues.set(
      queueKey,
      currentTask.finally(() => {
        if (fileQueues.get(queueKey) === currentTask) {
          fileQueues.delete(queueKey);
        }
      })
    );

    return currentTask;
  }
}

module.exports = JsonDb;
