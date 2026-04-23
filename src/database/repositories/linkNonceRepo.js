// One-time link nonces for the wallet web surface.
//
// When a user clicks "Set Up Wallet" / "Withdraw" / "Renew" in
// Discord, we mint a 32-byte random nonce, store it here with a
// 10-minute TTL bound to the user's Discord ID, and DM them a URL
// of the form https://wallet/setup?t=<nonce>. The web surface
// POSTs the nonce back to /api/internal/link/redeem; we verify
// it's the right user and not yet consumed, mark it consumed, and
// hand back the Discord ID + tag so the browser can bind the
// about-to-be-created Smart Wallet to the right user.
//
// Single-use + short TTL bounds the impact of a leaked URL — if
// someone shoulder-surfs a Discord DM, the link they grab is dead
// the moment the legitimate user clicks it (or 10 minutes later).

const db = require('../db');

const stmts = {
  insert: db.prepare(`
    INSERT INTO discord_link_nonces (nonce, user_id, purpose, expires_at, metadata)
    VALUES (@nonce, @userId, @purpose, @expiresAt, @metadata)
  `),
  findByNonce: db.prepare('SELECT * FROM discord_link_nonces WHERE nonce = ?'),
  consume: db.prepare(`
    UPDATE discord_link_nonces
    SET consumed_at = datetime('now')
    WHERE nonce = ? AND consumed_at IS NULL
  `),
  // Sweep expired/consumed rows older than 1 day so the table stays small.
  pruneOld: db.prepare(`
    DELETE FROM discord_link_nonces
    WHERE (consumed_at IS NOT NULL AND consumed_at < datetime('now', '-1 day'))
       OR expires_at < datetime('now', '-1 day')
  `),
};

const linkNonceRepo = {
  /**
   * Insert a new nonce for the given user + purpose. TTL defaults
   * to 10 minutes from now.
   */
  create({ nonce, userId, purpose, ttlSeconds = 600, metadata = null }) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const metaStr = metadata == null ? null : JSON.stringify(metadata);
    stmts.insert.run({ nonce, userId, purpose, expiresAt, metadata: metaStr });
    return { nonce, userId, purpose, expiresAt, metadata };
  },

  findByNonce(nonce) {
    return stmts.findByNonce.get(nonce) || null;
  },

  /**
   * Atomically mark a nonce consumed. Returns the row IF the consume
   * succeeded (nonce existed AND wasn't already consumed AND wasn't
   * expired). Returns null otherwise — caller surfaces a generic
   * "link expired or already used" error to avoid telling an attacker
   * whether the nonce was real but consumed vs. fake entirely.
   */
  consume(nonce) {
    const row = stmts.findByNonce.get(nonce);
    if (!row) return null;
    if (row.consumed_at) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    const result = stmts.consume.run(nonce);
    if (result.changes === 0) return null;
    // Re-fetch to get the consumed_at timestamp the UPDATE just set.
    return stmts.findByNonce.get(nonce);
  },

  pruneOld() {
    return stmts.pruneOld.run();
  },
};

module.exports = linkNonceRepo;
