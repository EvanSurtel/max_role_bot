// Demo-channel auto-provision helper.
//
// In the review / demo channel (configured via DEMO_CHANNEL_ID),
// anyone clicking "View My Wallet" who isn't already a registered
// Rank $ player gets a minimal user row created automatically so
// they can exercise the wallet flow — wallet setup, deposit, cashout —
// without going through the COD-specific registration form. Access
// control is the Discord channel perms themselves; no additional
// allowlist is enforced in code.
//
// Previously this file also exported an `isReviewer(discordId)` check
// driven by a CDP_REVIEWER_DISCORD_IDS env var. That was dropped in
// 5d2650a once the demo channel was made open to anyone who can see it.

/**
 * Ensure a minimal user row exists for a demo-channel clicker. Just
 * enough to satisfy downstream code that expects userRepo.findByDiscordId
 * to return non-null for any active interaction. TOS is pre-accepted
 * (demo-channel users aren't real players so the gating doesn't
 * apply). Display name is derived from the Discord tag so the
 * transaction feed shows something readable.
 *
 * Idempotent: if the user already has a row, returns it untouched.
 *
 * @param {string} discordId
 * @param {string} tag - Discord username (for display)
 * @returns {object} user row
 */
function ensureReviewerUser(discordId, tag = null) {
  const userRepo = require('../database/repositories/userRepo');
  const existing = userRepo.findByDiscordId(discordId);
  if (existing) return existing;

  // TOCTOU: two clicks from the same user within ms can both see
  // existing=null and both call userRepo.create. The second throws a
  // UNIQUE constraint on users.discord_id. Catch that case and treat
  // it as "someone else already created the row; re-fetch and use it."
  let user;
  try {
    user = userRepo.create(discordId);
  } catch (createErr) {
    const refetched = userRepo.findByDiscordId(discordId);
    if (refetched) return refetched;
    throw createErr;
  }

  const db = require('../database/db');
  // Fill in minimal COD-side fields so downstream code (transaction
  // feed, admin notifications, etc.) doesn't blow up on null displays.
  // Country defaults to US — same as the demo channel's country
  // override — so CDP Onramp shows every provider option to the
  // clicker regardless of where they're actually signing in from.
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
    display: tag ? `Demo User (${tag})` : `Demo User`,
    codUid: `demo-${discordId.slice(-8)}`,
  });
  return userRepo.findByDiscordId(discordId);
}

module.exports = { ensureReviewerUser };
