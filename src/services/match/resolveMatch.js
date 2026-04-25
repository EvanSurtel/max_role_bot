// Match resolution — XP, stats, payouts, nickname sync, result posting.
const { EmbedBuilder, ActionRowBuilder } = require('discord.js');
const matchRepo = require('../../database/repositories/matchRepo');
const challengeRepo = require('../../database/repositories/challengeRepo');
const challengePlayerRepo = require('../../database/repositories/challengePlayerRepo');
const userRepo = require('../../database/repositories/userRepo');
const escrowManager = require('../../base/escrowManager');
const { formatUsdc } = require('../../utils/embeds');
const { MATCH_STATUS, CHALLENGE_STATUS, CHALLENGE_TYPE, PLAYER_ROLE, GAME_MODES } = require('../../config/constants');
const { t } = require('../../locales/i18n');
const { buildLanguageDropdownRow } = require('../../utils/languageButtonHelper');
const { captainLang, postResultToChannels, awardStats } = require('./helpers');
// cleanupChannels is invoked from the DB-backed `match_cleanup` timer
// handler in src/services/timerHandlers.js — no longer needed here.

/**
 * Resolve a match after captain voting.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {number} matchId - The match ID.
 * @param {number} winningTeam - The winning team number (1 or 2).
 * @param {object} [opts]
 * @param {boolean} [opts.fromDispute=false] - Whether resolved from dispute.
 */
