const challengeRepo = require('../database/repositories/challengeRepo');
const userRepo = require('../database/repositories/userRepo');
const challengeService = require('../services/challengeService');
const { challengeEmbed } = require('../utils/embeds');
const { CHALLENGE_STATUS } = require('../config/constants');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Statuses where the creator can still cancel
const CANCELLABLE = [
  CHALLENGE_STATUS.PENDING_TEAMMATES,
  CHALLENGE_STATUS.OPEN,
  CHALLENGE_STATUS.ACCEPTED,
];

/**
 * Handle the cancel button on a challenge board post or during teammate phase.
 * customId: challenge_cancel_{challengeId}
 */
async function handleButton(interaction) {
  const challengeId = parseInt(interaction.customId.replace('challenge_cancel_', ''), 10);
  if (isNaN(challengeId)) {
    return interaction.reply({ content: 'Invalid challenge.', ephemeral: true });
  }

  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    return interaction.reply({ content: 'Challenge not found.', ephemeral: true });
  }

  // Only the creator can cancel
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user || user.id !== challenge.creator_user_id) {
    return interaction.reply({ content: 'Only the challenge creator can cancel.', ephemeral: true });
  }

  // Check the challenge is in a cancellable state
  if (!CANCELLABLE.includes(challenge.status)) {
    return interaction.reply({
      content: 'This challenge can no longer be cancelled (match already started or completed).',
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // Cancel + refund all held funds
    await challengeService.cancelChallenge(challengeId);

    // Update the board message to show cancelled
    await disableBoardMessage(interaction.client, challenge);

    await interaction.editReply({
      content: `Challenge #${challengeId} has been cancelled. All funds have been refunded.`,
    });
  } catch (err) {
    console.error(`[ChallengeCancel] Error cancelling challenge #${challengeId}:`, err);
    await interaction.editReply({ content: 'Failed to cancel challenge. Please try again.' });
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

    const embed = challengeEmbed(challenge, !!challenge.is_anonymous);
    embed.setTitle(`[CANCELLED] ${embed.data.title}`);
    embed.setColor(0x95a5a6);

    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`challenge_accept_${challenge.id}`)
        .setLabel('Cancelled')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    );

    await message.edit({ embeds: [embed], components: [disabledRow] });
  } catch (err) {
    console.error(`[ChallengeCancel] Failed to update board message:`, err.message);
  }
}

module.exports = { handleButton };
