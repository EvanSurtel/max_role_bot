// Sub player in/out logic — staff-only substitution management.
//
// Depends on state.js for match lookup and helpers.js for the _newPlayer
// factory. Used by interactions.js when staff triggers a sub via buttons.

const userRepo = require('../database/repositories/userRepo');
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

  // Mark original player as subbed out
  player.subType = 'subbed_out';

  // Add replacement, remove original
  match.players.set(replacementDiscordId, replacement);
  match.players.delete(discordId);

  console.log(`[QueueService] Subbed ${discordId} out for ${replacementDiscordId} (${subType}) in match #${match.id}`);
  return { success: true };
}

module.exports = {
  subPlayerOut,
};
