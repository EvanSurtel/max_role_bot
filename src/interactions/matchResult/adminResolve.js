// Admin resolve buttons — Team 1/2 wins, No Winner, go back.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const matchRepo = require('../../database/repositories/matchRepo');
const challengeRepo = require('../../database/repositories/challengeRepo');
const challengePlayerRepo = require('../../database/repositories/challengePlayerRepo');
const userRepo = require('../../database/repositories/userRepo');
const matchService = require('../../services/matchService');
const { MATCH_STATUS, CHALLENGE_STATUS } = require('../../config/constants');
const { t, langFor } = require('../../locales/i18n');
const { canResolveDisputes } = require('./helpers');
const { postDisputeResult } = require('./disputeResult');

/**
 * Handle admin resolve button — show confirmation with team rosters.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAdminResolve(interaction) {
  const id = interaction.customId;
  const lang = langFor(interaction);

  if (!canResolveDisputes(interaction.member)) {
    return interaction.reply({ content: t('admin_resolve.only_admins', lang), ephemeral: true });
  }

  let winningTeam, matchId;
  if (id.startsWith('admin_resolve_nowinner_')) {
    winningTeam = 0;
    matchId = parseInt(id.replace('admin_resolve_nowinner_', ''), 10);
  } else if (id.startsWith('admin_resolve_team1_')) {
    winningTeam = 1;
    matchId = parseInt(id.replace('admin_resolve_team1_', ''), 10);
  } else {
    winningTeam = 2;
    matchId = parseInt(id.replace('admin_resolve_team2_', ''), 10);
  }

  if (isNaN(matchId)) return interaction.reply({ content: t('match_result.invalid_match', lang), ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match || match.status !== MATCH_STATUS.DISPUTED) {
    return interaction.reply({ content: t('admin_resolve.not_disputed', lang), ephemeral: true });
  }

  const challenge = challengeRepo.findById(match.challenge_id);
  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);

  if (winningTeam === 0) {
    // No Winner confirmation
    const isCashMatch = challenge && Number(challenge.total_pot_usdc) > 0;
    const entryAmount = isCashMatch ? (Number(challenge.entry_amount_usdc) / 1_000_000).toFixed(2) : '0';
    const refundText = isCashMatch
      ? t('admin_resolve.refund_text_cash_match', lang, { amount: entryAmount })
      : t('admin_resolve.refund_text_xp', lang);

    const confirmEmbed = new EmbedBuilder()
      .setTitle(t('admin_resolve.confirm_no_winner_title', lang))
      .setColor(0x95a5a6)
      .setDescription(t('admin_resolve.confirm_no_winner_desc', lang, { matchId, refund_text: refundText }));

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin_confirm_nowinner_${matchId}`).setLabel(t('admin_resolve.btn_confirm_no_winner', lang)).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`admin_goback_${matchId}`).setLabel(t('common.go_back', lang)).setStyle(ButtonStyle.Primary),
    );

    return interaction.update({ embeds: [confirmEmbed], components: [row] });
  }

  const losingTeam = winningTeam === 1 ? 2 : 1;
  const winnerNames = allPlayers.filter(p => p.team === winningTeam).map(p => {
    const u = userRepo.findById(p.user_id);
    return u ? `<@${u.discord_id}> ${u.cod_ign ? `(${u.cod_ign})` : ''}` : 'Unknown';
  });
  const loserNames = allPlayers.filter(p => p.team === losingTeam).map(p => {
    const u = userRepo.findById(p.user_id);
    return u ? `<@${u.discord_id}> ${u.cod_ign ? `(${u.cod_ign})` : ''}` : 'Unknown';
  });

  const prizeAmount = challenge && Number(challenge.total_pot_usdc) > 0
    ? (Number(challenge.total_pot_usdc) / 1_000_000).toFixed(2)
    : null;
  const prizeText = prizeAmount
    ? '\n\n' + t('admin_resolve.match_prize_will_be_paid', lang, { amount: prizeAmount })
    : '';

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('admin_resolve.confirm_team_title', lang))
    .setColor(0xe74c3c)
    .setDescription([
      t('admin_resolve.confirm_team_desc', lang, { team: winningTeam }),
      '', t('admin_resolve.winners_team', lang, { team: winningTeam }), ...winnerNames,
      '', t('admin_resolve.losers_team', lang, { team: losingTeam }), ...loserNames,
      prizeText, '', t('admin_resolve.cannot_be_undone', lang),
    ].join('\n'));

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_confirm_${matchId}_${winningTeam}`).setLabel(t('admin_resolve.btn_confirm_team_wins', lang, { team: winningTeam })).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`admin_goback_${matchId}`).setLabel(t('common.go_back', lang)).setStyle(ButtonStyle.Secondary),
  );

  return interaction.update({ embeds: [confirmEmbed], components: [row] });
}

/**
 * Handle admin confirm — resolve the match with the chosen winner.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAdminConfirm(interaction) {
  const lang = langFor(interaction);
  const parts = interaction.customId.replace('admin_confirm_', '').split('_');
  const matchId = parseInt(parts[0], 10);
  const winningTeam = parseInt(parts[1], 10);

  if (!canResolveDisputes(interaction.member)) {
    return interaction.reply({ content: t('admin_resolve.only_admins', lang), ephemeral: true });
  }

  const { logAdminAction } = require('../../utils/adminAudit');
  logAdminAction(interaction.user.id, 'resolve_dispute', 'match', matchId, { winningTeam });

  await interaction.update({
    content: t('admin_resolve.resolved_msg', lang, { user: `<@${interaction.user.id}>`, team: winningTeam }),
    embeds: [], components: [],
  });

  try {
    await matchService.resolveMatch(interaction.client, matchId, winningTeam, { fromDispute: true });

    await postDisputeResult(interaction.client, matchId, winningTeam, interaction.user.id);

    setTimeout(() => {
      matchService.cleanupChannels(interaction.client, matchId).catch(() => {});
    }, 30000);
  } catch (err) {
    console.error(`[MatchResult] Admin resolve failed for match #${matchId}:`, err);
  }
}

/**
 * Handle admin confirm no winner — refund all funds.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAdminConfirmNoWinner(interaction) {
  const lang = langFor(interaction);
  const matchId = parseInt(interaction.customId.replace('admin_confirm_nowinner_', ''), 10);

  if (!canResolveDisputes(interaction.member)) {
    return interaction.reply({ content: t('admin_resolve.only_admins', lang), ephemeral: true });
  }

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: t('common.match_not_found', lang), ephemeral: true });

  // Atomic idempotency claim
  const claimed = matchRepo.atomicStatusTransition(matchId, MATCH_STATUS.DISPUTED, MATCH_STATUS.COMPLETED);
  if (!claimed) {
    return interaction.update({
      content: 'This match has already been resolved.',
      embeds: [], components: [],
    });
  }

  const challenge = challengeRepo.findById(match.challenge_id);

  const { logAdminAction } = require('../../utils/adminAudit');
  logAdminAction(interaction.user.id, 'resolve_no_winner', 'match', matchId, {});

  await interaction.update({
    content: t('admin_resolve.no_winner_resolved_msg', lang, { user: `<@${interaction.user.id}>`, matchId }),
    embeds: [], components: [],
  });

  try {
    // Refund ALL funds for cash matches
    if (challenge && challenge.type === 'cash_match' && Number(challenge.total_pot_usdc) > 0) {
      const challengePlayerRepo2 = require('../../database/repositories/challengePlayerRepo');
      const allPlayers = challengePlayerRepo2.findByChallengeId(match.challenge_id);

      const escrowManager = require('../../base/escrowManager');

      // 1. On-chain cancel
      try {
        await escrowManager.cancelOnChainMatch(
          matchId,
          match.challenge_id,
          allPlayers,
          challenge.entry_amount_usdc,
        );
      } catch (err) {
        console.error(`[MatchResult] On-chain cancel failed for match #${matchId}:`, err.message);
        const { postTransaction } = require('../../utils/transactionFeed');
        postTransaction({
          type: 'balance_mismatch',
          challengeId: match.challenge_id,
          memo: `\u{1F6A8} On-chain cancel FAILED for match #${matchId} (no winner). Error: ${err.message}`,
        });
      }

      // 2. DB-level hold release
      try {
        escrowManager.refundAll(match.challenge_id);
      } catch (refundErr) {
        console.error(`[MatchResult] DB refundAll failed for match #${matchId}:`, refundErr.message);
      }
    }

    challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.COMPLETED);

    await postDisputeResult(interaction.client, matchId, 0, interaction.user.id);

    // Post to regular results channels
    try {
      const { GAME_MODES } = require('../../config/constants');
      const { formatUsdc } = require('../../utils/embeds');
      const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
      const isCashMatch = challenge && challenge.type === 'cash_match' && Number(challenge.total_pot_usdc) > 0;
      const matchTypeLabel = isCashMatch ? 'Cash Match' : 'XP Match';
      const modeInfo = challenge ? GAME_MODES[challenge.game_modes] : null;
      const modeLabel = modeInfo ? modeInfo.label : (challenge?.game_modes || 'N/A');

      const teamLines = (team) => allPlayers.filter(p => p.team === team).map(p => {
        const u = userRepo.findById(p.user_id);
        return u ? `<@${u.discord_id}> ${u.cod_ign ? `(${u.cod_ign})` : ''}` : null;
      }).filter(Boolean);
      const team1Lines = teamLines(1);
      const team2Lines = teamLines(2);

      const refundText = isCashMatch
        ? `**No Winner \u2014 ${formatUsdc(challenge.total_pot_usdc)} USDC refunded to all players**`
        : '**No Winner \u2014 match cancelled**';

      const noWinnerEmbed = new EmbedBuilder()
        .setTitle(`${matchTypeLabel} #${matchId} \u2014 Result`)
        .setColor(0x95a5a6)
        .setDescription([
          refundText,
          '',
          `Resolved by <@${interaction.user.id}>`,
          '',
          '**Team 1**',
          ...team1Lines,
          '',
          '**Team 2**',
          ...team2Lines,
        ].join('\n'))
        .addFields(
          { name: 'Mode', value: modeLabel, inline: true },
          { name: 'Series', value: `Best of ${challenge?.series_length || '?'}`, inline: true },
          { name: 'Team Size', value: `${challenge?.team_size || '?'}v${challenge?.team_size || '?'}`, inline: true },
        )
        .setTimestamp();

      await matchService.postResultToChannels(interaction.client, noWinnerEmbed, [], isCashMatch, matchId);
    } catch (err) {
      console.error(`[MatchResult] Failed to post no-winner result to results channels for match #${matchId}:`, err.message);
    }

    // Cleanup match channels. Disputes don't have their own channels —
    // the dispute UI is posted into the existing shared_text_id, so a
    // separate dispute-channel cleanup pass is unneeded (the previous
    // `cleanupDisputeChannels` call here referenced an export that
    // never existed and silently threw inside the setTimeout).
    setTimeout(() => {
      matchService.cleanupChannels(interaction.client, matchId).catch(() => {});
    }, 60000);

  } catch (err) {
    console.error(`[MatchResult] No-winner resolution failed for match #${matchId}:`, err);
  }
}

/**
 * Handle admin go-back button — return to the resolve choice panel.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleAdminGoBack(interaction) {
  const lang = langFor(interaction);
  const matchId = parseInt(interaction.customId.replace('admin_goback_', ''), 10);
  const adminRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin_resolve_team1_${matchId}`).setLabel(t('admin_resolve.btn_team1_wins', lang)).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`admin_resolve_team2_${matchId}`).setLabel(t('admin_resolve.btn_team2_wins', lang)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`admin_resolve_nowinner_${matchId}`).setLabel(t('admin_resolve.btn_no_winner', lang)).setStyle(ButtonStyle.Secondary),
  );
  return interaction.update({ content: t('admin_resolve.staff_panel_review', lang), embeds: [], components: [adminRow] });
}

module.exports = {
  handleAdminResolve,
  handleAdminConfirm,
  handleAdminConfirmNoWinner,
  handleAdminGoBack,
  postDisputeResult,
};
