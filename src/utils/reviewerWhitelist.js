// CDP reviewer whitelist.
//
// Coinbase Developer Platform reviewers need to exercise the full
// self-custody wallet flow (onboarding → setup link → passkey → daily
// limit → deposit / cashout) during application review. But they're
// not real Rank $ players — forcing them through the COD-specific
// registration form (IGN, in-game UID, country for leaderboard
// placement) is friction they don't need.
//
// This whitelist lets specific Discord IDs skip the COD form entirely
// and go straight to the self-custody setup link, same as every real
// user gets post-onboarding-refactor. The reviewer still does the
// one-time email + passkey on keys.coinbase.com — that step is the
// actual self-custody proof point and cannot be skipped.
//
// Configured via env var CDP_REVIEWER_DISCORD_IDS — comma-separated
// list of Discord user IDs. Example:
//   CDP_REVIEWER_DISCORD_IDS=1283157620236222550,1197537330672705568

let _cached = null;

function _load() {
  const raw = process.env.CDP_REVIEWER_DISCORD_IDS || '';
  return new Set(
    raw
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0),
  );
}

/**
 * Is this Discord ID a CDP reviewer (per the whitelist)?
 * @param {string} discordId
 * @returns {boolean}
 */
function isReviewer(discordId) {
  if (!discordId) return false;
  if (_cached === null) _cached = _load();
  return _cached.has(String(discordId));
}

/**
 * Force-reload the whitelist from env. Call this if the env var
 * changes at runtime (normally: restart the bot instead).
 */
function reload() {
  _cached = _load();
}

/**
 * Ensure a minimal user row exists for a reviewer. No COD form, no
 * region/country select — just enough to satisfy downstream code that
 * expects userRepo.findByDiscordId to return non-null for any active
 * interaction. TOS is pre-accepted (reviewers aren't real players so
 * the gating doesn't apply). Display name is derived from the Discord
 * tag so the transaction feed shows something readable.
 *
 * Idempotent: if the reviewer already has a user row, returns it
 * untouched.
 *
 * @param {string} discordId
 * @param {string} tag - Discord username (for display)
 * @returns {object} user row
 */
function ensureReviewerUser(discordId, tag = null) {
  const userRepo = require('../database/repositories/userRepo');
  const existing = userRepo.findByDiscordId(discordId);
  if (existing) return existing;

  const user = userRepo.create(discordId);
  const db = require('../database/db');
  // Fill in minimal COD-side fields so downstream code (transaction
  // feed, admin notifications, etc.) doesn't blow up on null displays.
  // Country defaults to US — same as the demo channel's country
  // override — so CDP Onramp shows every provider option to the
  // reviewer regardless of where they're actually signing in from.
  db.prepare(`
    UPDATE users
    SET accepted_tos = 1,
        tos_accepted_at = datetime('now'),
        server_username = @display,
        cod_ign = 'cdp-reviewer',
        cod_uid = @codUid,
        cod_server = 'NA',
        country_flag = '🇺🇸',
        country_code = 'US',
        region = 'na',
        deposit_region = 'GROUP_A'
    WHERE id = @id
  `).run({
    id: user.id,
    display: tag ? `CDP Reviewer (${tag})` : `CDP Reviewer`,
    codUid: `cdp-review-${discordId.slice(-8)}`,
  });
  return userRepo.findByDiscordId(discordId);
}

module.exports = { isReviewer, reload, ensureReviewerUser };
