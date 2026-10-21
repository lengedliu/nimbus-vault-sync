const crypto = require('crypto');

// In-memory store for pairing codes: code -> { data, expiresAt }
const pairSessions = new Map();

// Periodic cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, item] of pairSessions.entries()) {
    if (item.expiresAt < now) {
      pairSessions.delete(code);
    }
  }
}, 5 * 60 * 1000).unref();

function generateCode() {
  return crypto.randomBytes(4).toString('hex').toLowerCase(); // 8 hex chars
}

function createPairSession(payload, { maxReads = 5 } = {}) {
  const code = generateCode();
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 mins
  pairSessions.set(code, {
    payload,
    expiresAt,
    reads: 0,
    maxReads,
  });
  return { code, expiresAt };
}

function getPairSession(code) {
  if (!code) return null;
  const clean = String(code).trim().toLowerCase();
  const session = pairSessions.get(clean);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    pairSessions.delete(clean);
    return null;
  }
  session.reads = (session.reads || 0) + 1;
  if (session.maxReads && session.reads >= session.maxReads) {
    pairSessions.delete(clean);
  }
  return session.payload;
}

module.exports = {
  createPairSession,
  getPairSession,
};
