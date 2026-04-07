const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const escrowManager = require('../solana/escrowManager');
const challengeService = require('../services/challengeService');
const matchService = require('../services/matchService');
const channelService = require('../services/channelService');
const { CHALLENGE_STATUS, PLAYER_STATUS, CHALLENGE_TYPE } = require('../config/constants');

/**
 * Handle button interactions for teammate accept/decline responses.
 * CustomId format: teammate_accept_{challengeId} or teammate_decline_{challengeId}
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleButton(interaction) {
  const customId = interaction.customId;

  // Parse action and challenge ID
  let action, challengeId;
  if (customId.startsWith('teammate_confirm_accept_')) {
    action = 'accept';
    challengeId = parseInt(customId.replace('teammate_confirm_accept_', ''), 10);
  } else if (customId.startsWith('teammate_accept_')) {
    action = 'accept_pending'; // show confirmation first
    challengeId = parseInt(customId.replace('teammate_accept_', ''), 10);
  } else if (customId.startsWith('teammate_decline_')) {
    action = 'decline';
    challengeId = parseInt(customId.replace('teammate_decline_', ''), 10);
  } else {
    return;
  }

  if (isNaN(challengeId)) {
    return interaction.reply({ content: 'Invalid challenge reference.', ephemeral: true });
  }

  const discordId = interaction.user.id;

  // Find the user in DB
  const user = userRepo.findByDiscordId(discordId);
  if (!user) {
    return interaction.reply({
      content: 'You need to complete onboarding first. Use `/onboard` to get started.',
      ephemeral: true,
    });
  }

  // Find the challenge
  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    return interaction.reply({ content: 'This challenge no longer exists.', ephemeral: true });
  }

  // Find the challenge_player record for this user
  const player = challengePlayerRepo.findByChallengeAndUser(challengeId, user.id);
  if (!player) {
    return interaction.reply({ content: 'You are not part of this challenge.', ephemeral: true });
  }

  // Validate challenge status — team 1 uses 'pending_teammates', team 2 uses 'accepted'
  const validStatuses = [CHALLENGE_STATUS.PENDING_TEAMMATES, CHALLENGE_STATUS.ACCEPTED];
  if (!validStatuses.includes(challenge.status)) {
    return interaction.reply({
      content: 'This challenge is no longer waiting for teammates.',
      ephemeral: true,
    });
  }

  // Validate player status
  if (player.status !== PLAYER_STATUS.PENDING) {
    return interaction.reply({
      content: 'You have already responded to this invitation.',
      ephemeral: true,
    });
  }

  // Clear the teammate timeout timer since they responded
  // For initial accept click, show confirmation (don't clear timer yet)
  if (action === 'accept_pending') {
    return showAcceptConfirm(interaction, challenge, player, user);
  }

  // Clear timer only on confirmed accept or decline
  challengeService.clearTeammateTimer(challengeId, player.id);

  if (action === 'accept') {
    return showAcceptConfirm(interaction, challenge, player, user);
  } else {
    return handleDecline(interaction, challenge, player, user);
  }
}

/**
 * Show confirmation before accepting team invite.
 */
async function showAcceptConfirm(interaction, challenge, player, user) {
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  const { GAME_MODES, CHALLENGE_TYPE } = require('../config/constants');
  const { formatUsdc } = require('../utils/embeds');

  const isWager = challenge.type === CHALLENGE_TYPE.WAGER;
  const modeInfo = GAME_MODES[challenge.game_modes];
  const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;
  const entryText = isWager && Number(challenge.entry_amount_usdc) > 0
    ? `\n**Entry:** ${formatUsdc(challenge.entry_amount_usdc)} USDC will be held from your wallet.`
    : '';

  const confirmEmbed = new EmbedBuilder()
    .setTitle('Confirm Accept')
    .setColor(0x2ecc71)
    .setDescription([
      `You are joining **Challenge #${challenge.id}**`,
      '',
      `**Type:** ${isWager ? 'Wager' : 'XP Match'}`,
      `**Team Size:** ${challenge.team_size}v${challenge.team_size}`,
      `**Mode:** ${modeLabel}`,
      `**Series:** Best of ${challenge.series_length}`,
      entryText,
      '',
      'Are you sure?',
    ].join('\n'));

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`teammate_confirm_accept_${challenge.id}`)
      .setLabel('Yes, Join Team')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`teammate_decline_${challenge.id}`)
      .setLabel('Decline')
      .setStyle(ButtonStyle.Danger),
  );

  return interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
}

