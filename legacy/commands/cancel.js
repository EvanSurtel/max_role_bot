const { SlashCommandBuilder } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const challengeService = require('../services/challengeService');
const { CHALLENGE_STATUS } = require('../config/constants');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cancel')
    .setDescription('Cancel a challenge you created')
    .addIntegerOption(opt =>
      opt.setName('challenge_id').setDescription('The ID of the challenge to cancel').setRequired(true),
    ),

  async execute(interaction) {
    const challengeId = interaction.options.getInteger('challenge_id');

    // Look up user
    const user = userRepo.findByDiscordId(interaction.user.id);
    if (!user) {
      return interaction.reply({
        content: 'You need to complete onboarding first.',
        ephemeral: true,
      });
    }

    // Find challenge
    const challenge = challengeRepo.findById(challengeId);
    if (!challenge) {
      return interaction.reply({
        content: `Challenge #${challengeId} not found.`,
        ephemeral: true,
      });
    }

    // Validate caller is the creator
    if (challenge.creator_user_id !== user.id) {
      return interaction.reply({
        content: 'Only the challenge creator can cancel it.',
        ephemeral: true,
      });
    }

    // Validate status allows cancellation
    const cancellableStatuses = [
      CHALLENGE_STATUS.PENDING_TEAMMATES,
      CHALLENGE_STATUS.OPEN,
      CHALLENGE_STATUS.ACCEPTED,
    ];
    if (!cancellableStatuses.includes(challenge.status)) {
      return interaction.reply({
        content: `Challenge #${challengeId} cannot be cancelled in its current state (\`${challenge.status}\`). Only pending, open, or accepted challenges can be cancelled.`,
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      // Use challengeService.cancelChallenge() which handles refunds + status update
      await challengeService.cancelChallenge(challengeId);

      // Clean up the challenge board message if one exists
      if (challenge.challenge_message_id && challenge.challenge_channel_id) {
        try {
          const boardChannel = interaction.client.channels.cache.get(challenge.challenge_channel_id);
          if (boardChannel) {
            const boardMessage = await boardChannel.messages.fetch(challenge.challenge_message_id).catch(() => null);
            if (boardMessage) {
              if (boardMessage.deletable) {
                await boardMessage.delete().catch(() => null);
              } else {
                // Fall back to editing the message to show cancelled
                await boardMessage.edit({
                  content: `[CANCELLED] Challenge #${challengeId}`,
                  embeds: [],
                  components: [],
                }).catch(() => null);
              }
            }
          }
        } catch {
          // Board message cleanup is best-effort
        }
      }

      // Clean up notification channels for pending players
      const players = challengePlayerRepo.findByChallengeId(challengeId);
      for (const player of players) {
        if (player.notification_channel_id) {
          try {
            const notifChannel = interaction.client.channels.cache.get(player.notification_channel_id);
            if (notifChannel && notifChannel.deletable) {
              await notifChannel.delete('Challenge cancelled').catch(() => null);
            }
          } catch {
            // Notification channel cleanup is best-effort
          }
        }
      }

      return interaction.editReply({
        content: `Challenge #${challengeId} has been cancelled. All held funds have been refunded.`,
      });
    } catch (err) {
      console.error('[Cancel] Error cancelling challenge:', err);
      return interaction.editReply({
        content: 'An error occurred while cancelling the challenge. Please try again.',
      });
    }
  },
};
