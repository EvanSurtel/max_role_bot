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
    // cancelChallenge() internally uses atomicStatusTransition and
    // skips if the challenge moved past a cancellable state between
    // the check above and this call (e.g. an acceptor completed the
    // accept flow during the `await`).
    await challengeService.cancelChallenge(challengeId, client);

    // Only flip to EXPIRED if cancelChallenge actually set CANCELLED.
    // Using atomicStatusTransition means a concurrent accept → ACCEPTED
    // → IN_PROGRESS transition between the read above and now will not
    // be clobbered with EXPIRED (which would orphan an in-flight match
    // by making its challenge row unresolvable).
    const expired = challengeRepo.atomicStatusTransition(
      challengeId,
      CHALLENGE_STATUS.CANCELLED,
      CHALLENGE_STATUS.EXPIRED,
    );
    if (expired) {
      console.log(`[TimerHandler] challenge_expiry: challenge ${challengeId} expired and refunded`);
    } else {
      const fresh = challengeRepo.findById(challengeId);
      console.log(
        `[TimerHandler] challenge_expiry: challenge ${challengeId} was not in CANCELLED ` +
        `when EXPIRED flip attempted (status=${fresh?.status}) — skipped to avoid clobbering.`,
      );
    }
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

    // Atomic PENDING → DECLINED flip. The read above + a bare
    // updateStatus below would race against a concurrent accept that
    // lands between the two: the handler could overwrite ACCEPTED
    // with DECLINED, silently yanking a player out of an accepted
    // challenge. The conditional UPDATE (declineIfPending) only flips
    // if the row is still PENDING; if a concurrent accept won, we
    // exit without writing.
    const db = require('../database/db');
    const result = db.prepare(
      "UPDATE challenge_players SET status = ? WHERE id = ? AND status = 'pending'"
    ).run(PLAYER_STATUS.DECLINED, challengePlayerId);
    if (result.changes === 0) {
      console.log(
        `[TimerHandler] teammate_accept: player ${challengePlayerId} was no longer PENDING when decline attempted — skipped.`,
      );
      return;
    }
    console.log(`[TimerHandler] teammate_accept: player ${challengePlayerId} timed out, declining`);

    // Cancel the entire challenge (+ invite channel cleanup)
    await challengeService.cancelChallenge(player.challenge_id, client);

    console.log(`[TimerHandler] teammate_accept: challenge ${player.challenge_id} cancelled due to teammate timeout`);
  });

  // Dispute resolutions pay out instantly (via the normal
  // disburseWinnings path); no dispute-specific timer handler exists
  // anymore. If old `dispute_resolution_finalize` or `dispute_hold_release`
  // timer rows are still present in a pre-migration DB, timerService
  // will log a warning and move on (no-op).

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
