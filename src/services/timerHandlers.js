const timerService = require('./timerService');
const challengeService = require('./challengeService');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const matchRepo = require('../database/repositories/matchRepo');
const matchService = require('./matchService');
const { CHALLENGE_STATUS, PLAYER_STATUS, MATCH_STATUS } = require('../config/constants');

/**
 * Register all timer handlers for crash recovery.
 * Must be called BEFORE timerService.loadPendingTimers() so that
 * any timers that fire immediately on load have a handler ready.
 *
 * @param {import('discord.js').Client} client - The Discord client (needed for match resolution).
 */
function registerAll(client) {
  // --- challenge_expiry: referenceId is challengeId ---
  timerService.registerHandler('challenge_expiry', async (challengeId) => {
    const challenge = challengeRepo.findById(challengeId);
    if (!challenge) {
      console.warn(`[TimerHandler] challenge_expiry: challenge ${challengeId} not found`);
      return;
    }

    if (challenge.status !== CHALLENGE_STATUS.OPEN) {
      // Already accepted, cancelled, or otherwise handled — nothing to do
      console.log(`[TimerHandler] challenge_expiry: challenge ${challengeId} status is '${challenge.status}', skipping`);
      return;
    }

    // Cancel the challenge (refund held funds, set status)
    await challengeService.cancelChallenge(challengeId);

    // Update to expired rather than cancelled
    challengeRepo.updateStatus(challengeId, CHALLENGE_STATUS.EXPIRED);

    console.log(`[TimerHandler] challenge_expiry: challenge ${challengeId} expired and refunded`);
  });

  // --- teammate_accept: referenceId is challengePlayerId ---
  timerService.registerHandler('teammate_accept', async (challengePlayerId) => {
    const player = challengePlayerRepo.findById(challengePlayerId);
    if (!player) {
      console.warn(`[TimerHandler] teammate_accept: challenge_player ${challengePlayerId} not found`);
      return;
    }

    if (player.status !== PLAYER_STATUS.PENDING) {
      // Already accepted or declined — nothing to do
      console.log(`[TimerHandler] teammate_accept: player ${challengePlayerId} status is '${player.status}', skipping`);
      return;
    }

    // Treat as a decline
    challengePlayerRepo.updateStatus(challengePlayerId, PLAYER_STATUS.DECLINED);
    console.log(`[TimerHandler] teammate_accept: player ${challengePlayerId} timed out, declining`);

    // Cancel the entire challenge
    await challengeService.cancelChallenge(player.challenge_id);

    console.log(`[TimerHandler] teammate_accept: challenge ${player.challenge_id} cancelled due to teammate timeout`);
  });

  // --- match_inactivity: referenceId is matchId ---
  // Fires 24h after match start if no captain reports a result
  timerService.registerHandler('match_inactivity', async (matchId) => {
    const match = matchRepo.findById(matchId);
    if (!match) return;

    // Only auto-dispute if still active (no report has been made)
    if (match.status !== MATCH_STATUS.ACTIVE) {
      console.log(`[TimerHandler] match_inactivity: match ${matchId} status is '${match.status}', skipping`);
      return;
    }

    // Auto-dispute
    matchRepo.updateStatus(matchId, MATCH_STATUS.DISPUTED);
    challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.DISPUTED);

    // Notify in shared channel
    if (match.shared_text_id) {
      try {
        const sharedChannel = client.channels.cache.get(match.shared_text_id);
        if (sharedChannel) {
          const adminRoleId = process.env.ADMIN_ROLE_ID;
          const adminPing = adminRoleId ? `<@&${adminRoleId}>` : 'Admins';
          await sharedChannel.send(
            `**Match #${matchId} has been inactive for 24 hours.** No result was reported.\n\n${adminPing} — please review this match.`
          );
        }
      } catch (err) {
        console.error(`[TimerHandler] match_inactivity: error notifying for match ${matchId}:`, err.message);
      }
    }

    console.log(`[TimerHandler] match_inactivity: match ${matchId} auto-disputed after 24h inactivity`);
  });
}

module.exports = { registerAll };
