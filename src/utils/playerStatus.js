const db = require('../database/db');

/**
 * Check if a user is currently busy (in an active challenge or match).
 * A player is "busy" if they are:
 * - In a challenge with status: pending_teammates, open, accepted, in_progress
 * - In a match with status: active or voting WHERE their captain hasn't voted yet
 *
 * Once their captain has voted, they are FREE to join other things.
 *
 * @param {number} userId - Internal user ID
 * @returns {{ busy: boolean, reason: string|null }}
 */
function isPlayerBusy(userId) {
  // Check if in a forming challenge (pending_teammates, open, accepted)
  const formingChallenge = db.prepare(`
    SELECT c.id, c.status FROM challenges c
    JOIN challenge_players cp ON cp.challenge_id = c.id
    WHERE cp.user_id = ? AND c.status IN ('pending_teammates', 'open', 'accepted')
    LIMIT 1
  `).get(userId);

  if (formingChallenge) {
    return { busy: true, reason: `You are already in Challenge #${formingChallenge.id} (${formingChallenge.status}). Cancel or wait for it to finish.` };
  }

  // Check if in an active match where their captain hasn't voted
  const activeMatch = db.prepare(`
    SELECT m.id, m.status, m.captain1_vote, m.captain2_vote, cp.team
    FROM matches m
    JOIN challenges c ON m.challenge_id = c.id
    JOIN challenge_players cp ON cp.challenge_id = c.id
    WHERE cp.user_id = ? AND m.status IN ('active', 'voting')
    LIMIT 1
  `).get(userId);

  if (activeMatch) {
    // Check if their team's captain has voted — if so, they're free
    const captainVoted = activeMatch.team === 1
      ? activeMatch.captain1_vote !== null
      : activeMatch.captain2_vote !== null;

    if (!captainVoted) {
      return { busy: true, reason: `You are in an active Match #${activeMatch.id}. Your captain must report the result first.` };
    }
    // Captain voted — player is free to join other things
  }

  return { busy: false, reason: null };
}

module.exports = { isPlayerBusy };
