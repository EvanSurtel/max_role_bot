// Check if a player is busy (in active challenge/match/queue).
//
// Cross-checks BOTH the DB-backed wager/XP system AND the in-memory
// queue system so a player can never be in two things at once.
const db = require('../database/db');

/**
 * Check if a user is currently busy (in an active challenge, match, or queue).
 * A player is "busy" if they are:
 * - In a challenge with status: pending_teammates, open, accepted, in_progress
 * - In a match with status: active or voting WHERE their captain hasn't voted yet
 * - In the ranked queue (waiting for a match to form)
 * - In an active queue match (any phase before RESOLVED/CANCELLED)
 *
 * Once their captain has voted (wager/XP match) or their queue match has
 * resolved, they are FREE to join other things.
 *
 * @param {number} userId - Internal user ID
 * @param {string} [discordId] - Discord ID (needed for queue check — pass if available)
 * @returns {{ busy: boolean, reason: string|null }}
 */
function isPlayerBusy(userId, discordId) {
  // Queue system check (in-memory) — must come first because queue
  // state is not in the DB. Requires discordId since the queue is
  // keyed by Discord ID, not internal user ID.
  if (discordId) {
    try {
      const { isInQueue, isInActiveMatch } = require('../queue/state');
      if (isInQueue(discordId)) {
        return { busy: true, reason: 'You are currently in the ranked queue. Leave the queue first.' };
      }
      const queueMatchId = isInActiveMatch(discordId);
      if (queueMatchId) {
        return { busy: true, reason: `You are in an active queue match (#${queueMatchId}). Finish that match first.` };
      }
    } catch { /* queue module not loaded yet — skip */ }
  }
  // Check if in a forming challenge (pending_teammates, open, accepted)
  const formingChallenge = db.prepare(`
    SELECT c.id, c.status, c.type, c.display_number FROM challenges c
    JOIN challenge_players cp ON cp.challenge_id = c.id
    WHERE cp.user_id = ? AND c.status IN ('pending_teammates', 'open', 'accepted')
    LIMIT 1
  `).get(userId);

  if (formingChallenge) {
    const label = formingChallenge.type === 'cash_match' ? 'Cash Match' : 'XP Match';
    const num = formingChallenge.display_number || formingChallenge.id;
    return { busy: true, reason: `You are already in ${label} #${num} (${formingChallenge.status}). Cancel or wait for it to finish.` };
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
