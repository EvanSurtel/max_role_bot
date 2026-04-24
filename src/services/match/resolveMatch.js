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
const { cleanupChannels } = require('./cleanup');

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
    let disburseFailed = false;
    let disburseError = null;
    let disburseResult = null;
    try {
      disburseResult = await escrowManager.disburseWinnings(
        matchId, match.challenge_id, winnerUserIds, challenge.total_pot_usdc, { fromDispute },
      );
      const failedPayouts = (disburseResult.disbursements || []).filter(d => d.error);
      const successPayouts = (disburseResult.disbursements || []).filter(d => d.hash || d.signature);
      if (failedPayouts.length > 0 || successPayouts.length < winnerUserIds.length) {
        disburseFailed = true;
        disburseError = failedPayouts.length > 0
          ? failedPayouts.map(d => `user ${d.userId}: ${d.error}`).join('; ')
          : `only ${successPayouts.length}/${winnerUserIds.length} winners paid`;
      } else {
        console.log(`[MatchService] Winnings disbursed for match #${matchId}, team ${winningTeam} won`);
      }
    } catch (err) {
      disburseFailed = true;
      disburseError = err.message;
      console.error(`[MatchService] Failed to disburse winnings for match #${matchId}:`, err.message);
    }

    if (disburseFailed) {
      matchRepo.atomicStatusTransition(matchId, MATCH_STATUS.COMPLETED, MATCH_STATUS.DISPUTED);
      const { postTransaction } = require('../../utils/transactionFeed');
      postTransaction({
        type: 'balance_mismatch',
        challengeId: match.challenge_id,
        memo: `\u{1F6A8} Disbursement FAILED for match #${matchId} \u2014 status reverted to DISPUTED. Escrow may have stranded funds. Error: ${disburseError}`,
      });
      console.error(`[MatchService] CRITICAL: disbursement failed for match #${matchId}, status reverted. Admin action required.`);
      return;
    }

    // Dispute flow: on-chain resolveMatch was deferred to a 36-hour
    // timer. disburseWinnings() returned `pendingId` pointing at the
    // dispute_pending_resolutions row; schedule the finalize timer
    // against it. USDC stays in the escrow contract until the timer
    // fires — the winner can't withdraw early because the funds
    // aren't in their wallet yet.
    if (fromDispute && disburseResult?.pendingId) {
      const timerService = require('../timerService');
      const { TIMERS } = require('../../config/constants');
      timerService.createTimer(
        'dispute_resolution_finalize',
        disburseResult.pendingId,
        TIMERS.DISPUTE_HOLD,
      );
      console.log(
        `[MatchService] Dispute resolution #${disburseResult.pendingId} scheduled for finalize in 36h. ` +
        `Funds remain in escrow contract. Releases to ${winnerUserIds.length} winner(s).`,
      );
    }
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

  // Send result message in shared channel
  if (match.shared_text_id) {
    try {
      const sharedChannel = client.channels.cache.get(match.shared_text_id);
      if (sharedChannel) {
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
        await sharedChannel.send({
          content: [
            t('match_channel.result_complete', sharedLang, { matchId }),
            '', t('match_channel.result_winner', sharedLang, { team: winningTeam }),
            prizeText, '', t('match_channel.result_cleanup', sharedLang),
          ].join('\n'),
          components: [...resultLangRow],
        });
      }
    } catch (err) {
      console.error(`[MatchService] Failed to send result message for match #${matchId}:`, err.message);
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

  // Schedule channel cleanup after 5 minutes
  setTimeout(() => {
    cleanupChannels(client, matchId).catch(err => {
      console.error(`[MatchService] Error during scheduled cleanup for match #${matchId}:`, err.message);
    });
  }, 5 * 60 * 1000);

  console.log(`[MatchService] Match #${matchId} resolved. Team ${winningTeam} wins.`);
}

module.exports = { resolveMatch };
