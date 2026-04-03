const { ActionRowBuilder, UserSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const escrowManager = require('../solana/escrowManager');
const matchService = require('../services/matchService');
const challengeService = require('../services/challengeService');
const { CHALLENGE_STATUS, PLAYER_STATUS, PLAYER_ROLE, CHALLENGE_TYPE } = require('../config/constants');
const { challengeEmbed, formatUsdc } = require('../utils/embeds');

// Track in-progress acceptance flows for team games
const acceptFlows = new Map(); // discordUserId -> { challengeId, teammates: [] }

/**
 * Handle button interactions for accepting a challenge from the public board.
 * customId format: challenge_accept_${challengeId}
 */
async function handleButton(interaction) {
  const customId = interaction.customId;
  const challengeId = parseInt(customId.replace('challenge_accept_', ''), 10);

  if (isNaN(challengeId)) {
    return interaction.reply({ content: 'Invalid challenge.', ephemeral: true });
  }

  // Find the challenge
  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    return interaction.reply({ content: 'Challenge not found.', ephemeral: true });
  }

  if (challenge.status !== CHALLENGE_STATUS.OPEN) {
    return interaction.reply({ content: 'This challenge is no longer available.', ephemeral: true });
  }

  // Find or create the user in DB
  const discordId = interaction.user.id;
  let user = userRepo.findByDiscordId(discordId);
  if (!user || !user.cod_uid) {
    return interaction.reply({
      content: 'You must complete registration with your COD Mobile UID before accepting wagers.',
      ephemeral: true,
    });
  }

  // Check user is not already a player in this challenge (can't accept your own challenge)
  const existingPlayer = challengePlayerRepo.findByChallengeAndUser(challengeId, user.id);
  if (existingPlayer) {
    return interaction.reply({
      content: 'You are already part of this challenge. You cannot accept your own challenge.',
      ephemeral: true,
    });
  }

  const isWager = challenge.type === CHALLENGE_TYPE.WAGER;
  const entryUsdc = challenge.entry_amount_usdc;

  // 1v1 challenges — immediate acceptance
  if (challenge.team_size === 1) {
    await interaction.deferReply({ ephemeral: true });

    try {
      // Check balance and hold funds (if wager)
      if (isWager && Number(entryUsdc) > 0) {
        if (!escrowManager.canAfford(user.id, entryUsdc)) {
          return interaction.editReply({
            content: `Insufficient balance. You need **${formatUsdc(entryUsdc)} USDC** to accept this wager.`,
          });
        }

        const held = escrowManager.holdFunds(user.id, entryUsdc, challengeId);
        if (!held) {
          return interaction.editReply({
            content: 'Failed to hold funds. Please try again.',
          });
        }
      }

      // Add as team 2 captain (accepted, funds_held)
      challengePlayerRepo.create({
        challengeId,
        userId: user.id,
        team: 2,
        role: PLAYER_ROLE.CAPTAIN,
        status: PLAYER_STATUS.ACCEPTED,
        fundsHeld: (isWager && Number(entryUsdc) > 0) ? 1 : 0,
      });

      // Set challenge acceptor
      challengeRepo.setAcceptor(challengeId, user.id);

      // Update status to in_progress
      challengeRepo.updateStatus(challengeId, CHALLENGE_STATUS.IN_PROGRESS);

      // Transfer ALL players' held funds to escrow
      if (isWager && Number(entryUsdc) > 0) {
        const allPlayers = challengePlayerRepo.findByChallengeId(challengeId);
        for (const player of allPlayers) {
          if (player.funds_held) {
            try {
              await escrowManager.transferToEscrow(player.user_id, entryUsdc, challengeId);
            } catch (err) {
              console.error(`[ChallengeAccept] Failed to transfer escrow for player ${player.user_id}:`, err.message);
            }
          }
        }
      }

      // Create match channels
      await matchService.createMatchChannels(interaction.client, challenge);

      // Edit the challenge board message to show "ACCEPTED" and disable the button
      await disableBoardMessage(interaction.client, challenge);

      return interaction.editReply({
        content: `You have accepted Challenge #${challengeId}! Match channels have been created. Good luck!`,
      });
    } catch (err) {
      console.error(`[ChallengeAccept] Error accepting 1v1 challenge #${challengeId}:`, err);
      return interaction.editReply({
        content: 'Something went wrong accepting the challenge. Please try again.',
      });
    }
  }

  // Team games (2v2+) — need to select teammates first
  acceptFlows.set(discordId, { challengeId, teammates: [] });

  const teammatesNeeded = challenge.team_size - 1;
  const selectRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(`select_opponents_${challengeId}`)
      .setPlaceholder(`Select ${teammatesNeeded} teammate(s)`)
      .setMinValues(teammatesNeeded)
      .setMaxValues(teammatesNeeded),
  );

  return interaction.reply({
    content: `**Select your teammates for Challenge #${challengeId}:**\n\nTeam size: **${challenge.team_size}v${challenge.team_size}** — Pick **${teammatesNeeded}** teammate(s).`,
    components: [selectRow],
    ephemeral: true,
  });
}

