const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const escrowManager = require('../solana/escrowManager');
const channelService = require('./channelService');
const timerService = require('./timerService');
const { challengeEmbed, formatUsdc } = require('../utils/embeds');
const { CHALLENGE_STATUS, PLAYER_STATUS, TIMERS, GAME_MODES, CHALLENGE_TYPE } = require('../config/constants');

// Track active teammate-accept timers so they can be cleared on cancel
const teammateTimers = new Map(); // `${challengeId}_${playerId}` -> timeout handle

/**
 * Notify each pending teammate about a challenge invitation.
 * Creates a private channel per teammate with Accept/Decline buttons.
 *
 * @param {import('discord.js').Guild} guild - The Discord guild.
 * @param {object} challenge - The challenge DB record.
 */
async function notifyTeammates(guild, challenge) {
  const players = challengePlayerRepo.findByChallengeAndTeam(challenge.id, 1);
  const pendingPlayers = players.filter(p => p.status === PLAYER_STATUS.PENDING);

  for (const player of pendingPlayers) {
    try {
      const user = userRepo.findById(player.user_id);
      if (!user) {
        console.error(`[ChallengeService] No user found for player ${player.user_id}`);
        continue;
      }

      const discordId = user.discord_id;

      // Resolve the Discord user to get their username for the channel name
      let username = discordId;
      try {
        const discordUser = await guild.members.fetch(discordId);
        username = discordUser.user.username;
      } catch {
        // Fall back to discord ID if we can't fetch the member
      }

      // Create a private channel for this teammate
      const channel = await channelService.createPrivateChannel(
        guild,
        `invite-${username}`,
        [discordId],
      );

      // Store the channel ID on the challenge_player record
      challengePlayerRepo.setNotificationChannel(player.id, channel.id);

      // Build challenge details embed
      const isWager = challenge.type === CHALLENGE_TYPE.WAGER;
      const modeInfo = GAME_MODES[challenge.game_modes];
      const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;

      const creator = userRepo.findById(challenge.creator_user_id);
      const creatorMention = creator ? `<@${creator.discord_id}>` : 'Unknown';

      const description = [
        `${creatorMention} has invited you to join their team!`,
        '',
        `**Type:** ${isWager ? 'Wager' : 'XP Match'}`,
        `**Team Size:** ${challenge.team_size}v${challenge.team_size}`,
        `**Game Mode:** ${modeLabel}`,
        `**Series:** Best of ${challenge.series_length}`,
      ];

      if (isWager) {
        const entry = formatUsdc(challenge.entry_amount_usdc);
        description.push(`**Entry:** ${entry} USDC per player`);
      }

      description.push('', `You have **${TIMERS.TEAMMATE_ACCEPT / 60000} minutes** to accept or decline.`);

      // Build buttons
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`teammate_accept_${challenge.id}`)
          .setLabel('Accept')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`teammate_decline_${challenge.id}`)
          .setLabel('Decline')
          .setStyle(ButtonStyle.Danger),
      );

      await channel.send({
        content: `<@${discordId}>`,
        embeds: [
          {
            title: `Team Invite — Challenge #${challenge.id}`,
            description: description.join('\n'),
            color: isWager ? 0xf1c40f : 0x3498db,
          },
        ],
        components: [row],
      });

      // Start a timeout timer — treat as decline if no response
      const timerKey = `${challenge.id}_${player.id}`;
      const timer = setTimeout(async () => {
        teammateTimers.delete(timerKey);
        try {
          // Re-check the player's current status in case they already responded
          const currentPlayer = challengePlayerRepo.findById(player.id);
          if (!currentPlayer || currentPlayer.status !== PLAYER_STATUS.PENDING) return;

          // Treat as decline
          challengePlayerRepo.updateStatus(player.id, PLAYER_STATUS.DECLINED);
          console.log(`[ChallengeService] Teammate ${player.user_id} timed out for challenge ${challenge.id}`);

          // Notify in the channel before deleting
          try {
            await channel.send('You did not respond in time. The invitation has expired and the challenge has been cancelled.');
          } catch {
            // Channel may already be deleted
          }

          // Cancel the entire challenge
          await cancelChallenge(challenge.id);

          // Try to delete the channel after a short delay
          setTimeout(async () => {
            try {
              await channelService.deleteChannel(channel);
            } catch {
              // Channel may already be gone
            }
          }, 5000);
        } catch (err) {
          console.error(`[ChallengeService] Error handling teammate timeout:`, err);
        }
      }, TIMERS.TEAMMATE_ACCEPT);

      teammateTimers.set(timerKey, timer);

      console.log(`[ChallengeService] Notified teammate ${discordId} in channel ${channel.id} for challenge ${challenge.id}`);
    } catch (err) {
      console.error(`[ChallengeService] Error notifying teammate ${player.user_id}:`, err);
    }
  }
}

