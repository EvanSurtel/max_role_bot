// Captain report flow — We Won / We Lost confirmation + vote recording.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const matchRepo = require('../../database/repositories/matchRepo');
const challengeRepo = require('../../database/repositories/challengeRepo');
const challengePlayerRepo = require('../../database/repositories/challengePlayerRepo');
const userRepo = require('../../database/repositories/userRepo');
const { MATCH_STATUS, PLAYER_ROLE } = require('../../config/constants');
const { t, langFor } = require('../../locales/i18n');
const { buildLanguageDropdownRow } = require('../../utils/languageButtonHelper');

/**
 * Show a confirmation embed before recording a captain's report.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {'won'|'lost'} outcome
 */
async function showReportConfirm(interaction, outcome) {
  const lang = langFor(interaction);
  const matchId = parseInt(interaction.customId.replace(`report_${outcome}_`, ''), 10);
  if (isNaN(matchId)) return interaction.reply({ content: t('match_result.invalid_match', lang), ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: t('common.match_not_found', lang), ephemeral: true });

  if (match.status !== MATCH_STATUS.ACTIVE && match.status !== MATCH_STATUS.VOTING) {
    return interaction.reply({ content: t('match_result.no_longer_reports', lang), ephemeral: true });
  }

  // Check minimum time before reporting
  const { MIN_REPORT_MINUTES } = require('../../config/constants');
  const challenge = challengeRepo.findById(match.challenge_id);
  const minMinutes = MIN_REPORT_MINUTES[challenge?.series_length] ?? 5;
  const matchCreatedAt = new Date(match.created_at).getTime();
  const elapsedMinutes = (Date.now() - matchCreatedAt) / 60000;

  if (elapsedMinutes < minMinutes) {
    const remaining = Math.ceil(minMinutes - elapsedMinutes);
    return interaction.reply({
      content: t('match_result.cant_report_yet', lang, { minutes: minMinutes, series: challenge?.series_length || '?', remaining }),
      ephemeral: true,
    });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: t('common.not_registered_simple', lang), ephemeral: true });

  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  let captainTeam = null;
  for (const p of allPlayers) {
    if (p.user_id === user.id && p.role === PLAYER_ROLE.CAPTAIN) {
      captainTeam = p.team;
      break;
    }
  }
  if (!captainTeam) {
    return interaction.reply({ content: t('common.only_captains', lang), ephemeral: true });
  }

  if (captainTeam === 1 && match.captain1_vote !== null) {
    return interaction.reply({ content: t('match_result.you_already_reported', lang), ephemeral: true, _autoDeleteMs: 60_000 });
  }
  if (captainTeam === 2 && match.captain2_vote !== null) {
    return interaction.reply({ content: t('match_result.you_already_reported', lang), ephemeral: true, _autoDeleteMs: 60_000 });
  }

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('match_result.confirm_report_title', lang))
    .setColor(outcome === 'won' ? 0x2ecc71 : 0xe74c3c)
    .setDescription(
      outcome === 'won'
        ? t('match_result.confirm_won', lang, { team: captainTeam, matchId })
        : t('match_result.confirm_lost', lang, { team: captainTeam, matchId })
    );

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_${outcome}_${matchId}`)
      .setLabel(outcome === 'won' ? t('match_result.btn_yes_we_won', lang) : t('match_result.btn_yes_we_lost', lang))
      .setStyle(outcome === 'won' ? ButtonStyle.Success : ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('report_cancel')
      .setLabel(t('common.cancel', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
}

/**
 * Record a captain's confirmed report and process votes.
 *
 * If both captains have reported and agree, resolves the match.
 * If they disagree, triggers a dispute.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {'won'|'lost'} outcome
 */
async function handleReport(interaction, outcome) {
  const lang = langFor(interaction);
  const matchId = parseInt(interaction.customId.replace(`confirm_${outcome}_`, ''), 10);
  if (isNaN(matchId)) return interaction.reply({ content: t('match_result.invalid_match', lang), ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: t('common.match_not_found', lang), ephemeral: true });

  if (match.status !== MATCH_STATUS.ACTIVE && match.status !== MATCH_STATUS.VOTING) {
    return interaction.reply({ content: t('match_result.no_longer_reports', lang), ephemeral: true });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: t('common.not_registered_simple', lang), ephemeral: true });

  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  let captainTeam = null;
  for (const p of allPlayers) {
    if (p.user_id === user.id && p.role === PLAYER_ROLE.CAPTAIN) {
      captainTeam = p.team;
      break;
    }
  }
  if (!captainTeam) {
    return interaction.reply({ content: t('common.only_captains', lang), ephemeral: true });
  }

  if (captainTeam === 1 && match.captain1_vote !== null) {
    return interaction.reply({ content: t('match_result.you_already_reported_waiting', lang), ephemeral: true, _autoDeleteMs: 60_000 });
  }
  if (captainTeam === 2 && match.captain2_vote !== null) {
    return interaction.reply({ content: t('match_result.you_already_reported_waiting', lang), ephemeral: true, _autoDeleteMs: 60_000 });
  }

  // Determine what team this captain says won
  let reportedWinner;
  if (outcome === 'won') {
    reportedWinner = captainTeam;
  } else {
    reportedWinner = captainTeam === 1 ? 2 : 1;
  }

  matchRepo.setCaptainVote(matchId, captainTeam, reportedWinner);

  if (match.status === MATCH_STATUS.ACTIVE) {
    matchRepo.updateStatus(matchId, MATCH_STATUS.VOTING);
  }

  // Log to admin feed
  const { postTransaction } = require('../../utils/transactionFeed');
  postTransaction({ type: 'match_report', username: user.server_username, discordId: user.discord_id, challengeId: match.challenge_id, memo: `Match #${matchId} | Team ${captainTeam} captain reported: ${outcome === 'won' ? 'WE WON' : 'WE LOST'} (says Team ${reportedWinner} won)` });

  // Update the ephemeral confirmation message
  const reportedKey = outcome === 'won' ? 'match_result.report_recorded_won' : 'match_result.report_recorded_lost';
  try {
    await interaction.update({
      content: t(reportedKey, lang),
      embeds: [],
      components: [],
    });
  } catch {
    await interaction.reply({
      content: t(reportedKey, lang),
      ephemeral: true,
    });
  }

  // Re-fetch to check if both have now reported
  const updatedMatch = matchRepo.findById(matchId);
  const c1Vote = captainTeam === 1 ? reportedWinner : updatedMatch.captain1_vote;
  const c2Vote = captainTeam === 2 ? reportedWinner : updatedMatch.captain2_vote;

  if (c1Vote !== null && c2Vote !== null) {
    if (c1Vote === c2Vote) {
      // AGREE -- resolve
      const winningTeam = c1Vote;
      const matchService = require('../../services/matchService');

      try {
        const voteChannel = interaction.client.channels.cache.get(match.voting_channel_id);
        if (voteChannel) {
          const allPlayersForLang = challengePlayerRepo.findByChallengeId(match.challenge_id);
          const captainPlayer = allPlayersForLang.find(p => p.role === PLAYER_ROLE.CAPTAIN);
          const captainUser = captainPlayer ? userRepo.findById(captainPlayer.user_id) : null;
          const sharedLang = captainUser ? langFor({ user: { id: captainUser.discord_id }, locale: '' }) : 'en';
          const agreeLangRow = buildLanguageDropdownRow(sharedLang);
          await voteChannel.send({
            content: t('match_channel.captains_agree', sharedLang, { team: winningTeam }),
            components: [...agreeLangRow],
          });
        }
        await matchService.resolveMatch(interaction.client, matchId, winningTeam);
      } catch (err) {
        console.error(`[MatchResult] Failed to resolve match #${matchId}:`, err);
      }
    } else {
      // DISAGREE -- dispute
      const { triggerDispute } = require('./dispute');
      await triggerDispute(interaction.client, matchId);

      const voteChannel = interaction.client.channels.cache.get(match.voting_channel_id);
      if (voteChannel) {
        const allPlayersForLang = challengePlayerRepo.findByChallengeId(match.challenge_id);
        const captainPlayer = allPlayersForLang.find(p => p.role === PLAYER_ROLE.CAPTAIN);
        const captainUser = captainPlayer ? userRepo.findById(captainPlayer.user_id) : null;
        const sharedLang = captainUser ? langFor({ user: { id: captainUser.discord_id }, locale: '' }) : 'en';
        const disagreeLangRow = buildLanguageDropdownRow(sharedLang);
        await voteChannel.send({
          content: t('match_channel.captains_disagree', sharedLang, { t1: c1Vote, t2: c2Vote }),
          components: [...disagreeLangRow],
        });
      }
    }
  }
}

module.exports = { showReportConfirm, handleReport };