/**
 * Handle user select menu interactions for opponent teammate selection.
 * customId format: select_opponents_${challengeId}
 */
async function handleUserSelect(interaction) {
  const customId = interaction.customId;
  const challengeId = parseInt(customId.replace('select_opponents_', ''), 10);
  const discordId = interaction.user.id;

  if (isNaN(challengeId)) {
    return interaction.reply({ content: 'Invalid challenge.', ephemeral: true });
  }

  // Get the flow from acceptFlows
  const flow = acceptFlows.get(discordId);
  if (!flow || flow.challengeId !== challengeId) {
    return interaction.reply({
      content: 'Session expired. Please click "Accept Challenge" again.',
      ephemeral: true,
    });
  }

  const selectedDiscordIds = interaction.values; // Array of Discord user IDs
  flow.teammates = selectedDiscordIds;

  await interaction.deferUpdate();

  try {
    // Re-fetch the challenge to ensure it's still open
    const challenge = challengeRepo.findById(challengeId);
    if (!challenge || challenge.status !== CHALLENGE_STATUS.OPEN) {
      acceptFlows.delete(discordId);
      return interaction.editReply({
        content: 'This challenge is no longer available.',
        components: [],
      });
    }

    // Validate: none of the selected teammates are already in the challenge
    for (const teammateDiscordId of selectedDiscordIds) {
      const teammateUser = userRepo.findByDiscordId(teammateDiscordId);
      if (teammateUser) {
        const existing = challengePlayerRepo.findByChallengeAndUser(challengeId, teammateUser.id);
        if (existing) {
          acceptFlows.delete(discordId);
          return interaction.editReply({
            content: `<@${teammateDiscordId}> is already part of this challenge. Please try again with different teammates.`,
            components: [],
          });
        }
      }
    }

    // Check that selected teammates are not the acceptor themselves
    if (selectedDiscordIds.includes(discordId)) {
      acceptFlows.delete(discordId);
      return interaction.editReply({
        content: 'You cannot select yourself as a teammate.',
        components: [],
      });
    }

    const user = userRepo.findByDiscordId(discordId);
    if (!user) {
      acceptFlows.delete(discordId);
      return interaction.editReply({
        content: 'You need to complete onboarding first.',
        components: [],
      });
    }

    const isWager = challenge.type === CHALLENGE_TYPE.WAGER;
    const entryUsdc = challenge.entry_amount_usdc;

    // Check acceptor's balance and hold funds (if wager)
    if (isWager && Number(entryUsdc) > 0) {
      if (!escrowManager.canAfford(user.id, entryUsdc)) {
        acceptFlows.delete(discordId);
        return interaction.editReply({
          content: `Insufficient balance. You need **${formatUsdc(entryUsdc)} USDC** to accept this wager.`,
          components: [],
        });
      }

      const held = escrowManager.holdFunds(user.id, entryUsdc, challengeId);
      if (!held) {
        acceptFlows.delete(discordId);
        return interaction.editReply({
          content: 'Failed to hold funds. Please try again.',
          components: [],
        });
      }
    }

    // Add acceptor as team 2 captain (accepted, funds_held)
    challengePlayerRepo.create({
      challengeId,
      userId: user.id,
      team: 2,
      role: PLAYER_ROLE.CAPTAIN,
      status: PLAYER_STATUS.ACCEPTED,
      fundsHeld: (isWager && Number(entryUsdc) > 0) ? 1 : 0,
    });

    // Add teammates as team 2 pending players
    for (const teammateDiscordId of selectedDiscordIds) {
      const teammateUser = userRepo.findByDiscordId(teammateDiscordId);
      if (teammateUser) {
        challengePlayerRepo.create({
          challengeId,
          userId: teammateUser.id,
          team: 2,
          role: PLAYER_ROLE.PLAYER,
          status: PLAYER_STATUS.PENDING,
        });
      } else {
        console.warn(`[ChallengeAccept] Teammate ${teammateDiscordId} not found in DB (not onboarded)`);
      }
    }

    // Set challenge status to 'accepted' (waiting for opponent teammates)
    challengeRepo.updateStatus(challengeId, CHALLENGE_STATUS.ACCEPTED);

    // Set challenge acceptor
    challengeRepo.setAcceptor(challengeId, user.id);

    // Notify opponent teammates using the same pattern as team 1 notifications
    // We need the guild to create notification channels
    const guild = interaction.guild;
    if (guild) {
      // Refresh challenge record to get updated status
      const updatedChallenge = challengeRepo.findById(challengeId);
      await notifyTeam2Teammates(guild, updatedChallenge || challenge);
    }

    // Clean up acceptFlows
    acceptFlows.delete(discordId);

    // Edit the challenge board message to show "ACCEPTED" and disable the button
    await disableBoardMessage(interaction.client, challenge);

    // Reply to acceptor confirming
    const teammatesMention = selectedDiscordIds.map(id => `<@${id}>`).join(', ');
    return interaction.editReply({
      content: [
        `**Challenge #${challengeId} accepted!**`,
        '',
        `Your teammates (${teammatesMention}) have been notified.`,
        'Once all teammates accept, the match will begin and channels will be created.',
      ].join('\n'),
      components: [],
    });
  } catch (err) {
    console.error(`[ChallengeAccept] Error in team accept flow for challenge #${challengeId}:`, err);
    acceptFlows.delete(discordId);
    return interaction.editReply({
      content: 'Something went wrong. Please try again.',
      components: [],
    });
  }
}

