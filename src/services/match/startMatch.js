// Match start flow — escrow transfer, channel creation, timers.
const matchRepo = require('../../database/repositories/matchRepo');
const challengeRepo = require('../../database/repositories/challengeRepo');
const challengePlayerRepo = require('../../database/repositories/challengePlayerRepo');
const userRepo = require('../../database/repositories/userRepo');
const escrowManager = require('../../base/escrowManager');
const { MATCH_STATUS, CHALLENGE_STATUS, CHALLENGE_TYPE } = require('../../config/constants');
const { createMatchChannels } = require('./createChannels');
const { startNoShowReminders } = require('./cleanup');

/**
 * Create the match DB record (without Discord channels). Returns the
 * match row with an auto-generated `id` that can be used as the on-chain
 * match identifier.
 *
 * @param {object} challenge - The challenge DB record.
 * @returns {object} The created match record (with match.id).
 */
function createMatchRecord(challenge) {
  return matchRepo.create({
    challengeId: challenge.id,
    categoryId: null,
  });
}

/**
 * Start a match -- transfer held funds to escrow and create match channels.
 * Called when all opponent teammates have accepted (team games) or immediately (1v1).
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {number} challengeId - The challenge ID.
 * @returns {Promise<object>} The match record.
 */
async function startMatch(client, challengeId) {
  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    throw new Error(`Challenge ${challengeId} not found`);
  }

  // Atomic claim for the TEAM game path only. The teammateResponse
  // accept handler has an `await interaction.reply` between the
  // `updateStatus(ACCEPTED)` and the `countPendingByChallenge` read,
  // so two concurrent final-teammate accepts can both reach startMatch
  // with challenge.status === ACCEPTED. Without the claim below, both
  // would createMatchRecord (two match rows for one challenge) and
  // both would transferToEscrow (two on-chain createMatch +
  // depositToEscrow cycles, funds double-locked, escrow stuck).
  //
  // The 1v1 path goes OPEN -> IN_PROGRESS inside challengeAccept.js
  // via its own atomic claim, so by the time startMatch runs, status
  // is already IN_PROGRESS and only one caller exists — no extra
  // claim needed here for that path.
  if (challenge.status === CHALLENGE_STATUS.ACCEPTED) {
    const claimed = challengeRepo.atomicStatusTransition(
      challengeId,
      CHALLENGE_STATUS.ACCEPTED,
      CHALLENGE_STATUS.IN_PROGRESS,
    );
    if (!claimed) {
      const fresh = challengeRepo.findById(challengeId);
      console.warn(`[MatchService] startMatch race lost for challenge #${challengeId} (status=${fresh?.status || 'unknown'}) \u2014 skipping duplicate match creation`);
      return null;
    }
  } else if (challenge.status !== CHALLENGE_STATUS.IN_PROGRESS) {
    // Anything other than ACCEPTED (team path) or IN_PROGRESS (1v1
    // path already claimed) is a caller bug — don't start a match on
    // a cancelled / completed / pending challenge.
    console.warn(`[MatchService] startMatch called on challenge #${challengeId} with unexpected status=${challenge.status} \u2014 aborting`);
    return null;
  }

  // Verify all players have accepted
  const allPlayers = challengePlayerRepo.findByChallengeId(challengeId);
  const pendingPlayers = allPlayers.filter(p => p.status !== 'accepted');
  if (pendingPlayers.length > 0) {
    // Revert the team-path claim so another caller can pick it up.
    // For the 1v1 path the status was already IN_PROGRESS before we
    // got here, so revert goes OPEN (the original). But 1v1 always
    // has exactly 2 players both set ACCEPTED before startMatch is
    // called, so this branch only fires on team games that claimed.
    challengeRepo.updateStatus(challengeId, CHALLENGE_STATUS.ACCEPTED);
    throw new Error(`Cannot start match: ${pendingPlayers.length} player(s) have not accepted`);
  }

  // Step 1: Create DB match record to get a match ID for the on-chain call.
  const match = createMatchRecord(challenge);

  // Step 2: Transfer held funds to escrow via smart contract (cash match only).
  if (challenge.type === CHALLENGE_TYPE.CASH_MATCH && Number(challenge.entry_amount_usdc) > 0) {
    try {
      await escrowManager.transferToEscrow(
        match.id,
        challengeId,
        allPlayers.filter(p => p.funds_held),
        challenge.entry_amount_usdc,
        allPlayers.length,
      );
    } catch (err) {
      console.error(`[MatchService] ESCROW FAILURE for match #${match.id}:`, err.message);

      // Cancel on-chain match if any deposits landed
      try {
        const playersWithHolds = allPlayers.filter(p => p.funds_held);
        await escrowManager.cancelOnChainMatch(
          match.id, challengeId, playersWithHolds, challenge.entry_amount_usdc,
        );
        console.log(`[MatchService] On-chain cancel succeeded for match #${match.id} \u2014 partial deposits refunded`);
      } catch (cancelErr) {
        console.error(`[MatchService] On-chain cancel also failed for match #${match.id}: ${cancelErr.message}. If deposits landed on-chain, use scripts/emergency-cancel-match.js to recover.`);
      }

      // Revert DB-held funds
      try {
        escrowManager.refundAll(challengeId);
      } catch (refundErr) {
        console.error(`[MatchService] DB refund after escrow failure also failed:`, refundErr.message);
      }

      challengeRepo.updateStatus(challengeId, CHALLENGE_STATUS.CANCELLED);
      matchRepo.updateStatus(match.id, MATCH_STATUS.CANCELLED);

      const { postTransaction } = require('../../utils/transactionFeed');
      postTransaction({
        type: 'balance_mismatch',
        challengeId,
        memo: `\u{1F6A8} Escrow transfer FAILED for match #${match.id}. On-chain cancel attempted + DB funds refunded. No channels created. Error: ${err.message}`,
      });

      throw new Error(`Escrow transfer failed \u2014 match #${match.id} cancelled`);
    }
  }

  // Step 3: Create Discord channels.
  await createMatchChannels(client, challenge, match.id);

  // challenge.status is already IN_PROGRESS (set by atomic claim above).
  matchRepo.updateStatus(match.id, MATCH_STATUS.ACTIVE);

  // Start inactivity timer
  const timerService = require('../timerService');
  const { getAutoDisputeMs } = require('../../utils/matchTimer');
  const autoDisputeMs = getAutoDisputeMs(challenge.game_modes, challenge.series_length);
  timerService.createTimer('match_inactivity', match.id, autoDisputeMs);
  console.log(`[MatchService] Auto-dispute timer set for match #${match.id}: ${Math.round(autoDisputeMs / 60000)} minutes`);

  const { postTransaction } = require('../../utils/transactionFeed');
  postTransaction({ type: 'match_started', challengeId, memo: `Match #${match.id} started | ${challenge.team_size}v${challenge.team_size} | ${challenge.game_modes} | Bo${challenge.series_length}${challenge.type === 'cash_match' ? ` | Match Prize: $${(Number(challenge.total_pot_usdc) / 1000000).toFixed(2)}` : ' | XP Match'}` });

  // Start no-show reminder pings
  const playerDiscordIds = allPlayers.map(p => {
    const u = userRepo.findById(p.user_id);
    return u?.discord_id;
  }).filter(Boolean);
  startNoShowReminders(client, match, playerDiscordIds);

  console.log(`[MatchService] Match #${match.id} started for challenge #${challengeId}`);
  return match;
}

module.exports = { createMatchRecord, startMatch };
