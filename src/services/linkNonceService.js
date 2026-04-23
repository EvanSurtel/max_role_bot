// One-time link nonce service for the wallet web surface.
//
// Mints cryptographically-random nonces, persists them, and builds
// the URL the bot DMs to the user. The web surface (Next.js app on
// Vercel) calls back into the bot's /api/internal/link/redeem with
// the nonce; we verify + consume + return the bound Discord ID.
//
// URL shape: <WALLET_WEB_BASE_URL>/<purpose>?t=<32-byte hex nonce>
//   examples:
//     https://rank-wallet.vercel.app/setup?t=a1b2...
//     https://rank-wallet.vercel.app/withdraw?t=c3d4...
//     https://rank-wallet.vercel.app/renew?t=e5f6...

const crypto = require('crypto');
const linkNonceRepo = require('../database/repositories/linkNonceRepo');

const VALID_PURPOSES = new Set(['setup', 'withdraw', 'renew', 'deposit-cdp', 'cashout-cdp']);

/**
 * Generate a one-time nonce for a Discord user, persist it, and
 * return the URL to DM them.
 *
 * @param {Object} args
 * @param {number} args.userId         - internal user id (users.id, not discord_id)
 * @param {string} args.purpose        - 'setup' | 'withdraw' | 'renew'
 * @param {number} [args.ttlSeconds=600] - 10 min default
 * @returns {string} the full URL to DM the user
 */
function mintLink({ userId, purpose, ttlSeconds = 600, metadata = null }) {
  if (!VALID_PURPOSES.has(purpose)) {
    throw new Error(`Invalid link purpose: ${purpose}`);
  }
  const baseUrl = process.env.WALLET_WEB_BASE_URL;
  if (!baseUrl) {
    throw new Error('WALLET_WEB_BASE_URL env var is not set — cannot mint wallet link');
  }

  const nonce = crypto.randomBytes(32).toString('hex');
  linkNonceRepo.create({ nonce, userId, purpose, ttlSeconds, metadata });

  // baseUrl might or might not have a trailing slash; normalize.
  // URL path uses 'deposit/coinbase' for the CDP-onramp purpose so the
  // user-facing route reads naturally; everything else mirrors purpose.
  const trimmed = baseUrl.replace(/\/$/, '');
  const PATH_OVERRIDES = {
    'deposit-cdp': 'deposit/coinbase',
    'cashout-cdp': 'cashout/coinbase',
  };
  const path = PATH_OVERRIDES[purpose] || purpose;
  return `${trimmed}/${path}?t=${nonce}`;
}

/**
 * Validate + consume a nonce on behalf of the web surface. Called
 * from the internal HTTP endpoint, never exposed publicly.
 *
 * Returns:
 *   { ok: true, userId, discordId, purpose } on success
 *   { ok: false, error: 'string' } otherwise — error string is
 *   intentionally generic ("Link expired or already used") to avoid
 *   leaking whether the nonce was real-but-consumed vs. fake.
 */
function redeem({ nonce, purpose }) {
  if (!nonce || typeof nonce !== 'string') {
    return { ok: false, error: 'Missing nonce' };
  }
  if (!VALID_PURPOSES.has(purpose)) {
    return { ok: false, error: 'Invalid purpose' };
  }

  const row = linkNonceRepo.consume(nonce);
  if (!row) {
    return { ok: false, error: 'Link expired or already used' };
  }
  if (row.purpose !== purpose) {
    // Caller is trying to redeem a setup-link as a withdraw-link, etc.
    return { ok: false, error: 'Link purpose mismatch' };
  }

  // Look up Discord ID from internal user id so the browser knows
  // who it's binding the wallet to.
  const userRepo = require('../database/repositories/userRepo');
  const user = userRepo.findById(row.user_id);
  if (!user) {
    return { ok: false, error: 'Account not found' };
  }
  let metadata = null;
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata); }
    catch { metadata = null; }
  }
  return {
    ok: true,
    userId: row.user_id,
    discordId: user.discord_id,
    discordTag: user.server_username || user.cod_ign || `user-${user.discord_id}`,
    purpose: row.purpose,
    metadata,
  };
}

module.exports = { mintLink, redeem };
