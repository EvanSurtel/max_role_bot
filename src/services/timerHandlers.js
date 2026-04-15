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

  // --- dispute_hold_release: referenceId is userId ---
  // Fires 36 hours after a dispute-resolved match pays out. Moves funds
  // from the user's pending_balance to their wallet balance_available.
  timerService.registerHandler('dispute_hold_release', async (userId) => {
    const walletRepo = require('../database/repositories/walletRepo');
    const transactionRepo = require('../database/repositories/transactionRepo');
    const { TRANSACTION_TYPE } = require('../config/constants');

    try {
      const released = walletRepo.releasePending(userId);
      if (BigInt(released) > 0n) {
        transactionRepo.create({
          type: TRANSACTION_TYPE.DISPUTE_HOLD_CREDIT,
          userId,
          challengeId: null,
          amountUsdc: released,
          txHash: null,
          status: 'completed',
          memo: `Dispute hold released — ${released} moved to available`,
        });
        console.log(`[TimerHandler] dispute_hold_release: released ${released} for user ${userId}`);
      } else {
        console.log(`[TimerHandler] dispute_hold_release: no pending balance for user ${userId}`);
      }
    } catch (err) {
      console.error(`[TimerHandler] dispute_hold_release failed for user ${userId}:`, err.message);
    }
  });

  // --- match_inactivity: referenceId is matchId ---
  // Fires after estimated match duration + buffer if no result reported
  timerService.registerHandler('match_inactivity', async (matchId) => {
    const match = matchRepo.findById(matchId);
    if (!match) return;

    // Only auto-dispute if still active or voting (no final result)
    if (match.status !== MATCH_STATUS.ACTIVE && match.status !== MATCH_STATUS.VOTING) {
      console.log(`[TimerHandler] match_inactivity: match ${matchId} status is '${match.status}', skipping`);
      return;
    }

    // Auto-dispute via matchResult's triggerDispute
    const { triggerDispute } = require('../interactions/matchResult');
    await triggerDispute(client, matchId);

    // Notify in shared channel
    if (match.shared_text_id) {
      try {
        const sharedChannel = client.channels.cache.get(match.shared_text_id);
        if (sharedChannel) {
          const staffRoleId = process.env.WAGER_STAFF_ROLE_ID;
          const adminRoleId = process.env.ADMIN_ROLE_ID;
          const ownerRoleId = process.env.OWNER_ROLE_ID;
          const ceoRoleId = process.env.CEO_ROLE_ID;
          const adsRoleId = process.env.ADS_ROLE_ID;
          const pings = [];
          if (staffRoleId) pings.push(`<@&${staffRoleId}>`);
          if (adminRoleId) pings.push(`<@&${adminRoleId}>`);
          if (ownerRoleId) pings.push(`<@&${ownerRoleId}>`);
          if (ceoRoleId) pings.push(`<@&${ceoRoleId}>`);
          if (adsRoleId) pings.push(`<@&${adsRoleId}>`);
          await sharedChannel.send(
            `**Match #${matchId} timed out.** No result was reported in time.\n\n${pings.join(' ')} — please review this match.`
          );
        }
      } catch (err) {
        console.error(`[TimerHandler] match_inactivity: error notifying for match ${matchId}:`, err.message);
      }
    }

    console.log(`[TimerHandler] match_inactivity: match ${matchId} auto-disputed after timeout`);
  });
}

module.exports = { registerAll };
