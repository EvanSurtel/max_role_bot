// Challenge cancellation by creator (refunds held funds).
const challengeRepo = require('../database/repositories/challengeRepo');
const userRepo = require('../database/repositories/userRepo');
const challengeService = require('../services/challengeService');
const { challengeEmbed } = require('../utils/embeds');
const { CHALLENGE_STATUS, CHALLENGE_TYPE } = require('../config/constants');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { t, langFor } = require('../locales/i18n');

const CANCELLABLE = [
  CHALLENGE_STATUS.PENDING_TEAMMATES,
  CHALLENGE_STATUS.OPEN,
  CHALLENGE_STATUS.ACCEPTED,
];

/**
 * Handle cancel button — show confirmation first.
 */
async function handleButton(interaction) {
  const customId = interaction.customId;
  const lang = langFor(interaction);

  // Confirmed cancel
  if (customId.startsWith('challenge_confirm_cancel_')) {
    return handleConfirmedCancel(interaction);
  }

  // Initial cancel click — show confirmation
  const challengeId = parseInt(customId.replace('challenge_cancel_', ''), 10);
  if (isNaN(challengeId)) {
    return interaction.reply({ content: t('common.invalid_challenge', lang), ephemeral: true });
  }

  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    return interaction.reply({ content: t('common.challenge_not_found', lang), ephemeral: true });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user || user.id !== challenge.creator_user_id) {
    return interaction.reply({ content: t('challenge_cancel.only_creator', lang), ephemeral: true });
  }

  if (!CANCELLABLE.includes(challenge.status)) {
    return interaction.reply({
      content: t('challenge_cancel.cannot_cancel_now', lang),
      ephemeral: true,
    });
  }

  const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
  const typeLabel = isCashMatch ? t('challenge_create.type_cash_match', lang) : t('challenge_create.type_xp_match', lang);
  const displayNum = challenge.display_number || challengeId;
  const refundLine = isCashMatch ? `\n\n${t('challenge_cancel.confirm_refund_notice', lang)}` : '';

  const confirmEmbed = new EmbedBuilder()
    .setTitle(t('challenge_cancel.confirm_title', lang))
    .setColor(0xe74c3c)
    .setDescription(t('challenge_cancel.confirm_question', lang, { type: typeLabel, num: displayNum }) + refundLine);

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`challenge_confirm_cancel_${challengeId}`)
      .setLabel(t('challenge_cancel.btn_yes_cancel', lang))
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('challenge_cancel_nevermind')
      .setLabel(t('challenge_cancel.btn_nevermind', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
}

/**
 * Handle confirmed cancel.
 */
async function handleConfirmedCancel(interaction) {
  const lang = langFor(interaction);
  const challengeId = parseInt(interaction.customId.replace('challenge_confirm_cancel_', ''), 10);
  if (isNaN(challengeId)) {
    return interaction.reply({ content: t('common.invalid_challenge', lang), ephemeral: true });
  }

  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    return interaction.reply({ content: t('common.challenge_not_found', lang), ephemeral: true });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user || user.id !== challenge.creator_user_id) {
    return interaction.reply({ content: t('challenge_cancel.only_creator', lang), ephemeral: true });
  }

  if (!CANCELLABLE.includes(challenge.status)) {
    // The legacy fallback message ("match already started or completed")
    // was misleading for the most common path — a creator clicking
    // Cancel after the 1-hour expiry timer already auto-refunded them.
    // Distinguish EXPIRED + CANCELLED states so they know funds are
    // already back.
    let content;
    const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
    const refundLine = isCashMatch && Number(challenge.total_pot_usdc) > 0
      ? ' Your entry has been refunded to your balance.'
      : '';
    if (challenge.status === CHALLENGE_STATUS.EXPIRED) {
      content = `This challenge already expired (1 hour timeout, no one accepted).${refundLine}`;
    } else if (challenge.status === CHALLENGE_STATUS.CANCELLED) {
      content = `This challenge was already cancelled.${refundLine}`;
    } else {
      // IN_PROGRESS, VOTING, COMPLETED, DISPUTED, PENDING_VERIFICATION
      content = t('challenge_cancel.cannot_cancel_now', lang);
    }
    return interaction.reply({ content, ephemeral: true });
  }

  const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
  const typeLabel = isCashMatch ? t('challenge_create.type_cash_match', lang) : t('challenge_create.type_xp_match', lang);
  const displayNum = challenge.display_number || challengeId;

  try {
    await interaction.update({ content: t('challenge_cancel.cancelling', lang), embeds: [], components: [] });

    await challengeService.cancelChallenge(challengeId, interaction.client);
    await disableBoardMessage(interaction.client, challenge);

    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({
      type: 'challenge_cancelled',
      discordId: interaction.user.id,
      challengeId,
      memo: isCashMatch
        ? `Cash Match #${displayNum} cancelled by creator — all funds refunded`
        : `XP Match #${displayNum} cancelled by creator`,
    });

    const cancelKey = isCashMatch ? 'challenge_cancel.cancelled_with_refund' : 'challenge_cancel.cancelled';
    await interaction.followUp({
      content: t(cancelKey, lang, { type: typeLabel, num: displayNum }),
      ephemeral: true,
    });
  } catch (err) {
    console.error(`[ChallengeCancel] Error cancelling challenge #${challengeId}:`, err);
    await interaction.followUp({ content: t('challenge_cancel.failed_cancel', lang), ephemeral: true });
  }
}

/**
 * Update the board message to show cancelled and disable buttons.
 */
async function disableBoardMessage(client, challenge) {
  if (!challenge.challenge_message_id || !challenge.challenge_channel_id) return;

  try {
    const boardChannel = client.channels.cache.get(challenge.challenge_channel_id);
    if (!boardChannel) return;

    const message = await boardChannel.messages.fetch(challenge.challenge_message_id);
    if (!message) return;

    // Delete the challenge from the board entirely
    await message.delete();
  } catch (err) {
    console.error(`[ChallengeCancel] Failed to update board message:`, err.message);
  }
}

module.exports = { handleButton };
