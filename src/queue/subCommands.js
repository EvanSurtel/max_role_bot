// Sub player in/out logic — staff-only substitution management.
//
// Depends on state.js for match lookup and helpers.js for the _newPlayer
// factory. Used by interactions.js when staff triggers a sub via buttons.

const userRepo = require('../database/repositories/userRepo');
const QUEUE_CONFIG = require('../config/queueConfig');
const { getMatch, _newPlayer } = require('./state');

/**
 * Sub a player out and bring in a replacement.
 * @param {number} matchId — Match ID.
 * @param {string} discordId — Player being subbed out.
 * @param {string} replacementDiscordId — Replacement player.
 * @param {'fresh'|'mid_series'} subType — 'fresh' (no games played) or 'mid_series'.
 * @returns {{ success: boolean, error?: string }}
 */
function subPlayerOut(matchId, discordId, replacementDiscordId, subType) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };

  const player = match.players.get(discordId);
  if (!player) return { success: false, error: 'Player not in match' };

  // Create replacement player on the same team
  const repUser = userRepo.findByDiscordId(replacementDiscordId);
  const repXp = repUser ? repUser.xp_points : 500;
  const replacement = _newPlayer(replacementDiscordId, repXp);
  replacement.team = player.team;
  replacement.subType = subType;

  // Update team arrays
  if (player.team === 1) {
    const idx = match.team1.indexOf(discordId);
    if (idx !== -1) match.team1[idx] = replacementDiscordId;
  } else if (player.team === 2) {
    const idx = match.team2.indexOf(discordId);
    if (idx !== -1) match.team2[idx] = replacementDiscordId;
  }

  // Mark original player as subbed out + apply -300 XP penalty
  // automatically. Staff doesn't need to remember to DQ separately.
  // addXp + xp_history wrapped in one db.transaction so the player's
  // xp_points column and the leaderboard's xp_history view can't
  // diverge (rank roles read xp_points, leaderboard sums xp_history).
  player.subType = 'subbed_out';
  const subbedUser = userRepo.findByDiscordId(discordId);
  if (subbedUser) {
    try {
      const dbRef = require('../database/db');
      const { getCurrentSeason } = require('../panels/leaderboardPanel');
      const insertSubXpHistory = dbRef.prepare(
        'INSERT INTO xp_history (user_id, match_id, match_type, xp_amount, season) VALUES (?, ?, ?, ?, ?)'
      );
      const penalizeSubTx = dbRef.transaction((userId) => {
        // addXp floors at 0 — record the actual delta applied so the
        // audit trail matches reality for players already at low XP.
        const actualDelta = userRepo.addXp(userId, -QUEUE_CONFIG.NO_SHOW_PENALTY);
        if (actualDelta !== 0) {
          // match_id NULL — xp_history.match_id has a FK to matches(id),
          // and queue match ids come from a separate sequence in
          // queue_matches. match_type='queue' identifies these rows.
          insertSubXpHistory.run(userId, null, 'queue', actualDelta, getCurrentSeason());
        }
      });
      penalizeSubTx(subbedUser.id);
      console.log(`[QueueService] Applied -${QUEUE_CONFIG.NO_SHOW_PENALTY} XP penalty to subbed-out player ${discordId}`);
    } catch (err) {
      console.error(`[QueueService] Failed to apply sub-out penalty to ${discordId}:`, err.message);
    }
  }

  // Add replacement, remove original
  match.players.set(replacementDiscordId, replacement);
  match.players.delete(discordId);

  // Log to admin feed
  const { postTransaction } = require('../utils/transactionFeed');
  postTransaction({
    type: 'queue_sub',
    memo: `Queue Match #${match.id} sub: <@${discordId}> out (-${QUEUE_CONFIG.NO_SHOW_PENALTY} XP) → <@${replacementDiscordId}> in (${subType})`,
  });

  console.log(`[QueueService] Subbed ${discordId} out for ${replacementDiscordId} (${subType}) in match #${match.id}`);
  return { success: true };
}

module.exports = {
  subPlayerOut,
};