/**
 * Notify team 2 pending teammates about the challenge invitation.
 * Reuses the same private channel + accept/decline button pattern as team 1.
 *
 * @param {import('discord.js').Guild} guild - The Discord guild.
 * @param {object} challenge - The challenge DB record.
 */
async function notifyTeam2Teammates(guild, challenge) {
  const channelService = require('../services/channelService');
  const { GAME_MODES, TIMERS, CHALLENGE_TYPE: CT } = require('../config/constants');

  const players = challengePlayerRepo.findByChallengeAndTeam(challenge.id, 2);
  const pendingPlayers = players.filter(p => p.status === PLAYER_STATUS.PENDING);

  for (const player of pendingPlayers) {
    try {
      const user = userRepo.findById(player.user_id);
      if (!user) {
        console.error(`[ChallengeAccept] No user found for player ${player.user_id}`);
        continue;
      }

      const playerDiscordId = user.discord_id;

      // Resolve the Discord user to get their username for the channel name
      let username = playerDiscordId;
      try {
        const discordMember = await guild.members.fetch(playerDiscordId);
        username = discordMember.user.username;
      } catch {
        // Fall back to discord ID if we can't fetch the member
      }

      // Create a private channel for this teammate
      const channel = await channelService.createPrivateChannel(
        guild,
        `invite-${username}`,
        [playerDiscordId],
      );

      // Store the channel ID on the challenge_player record
      challengePlayerRepo.setNotificationChannel(player.id, channel.id);

      // Build challenge details
      const isWager = challenge.type === CT.WAGER;
      const modeInfo = GAME_MODES[challenge.game_modes];
      const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;

      const acceptor = userRepo.findById(challenge.acceptor_user_id);
      const acceptorMention = acceptor ? `<@${acceptor.discord_id}>` : 'Unknown';

      const description = [
        `${acceptorMention} has invited you to join their team!`,
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

      // Build buttons — same customIds as team 1 so teammateResponse.js handles them
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
        content: `<@${playerDiscordId}>`,
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
      const challengeServiceRef = require('../services/challengeService');
      const timerKey = `${challenge.id}_${player.id}`;

      const timer = setTimeout(async () => {
        try {
          // Re-check the player's current status in case they already responded
          const currentPlayer = challengePlayerRepo.findById(player.id);
          if (!currentPlayer || currentPlayer.status !== PLAYER_STATUS.PENDING) return;

          // Treat as decline
          challengePlayerRepo.updateStatus(player.id, PLAYER_STATUS.DECLINED);
          console.log(`[ChallengeAccept] Teammate ${player.user_id} timed out for challenge ${challenge.id}`);

          // Notify in the channel before deleting
          try {
            await channel.send('You did not respond in time. The invitation has expired and the challenge has been cancelled.');
          } catch {
            // Channel may already be deleted
          }

          // Cancel the entire challenge
          await challengeServiceRef.cancelChallenge(challenge.id);

          // Delete the channel after a short delay
          setTimeout(async () => {
            try {
              const channelSvc = require('../services/channelService');
              await channelSvc.deleteChannel(channel);
            } catch {
              // Channel may already be gone
            }
          }, 5000);
        } catch (err) {
          console.error(`[ChallengeAccept] Error handling teammate timeout:`, err);
        }
      }, TIMERS.TEAMMATE_ACCEPT);

      // Register the timer with challengeService so it can be cleared
      // We use the same clearTeammateTimer approach
      // Store locally for now — the timer will self-clean on fire
      console.log(`[ChallengeAccept] Notified team 2 teammate ${playerDiscordId} in channel ${channel.id} for challenge ${challenge.id}`);
    } catch (err) {
      console.error(`[ChallengeAccept] Error notifying team 2 teammate ${player.user_id}:`, err);
    }
  }
}

/**
 * Edit the challenge board message to show it has been accepted and disable the button.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {object} challenge - The challenge DB record.
 */
async function disableBoardMessage(client, challenge) {
  if (!challenge.challenge_message_id || !challenge.challenge_channel_id) return;

  try {
    const boardChannel = client.channels.cache.get(challenge.challenge_channel_id);
    if (!boardChannel) return;

    const message = await boardChannel.messages.fetch(challenge.challenge_message_id);
    if (!message) return;

    // Update the embed to show "ACCEPTED"
    const embed = challengeEmbed(challenge, !!challenge.is_anonymous);
    embed.setTitle(`[ACCEPTED] ${embed.data.title}`);
    embed.setColor(0x95a5a6); // Gray out

    // Disable the button
    const disabledRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`challenge_accept_${challenge.id}`)
        .setLabel('Accepted')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
    );

    await message.edit({
      embeds: [embed],
      components: [disabledRow],
    });
  } catch (err) {
    console.error(`[ChallengeAccept] Failed to update board message for challenge #${challenge.id}:`, err.message);
  }
}

module.exports = { handleButton, handleUserSelect };
