const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const matchRepo = require('../database/repositories/matchRepo');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const { MATCH_STATUS, CHALLENGE_STATUS, GAME_MODES } = require('../config/constants');
const { formatUsdc } = require('../utils/embeds');
const { t, langFor } = require('../locales/i18n');

/**
 * Handle the "Create Dispute" button from the lobby panel.
 */
async function handleCreateDispute(interaction) {
  const lang = langFor(interaction);
  const discordId = interaction.user.id;
  const user = userRepo.findByDiscordId(discordId);
  if (!user) return interaction.reply({ content: t('common.not_registered', lang), ephemeral: true });

  const db = require('../database/db');
  const recentMatches = db.prepare(`
    SELECT m.*, c.game_modes, c.series_length, c.team_size, c.total_pot_usdc, c.type, c.display_number
    FROM matches m
    JOIN challenges c ON m.challenge_id = c.id
    JOIN challenge_players cp ON cp.challenge_id = c.id
    WHERE cp.user_id = ? AND m.status IN ('completed', 'active', 'voting', 'disputed')
    ORDER BY m.created_at DESC LIMIT 10
  `).all(user.id);

  if (recentMatches.length === 0) {
    return interaction.reply({ content: t('dispute.no_recent', lang), ephemeral: true });
  }

  const rows = [];
  for (let i = 0; i < recentMatches.length; i += 5) {
    const chunk = recentMatches.slice(i, i + 5);
    const row = new ActionRowBuilder().addComponents(
      ...chunk.map(m => {
        const typeLabel = m.type === 'wager' ? 'Wager' : 'XP';
        const num = m.display_number || m.id;
        const pot = Number(m.total_pot_usdc) > 0 ? ` ${formatUsdc(m.total_pot_usdc)}` : '';
        return new ButtonBuilder()
          .setCustomId(`dispute_select_${m.id}`)
          .setLabel(`${typeLabel} #${num}${pot}`)
          .setStyle(m.status === 'disputed' ? ButtonStyle.Secondary : ButtonStyle.Danger);
      }),
    );
    rows.push(row);
  }

  return interaction.reply({
    embeds: [new EmbedBuilder().setTitle(t('dispute.create_title', lang)).setColor(0xe74c3c).setDescription(t('dispute.create_desc', lang))],
    components: rows,
    ephemeral: true,
  });
}

/**
 * Handle match selection — show confirmation.
 */
async function handleDisputeSelect(interaction) {
  const lang = langFor(interaction);
  const matchId = parseInt(interaction.customId.replace('dispute_select_', ''), 10);
  if (isNaN(matchId)) return interaction.reply({ content: t('match_result.invalid_match', lang), ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: t('common.match_not_found', lang), ephemeral: true });
  if (match.status === MATCH_STATUS.DISPUTED) return interaction.reply({ content: t('dispute.already_disputed', lang), ephemeral: true });

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) return interaction.reply({ content: t('common.not_registered_simple', lang), ephemeral: true });
  const playerRecord = challengePlayerRepo.findByChallengeAndUser(match.challenge_id, user.id);
  if (!playerRecord) return interaction.reply({ content: t('dispute.not_a_player', lang), ephemeral: true });

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('dispute.confirm_title', lang))
    .setColor(0xe74c3c)
    .setDescription(t('dispute.confirm_desc', lang, { matchId }));

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dispute_confirm_${matchId}`).setLabel(t('dispute.btn_yes_dispute', lang)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('dispute_nevermind').setLabel(t('common.nevermind', lang)).setStyle(ButtonStyle.Secondary),
  );

  return interaction.update({ embeds: [confirmEmbed], components: [confirmRow] });
}

/**
 * Handle confirmed dispute — trigger dispute in shared channel.
 */
async function handleDisputeConfirm(interaction) {
  const lang = langFor(interaction);
  const matchId = parseInt(interaction.customId.replace('dispute_confirm_', ''), 10);
  if (isNaN(matchId)) return interaction.reply({ content: t('match_result.invalid_match', lang), ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: t('common.match_not_found', lang), ephemeral: true });
  if (match.status === MATCH_STATUS.DISPUTED) {
    return interaction.update({ content: t('dispute.already_disputed', lang), embeds: [], components: [] });
  }

  await interaction.update({ content: t('dispute.created', lang), embeds: [], components: [] });

  // Use triggerDispute which posts in the existing shared-chat
  const { triggerDispute } = require('./matchResult');
  await triggerDispute(interaction.client, matchId);
}

module.exports = { handleCreateDispute, handleDisputeSelect, handleDisputeConfirm };