async function resolveMatch(client, matchId, winningTeam, { fromDispute = false } = {}) {
  const match = matchRepo.findById(matchId);
  if (!match) {
    throw new Error(`Match ${matchId} not found`);
  }

  // Atomic idempotency claim -- prevents double-resolve races.
  const LIVE_STATUSES = [MATCH_STATUS.ACTIVE, MATCH_STATUS.VOTING, MATCH_STATUS.DISPUTED];
  if (!LIVE_STATUSES.includes(match.status)) {
    console.warn(`[MatchService] resolveMatch called on match #${matchId} with status=${match.status} \u2014 skipping`);
    return;
  }
  const claimed = matchRepo.atomicStatusTransition(matchId, LIVE_STATUSES, MATCH_STATUS.COMPLETED);
  if (!claimed) {
    console.warn(`[MatchService] resolveMatch race lost on match #${matchId} \u2014 another caller already claimed it`);
    return;
  }

  const challenge = challengeRepo.findById(match.challenge_id);
  if (!challenge) {
    throw new Error(`Challenge ${match.challenge_id} not found for match ${matchId}`);
  }

  const winningPlayers = challengePlayerRepo.findByChallengeAndTeam(match.challenge_id, winningTeam);
  const winnerUserIds = winningPlayers.map(p => p.user_id);

  // Disburse winnings (cash match only)
  if (challenge.type === CHALLENGE_TYPE.CASH_MATCH && Number(challenge.total_pot_usdc) > 0) {
    // Three outcomes worth distinguishing:
    //   onchainSucceeded \u2014 disburseResult.hash is set (or escrowStuck
    //                      from a post_submit error). Winners were
    //                      paid (or may have been). DO NOT revert
    //                      match status \u2014 re-resolve would cause
    //                      contract.resolveMatch to revert (already
    //                      paid) and double-pay risk if any retry
    //                      path succeeds.
    //   partialDbFailure \u2014 on-chain hash exists, but creditAvailable
    //                      threw for one or more winners. Pending
    //                      rows kept; deposit poller reconciles. Match
    //                      stays COMPLETED. Admin alerted by escrowMgr.
    //   onchainFailed \u2014 pre_submit error from the bundler. No funds
    //                   moved on-chain. Revert match to DISPUTED so an
    //                   admin can re-resolve cleanly.
    let disburseResult = null;
    let onchainSucceeded = false;
    let onchainFailed = false;
    let disburseError = null;
    try {
      disburseResult = await escrowManager.disburseWinnings(
        matchId, match.challenge_id, winnerUserIds, challenge.total_pot_usdc, { fromDispute },
      );
      // No throw: on-chain resolveMatch landed (disburseResult.hash set).
      onchainSucceeded = true;
      const failedPayouts = (disburseResult.disbursements || []).filter(d => d.error);
      if (failedPayouts.length > 0) {
        disburseError = failedPayouts.map(d => `user ${d.userId}: ${d.error}`).join('; ');
        console.warn(`[MatchService] Match #${matchId}: on-chain payout landed but ${failedPayouts.length} DB credits failed \u2014 poller will reconcile. ${disburseError}`);
      } else {
        console.log(`[MatchService] Winnings disbursed for match #${matchId}, team ${winningTeam} won`);
      }
    } catch (err) {
      disburseError = err.message;
      if (err.escrowStuck) {
        // post_submit: UserOp landed but confirmation unknown. Funds
        // may already be on-chain. Treat exactly like onchainSucceeded
        // for status purposes \u2014 we MUST NOT revert to DISPUTED, since
        // an admin re-resolve would race a confirming UserOp and risk
        // double-payment. escrowManager already posted a loud admin
        // alert with the userOpHash so operators can verify on BaseScan.
        onchainSucceeded = true;
        console.error(`[MatchService] Match #${matchId} disburseWinnings post_submit (escrowStuck=true). Status stays COMPLETED. Operator must verify on-chain via the alert posted by escrowManager.`);
      } else {
        onchainFailed = true;
        console.error(`[MatchService] Failed to disburse winnings for match #${matchId} (pre_submit, no on-chain change):`, err.message);
      }
    }

    if (onchainFailed) {
      matchRepo.atomicStatusTransition(matchId, MATCH_STATUS.COMPLETED, MATCH_STATUS.DISPUTED);
      const { postTransaction } = require('../../utils/transactionFeed');
      postTransaction({
        type: 'balance_mismatch',
        challengeId: match.challenge_id,
        memo: `\u{1F6A8} Disbursement failed BEFORE on-chain submit for match #${matchId} \u2014 status reverted to DISPUTED. Funds still in escrow. Admin can safely re-resolve. Error: ${disburseError}`,
      });
      console.error(`[MatchService] CRITICAL: disbursement failed pre_submit for match #${matchId}, status reverted. Admin can safely re-resolve.`);
      return;
    }
    // onchainSucceeded \u2014 fall through to mark winner + complete.

    // Note: dispute-resolved matches pay out instantly (same path as
    // normal match resolutions). The `fromDispute` flag is kept only
    // for transaction-feed labeling and the admin-action audit log.
    // The 36-hour hold that existed pre-refactor was removed — it
    // added friction for winners without meaningful safety since the
    // sole operator is the one making the dispute call in the first
    // place.
  }

  // Set winner
  matchRepo.setWinner(matchId, winningTeam);
  challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.COMPLETED);

  // Award XP and track stats
  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  const losingTeam = winningTeam === 1 ? 2 : 1;
  const losingPlayers = allPlayers.filter(p => p.team === losingTeam);
  const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH && Number(challenge.total_pot_usdc) > 0;

  // Award XP, stats, and earnings to all players
  const { winXp, loseXp, perPlayerEarnings } = awardStats({
    matchId, challenge, winningPlayers, losingPlayers, isCashMatch,
  });

  match._winXp = winXp;
  match._loseXp = loseXp;

  // Update Discord nicknames before posting result
  const { updateNicknames } = require('../../utils/nicknameUpdater');
  const allPlayerIds = allPlayers.map(p => p.user_id);
  try {
    await updateNicknames(client, allPlayerIds);
  } catch (err) {
    console.error(`[MatchService] Nickname pre-result update failed:`, err.message);
  }

  // Log resolution to admin feed
  const { postTransaction: postTx } = require('../../utils/transactionFeed');
  const winnerNames = winningPlayers.map(p => { const u = userRepo.findById(p.user_id); return u?.server_username || '?'; }).join(', ');
  const loserNames = losingPlayers.map(p => { const u = userRepo.findById(p.user_id); return u?.server_username || '?'; }).join(', ');
  const isCashMatch2 = challenge.type === CHALLENGE_TYPE.CASH_MATCH && Number(challenge.total_pot_usdc) > 0;
  postTx({ type: 'match_resolved', challengeId: match.challenge_id, memo: `Match #${matchId} | Team ${winningTeam} wins\nWinners: ${winnerNames} (+${winXp} XP${isCashMatch2 ? `, +$${(Number(perPlayerEarnings) / 1000000).toFixed(2)} each` : ''})\nLosers: ${loserNames} (${loseXp > 0 ? `-${loseXp} XP` : '0 XP'})` });

  for (const player of winningPlayers) {
    const u = userRepo.findById(player.user_id);
    if (u) postTx({ type: 'xp_awarded', username: u.server_username, discordId: u.discord_id, challengeId: match.challenge_id, memo: `+${winXp} XP (win) | Total: ${u.xp_points} XP` });
  }
  for (const player of losingPlayers) {
    if (loseXp > 0) {
      const u = userRepo.findById(player.user_id);
      if (u) postTx({ type: 'xp_awarded', username: u.server_username, discordId: u.discord_id, challengeId: match.challenge_id, memo: `-${loseXp} XP (loss) | Total: ${u.xp_points} XP` });
    }
  }

  // Send result message in shared channel AND vote channel.
  //
  // Captains report from the vote channel — if we only post to
  // shared-chat they're left staring at "Resolving match..." with no
  // visible follow-up in the channel they're actually looking at.
  // Posting to both is cheap and the right UX: captains see closure
  // where they clicked, all players see it in shared-chat.
  const isCashMatchResult = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
  const allCaptains = allPlayers.filter(p => p.role === PLAYER_ROLE.CAPTAIN);
  const captainDiscordIdsForLang = allCaptains.map(p => {
    const u = userRepo.findById(p.user_id);
    return u ? u.discord_id : null;
  }).filter(Boolean);
  const sharedLang = captainLang(captainDiscordIdsForLang);
  const prizeAmount = (Number(challenge.total_pot_usdc) / 1_000_000).toFixed(2);
  const prizeText = isCashMatchResult
    ? t('match_channel.result_match_prize_distributed', sharedLang, { amount: prizeAmount })
    : '';
  const resultLangRow = buildLanguageDropdownRow(sharedLang);
  const resultPayload = {
    content: [
      t('match_channel.result_complete', sharedLang, { matchId }),
      '', t('match_channel.result_winner', sharedLang, { team: winningTeam }),
      prizeText, '', t('match_channel.result_cleanup', sharedLang),
    ].join('\n'),
    components: [...resultLangRow],
  };

  for (const channelId of [match.shared_text_id, match.voting_channel_id]) {
    if (!channelId) continue;
    try {
      let ch = client.channels.cache.get(channelId);
      if (!ch) {
        try { ch = await client.channels.fetch(channelId); } catch { ch = null; }
      }
      if (ch) await ch.send(resultPayload);
      else console.error(`[MatchService] result channel ${channelId} unreachable for match #${matchId}`);
    } catch (err) {
      console.error(`[MatchService] Failed to send result message to ${channelId} for match #${matchId}:`, err.message);
    }
  }

  // Build result embed
  const modeInfo = GAME_MODES[challenge.game_modes];
  const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;
  const matchPrize = Number(challenge.total_pot_usdc);
  const entryAmount = Number(challenge.entry_amount_usdc);
  const perPlayerPayout = matchPrize > 0 ? matchPrize / winningPlayers.length : 0;
  const perPlayerProfit = perPlayerPayout - entryAmount;
  const displayWinXp = match._winXp || winXp;
  const displayLoseXp = match._loseXp || loseXp;
  const matchTypeLabel = isCashMatch ? 'Cash Match' : 'XP Match';

  const winnerLines = [];
  for (const p of winningPlayers) {
    const u = userRepo.findById(p.user_id);
    if (!u) continue;
    const ign = u.cod_ign ? `(${u.cod_ign})` : '';
    const moneyText = isCashMatch ? `**+${formatUsdc(perPlayerProfit)} USDC** ` : '';
    winnerLines.push(`<@${u.discord_id}> ${ign} \u2014 ${moneyText}+${displayWinXp} XP`);
  }
  const loserLines = [];
  for (const p of losingPlayers) {
    const u = userRepo.findById(p.user_id);
    if (!u) continue;
    const ign = u.cod_ign ? `(${u.cod_ign})` : '';
    const moneyText = isCashMatch ? `**-${formatUsdc(entryAmount)} USDC** ` : '';
    const xpText = displayLoseXp > 0 ? `-${displayLoseXp} XP` : '';
    loserLines.push(`<@${u.discord_id}> ${ign} \u2014 ${moneyText}${xpText}`);
  }

  const titleLine = isCashMatch
    ? `**Team ${winningTeam} wins! Match Prize: ${formatUsdc(matchPrize)} USDC**`
    : `**Team ${winningTeam} wins!**`;

  const resultEmbed = new EmbedBuilder()
    .setTitle(`${matchTypeLabel} #${matchId} \u2014 Result`)
    .setColor(isCashMatch ? 0xf1c40f : 0x3498db)
    .setDescription([titleLine, '', '**Winners**', ...winnerLines, '', '**Losers**', ...loserLines].join('\n'))
    .addFields(
      { name: 'Mode', value: modeLabel, inline: true },
      { name: 'Series', value: `Best of ${challenge.series_length}`, inline: true },
      { name: 'Team Size', value: `${challenge.team_size}v${challenge.team_size}`, inline: true },
    )
    .setTimestamp();

  if (isCashMatch) {
    resultEmbed.addFields({ name: 'Entry', value: `${formatUsdc(entryAmount)} per player`, inline: true });
  }

  const { buildResultLanguageDropdown } = require('../../interactions/perMessageLanguage');
  const { getBotDisplayLanguage } = require('../../utils/languageRefresh');
  const resultDisplayLang = getBotDisplayLanguage();
  const langRow = buildResultLanguageDropdown(matchId, resultDisplayLang);

  await postResultToChannels(client, resultEmbed, [langRow], isCashMatch, matchId);

  // Sync rank roles
  const { syncRanks } = require('../../utils/rankRoleSync');
  syncRanks(client, allPlayerIds).catch(err => {
    console.error(`[MatchService] Rank role sync failed:`, err.message);
  });

  // DB-backed cleanup timer (handler in timerHandlers.js calls
  // cleanupChannels). Replaces a bare setTimeout that was lost on
  // bot restart, leaking the match category + 7 channels per
  // restart and would hit Discord's 500-channel-per-guild cap.
  // 120s gives users time to read the result + use the language
  // dropdown + lets the dispute-result archiver finish reading
  // shared_text_id before it's deleted.
  const timerService = require('../timerService');
  timerService.createTimer('match_cleanup', matchId, 120_000);

  console.log(`[MatchService] Match #${matchId} resolved. Team ${winningTeam} wins.`);
}

module.exports = { resolveMatch };
