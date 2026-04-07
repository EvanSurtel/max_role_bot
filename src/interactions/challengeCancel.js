const challengeRepo = require('../database/repositories/challengeRepo');
const userRepo = require('../database/repositories/userRepo');
const challengeService = require('../services/challengeService');
const { challengeEmbed } = require('../utils/embeds');
const { CHALLENGE_STATUS } = require('../config/constants');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

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

  // Confirmed cancel
  if (customId.startsWith('challenge_confirm_cancel_')) {
    return handleConfirmedCancel(interaction);
  }

  // Initial cancel click — show confirmation
  const challengeId = parseInt(customId.replace('challenge_cancel_', ''), 10);
  if (isNaN(challengeId)) {
    return interaction.reply({ content: 'Invalid challenge.', ephemeral: true });
  }

  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    return interaction.reply({ content: 'Challenge not found.', ephemeral: true });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user || user.id !== challenge.creator_user_id) {
    return interaction.reply({ content: 'Only the challenge creator can cancel.', ephemeral: true });
  }

  if (!CANCELLABLE.includes(challenge.status)) {
    return interaction.reply({
      content: 'This challenge can no longer be cancelled (match already started or completed).',
      ephemeral: true,
    });
  }

  const confirmEmbed = new EmbedBuilder()
    .setTitle('Confirm Cancel')
    .setColor(0xe74c3c)
    .setDescription(`Are you sure you want to cancel **\${challenge.type === 'wager' ? 'Wager' : 'XP Match'} #\${challenge.display_number || challengeId}**?\n\nAll held funds will be refunded to all players.`);

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`challenge_confirm_cancel_${challengeId}`)
      .setLabel('Yes, Cancel Challenge')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('challenge_cancel_nevermind')
      .setLabel('Nevermind')
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
}

/**
 * Handle confirmed cancel.
 */
async function handleConfirmedCancel(interaction) {
  const challengeId = parseInt(interaction.customId.replace('challenge_confirm_cancel_', ''), 10);
  if (isNaN(challengeId)) {
    return interaction.reply({ content: 'Invalid challenge.', ephemeral: true });
  }

  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    return interaction.reply({ content: 'Challenge not found.', ephemeral: true });
  }

  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user || user.id !== challenge.creator_user_id) {
    return interaction.reply({ content: 'Only the challenge creator can cancel.', ephemeral: true });
  }

  if (!CANCELLABLE.includes(challenge.status)) {
    return interaction.reply({ content: 'This challenge can no longer be cancelled.', ephemeral: true });
  }

  try {
    await interaction.update({ content: 'Cancelling challenge...', embeds: [], components: [] });

    await challengeService.cancelChallenge(challengeId);
    await disableBoardMessage(interaction.client, challenge);

    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({ type: 'challenge_cancelled', discordId: interaction.user.id, challengeId, memo: `\${challenge.type === 'wager' ? 'Wager' : 'XP Match'} #\${challenge.display_number || challengeId} cancelled by creator — all funds refunded` });

    await interaction.followUp({
      content: `\${challenge.type === 'wager' ? 'Wager' : 'XP Match'} #\${challenge.display_number || challengeId} has been cancelled. All funds have been refunded.`,
      ephemeral: true,
    });
  } catch (err) {
    console.error(`[ChallengeCancel] Error cancelling challenge #${challengeId}:`, err);
    await interaction.followUp({ content: 'Failed to cancel challenge. Please try again.', ephemeral: true });
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
    return;

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