/**
 * Handle a teammate accepting the challenge invitation.
 */
async function handleAccept(interaction, challenge, player, user) {
  // For wager challenges, check balance and hold funds
  if (challenge.type === CHALLENGE_TYPE.WAGER && Number(challenge.entry_amount_usdc) > 0) {
    const entryUsdc = challenge.entry_amount_usdc.toString();

    if (!escrowManager.canAfford(user.id, entryUsdc)) {
      const { formatUsdc } = require('../utils/embeds');
      return interaction.reply({
        content: `You don't have enough USDC to join this wager. You need **${formatUsdc(entryUsdc)} USDC**. Please deposit funds and try again, or decline the invitation.`,
        ephemeral: true,
      });
    }

    const held = escrowManager.holdFunds(user.id, entryUsdc, challenge.id);
    if (!held) {
      return interaction.reply({
        content: 'Failed to hold your funds. Please try again.',
        ephemeral: true,
      });
    }

    // Mark funds as held on the player record
    challengePlayerRepo.setFundsHeld(player.id, true);
  }

  // Update player status to accepted
  challengePlayerRepo.updateStatus(player.id, PLAYER_STATUS.ACCEPTED);

  // Reply confirming acceptance
  await interaction.reply({
    content: `You have **accepted** the invitation for Challenge #${challenge.id}! Your funds have been held.`,
  });

  // Check if all players are now accepted
  const pendingCount = challengePlayerRepo.countPendingByChallenge(challenge.id);

  if (pendingCount === 0) {
    if (challenge.status === CHALLENGE_STATUS.PENDING_TEAMMATES) {
      // Team 1 complete — post challenge to the board
      await challengeService.handleAllTeammatesAccepted(interaction.client, challenge);
    } else if (challenge.status === CHALLENGE_STATUS.ACCEPTED) {
      // Team 2 complete — start the match (transfer to escrow + create channels)
      try {
        await matchService.startMatch(interaction.client, challenge.id);
      } catch (err) {
        console.error(`[TeammateResponse] Error starting match for challenge ${challenge.id}:`, err);
      }
    }
  }

  // Delete the notification channel after a short delay
  const channel = interaction.channel;
  setTimeout(async () => {
    try {
      await channelService.deleteChannel(channel);
    } catch (err) {
      console.error(`[TeammateResponse] Error deleting notification channel:`, err);
    }
  }, 5000);
}

/**
 * Handle a teammate declining the challenge invitation.
 */
async function handleDecline(interaction, challenge, player, user) {
  // Update player status to declined
  challengePlayerRepo.updateStatus(player.id, PLAYER_STATUS.DECLINED);

  // Reply confirming decline
  await interaction.reply({
    content: `You have **declined** the invitation for Challenge #${challenge.id}. The challenge will be cancelled.`,
  });

  // Notify the creator
  try {
    const creator = userRepo.findById(challenge.creator_user_id);
    if (creator) {
      const creatorDiscord = await interaction.client.users.fetch(creator.discord_id);
      if (creatorDiscord) {
        await creatorDiscord.send(
          `Your Challenge #${challenge.id} has been cancelled because <@${user.discord_id}> declined the team invitation.`,
        ).catch(() => {
          // DMs may be disabled; this is non-critical
          console.log(`[TeammateResponse] Could not DM creator ${creator.discord_id} about decline`);
        });
      }
    }
  } catch (err) {
    console.error('[TeammateResponse] Error notifying creator of decline:', err);
  }

  // Cancel the entire challenge (refunds all held funds)
  await challengeService.cancelChallenge(challenge.id);

  // Delete the notification channel after a short delay
  const channel = interaction.channel;
  setTimeout(async () => {
    try {
      await channelService.deleteChannel(channel);
    } catch (err) {
      console.error(`[TeammateResponse] Error deleting notification channel:`, err);
    }
  }, 5000);
}

module.exports = { handleButton };