/**
 * Post the challenge to the public challenge board channel.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {object} challenge - The challenge DB record.
 */
async function postToBoard(client, challenge) {
  const channelId = process.env.CHALLENGES_CHANNEL_ID;
  if (!channelId) {
    console.error('[ChallengeService] CHALLENGES_CHANNEL_ID is not set');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.error(`[ChallengeService] Challenge board channel ${channelId} not found in cache`);
    return;
  }

  // Build the embed
  const embed = challengeEmbed(challenge, !!challenge.is_anonymous);

  // Build the accept + cancel buttons
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`challenge_accept_${challenge.id}`)
      .setLabel('Accept Challenge')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`challenge_cancel_${challenge.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );

  const message = await channel.send({
    embeds: [embed],
    components: [row],
  });

  // Store message reference on the challenge
  challengeRepo.setMessageId(challenge.id, message.id, channel.id);

  // Ensure challenge status is 'open'
  if (challenge.status !== CHALLENGE_STATUS.OPEN) {
    challengeRepo.updateStatus(challenge.id, CHALLENGE_STATUS.OPEN);
  }

  // Create a challenge_expiry timer so the challenge auto-expires
  if (challenge.expires_at) {
    const remainingMs = new Date(challenge.expires_at).getTime() - Date.now();
    if (remainingMs > 0) {
      timerService.createTimer('challenge_expiry', challenge.id, remainingMs);
      console.log(`[ChallengeService] Created expiry timer for challenge #${challenge.id} (${remainingMs}ms)`);
    } else {
      // Already expired — fire immediately
      timerService.createTimer('challenge_expiry', challenge.id, 0);
      console.log(`[ChallengeService] Challenge #${challenge.id} already past expiry, firing immediately`);
    }
  }

  console.log(`[ChallengeService] Posted challenge #${challenge.id} to board (msg ${message.id})`);
}

/**
 * Cancel a challenge — refund all held funds, update status, clean up channels/messages.
 *
 * @param {number} challengeId - The challenge ID.
 */
async function cancelChallenge(challengeId) {
  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    console.error(`[ChallengeService] Challenge ${challengeId} not found for cancellation`);
    return;
  }

  // Refund all held funds
  escrowManager.refundAll(challengeId);

  // Cancel any pending expiry timer for this challenge
  timerService.cancelTimersByReference('challenge_expiry', challengeId);

  // Update status to cancelled
  challengeRepo.updateStatus(challengeId, CHALLENGE_STATUS.CANCELLED);

  // Clear any teammate accept timers for this challenge
  for (const [key, timer] of teammateTimers.entries()) {
    if (key.startsWith(`${challengeId}_`)) {
      clearTimeout(timer);
      teammateTimers.delete(key);
    }
  }

  // Delete any notification channels that were created
  const players = challengePlayerRepo.findByChallengeId(challengeId);
  for (const player of players) {
    if (player.notification_channel_id) {
      try {
        // We need to fetch the channel — but we don't have the client here.
        // The notification_channel_id is stored; callers with access to guild
        // should handle cleanup. We'll still attempt to note it.
        console.log(`[ChallengeService] Notification channel ${player.notification_channel_id} should be cleaned up for challenge ${challengeId}`);
      } catch {
        // Ignore
      }
    }
  }

  // If there's a challenge board message, attempt to note it for cleanup
  if (challenge.challenge_message_id && challenge.challenge_channel_id) {
    console.log(`[ChallengeService] Board message ${challenge.challenge_message_id} in ${challenge.challenge_channel_id} should be cleaned up for challenge ${challengeId}`);
  }

  console.log(`[ChallengeService] Challenge #${challengeId} cancelled`);
}

/**
 * Called when the last teammate accepts — updates status and posts to board.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {object} challenge - The challenge DB record.
 */
async function handleAllTeammatesAccepted(client, challenge) {
  // Update challenge status to open
  challengeRepo.updateStatus(challenge.id, CHALLENGE_STATUS.OPEN);

  // Refresh the challenge record so postToBoard sees the updated status
  const updatedChallenge = challengeRepo.findById(challenge.id);

  // Post to the challenge board
  await postToBoard(client, updatedChallenge || challenge);

  console.log(`[ChallengeService] All teammates accepted for challenge #${challenge.id}, posted to board`);
}

/**
 * Clear a teammate timer (used when a teammate responds before timeout).
 *
 * @param {number} challengeId - The challenge ID.
 * @param {number} playerId - The challenge_player ID.
 */
function clearTeammateTimer(challengeId, playerId) {
  const key = `${challengeId}_${playerId}`;
  const timer = teammateTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    teammateTimers.delete(key);
  }
}

module.exports = {
  notifyTeammates,
  postToBoard,
  cancelChallenge,
  handleAllTeammatesAccepted,
  clearTeammateTimer,
};
