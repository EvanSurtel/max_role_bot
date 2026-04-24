// Timer event handlers — challenge expiry, teammate timeout, dispute hold
// release, match inactivity.
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

    // Cancel the challenge (refund held funds, set status, clean up
    // any invite channels left over from DMs-disabled teammates).
    await challengeService.cancelChallenge(challengeId, client);

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

    // Cancel the entire challenge (+ invite channel cleanup)
    await challengeService.cancelChallenge(player.challenge_id, client);

    console.log(`[TimerHandler] teammate_accept: challenge ${player.challenge_id} cancelled due to teammate timeout`);
  });

  // --- dispute_resolution_finalize: referenceId is dispute_pending_resolutions.id ---
  // Fires 36 hours after a dispute-resolved match was scheduled. Calls
  // on-chain WagerEscrow.resolveMatch — transferring USDC from the
  // escrow contract to the winners' own Smart Wallets — and zeroes
  // each winner's users.pending_balance. Before this timer fires the
  // funds sit in the escrow contract, so a disputed winner cannot
  // front-run the admin-review window by withdrawing early. See
  // audit C1 (commit log) for the full rationale.
  //
  // Safe to re-fire (e.g. after a bot restart mid-hold): the handler
  // is idempotent via dispute_pending_resolutions.status.
  timerService.registerHandler('dispute_resolution_finalize', async (pendingId) => {
    const escrowManager = require('../base/escrowManager');
    try {
      await escrowManager.finalizeDisputedDisbursement(pendingId);
    } catch (err) {
      console.error(`[TimerHandler] dispute_resolution_finalize failed for row ${pendingId}:`, err.message);
      const alertChannelId = process.env.ADMIN_ALERTS_CHANNEL_ID;
      if (alertChannelId) {
        try {
          const ch = client?.channels?.cache?.get(alertChannelId);
          if (ch) {
            await ch.send({
              content:
                `🚨 **Dispute resolution finalize failed** — pending id ${pendingId}.\n` +
                `Error: ${err.message}\n` +
                `Admin action: check dispute_pending_resolutions row; funds still in escrow contract.`,
            });
          }
        } catch { /* best effort */ }
      }
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
