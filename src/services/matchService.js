const { ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const matchRepo = require('../database/repositories/matchRepo');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const escrowManager = require('../solana/escrowManager');
const { privateTextOverwrites, privateVoiceOverwrites, votingChannelOverwrites, sharedOverwrites } = require('../utils/permissions');
const { formatUsdc } = require('../utils/embeds');
const { MATCH_STATUS, CHALLENGE_STATUS, CHALLENGE_TYPE, XP_WAGER_WIN, XP_WAGER_LOSS } = require('../config/constants');
const neatqueueService = require('./neatqueueService');

/**
 * Create match channels (team voice, team text, shared, voting) for a matched challenge.
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {object} challenge - The challenge DB record.
 * @returns {Promise<object>} The created match record.
 */
async function createMatchChannels(client, challenge) {
  // Get the guild — try from the challenge board channel first, then fallback to first guild
  let guild;
  if (challenge.challenge_channel_id) {
    const boardChannel = client.channels.cache.get(challenge.challenge_channel_id);
    if (boardChannel) {
      guild = boardChannel.guild;
    }
  }
  if (!guild) {
    const guildId = process.env.GUILD_ID;
    if (guildId) {
      guild = client.guilds.cache.get(guildId);
    }
    if (!guild) {
      guild = client.guilds.cache.first();
    }
  }

  if (!guild) {
    throw new Error('Could not resolve guild for match channel creation');
  }

  // Get all players for this challenge
  const allPlayers = challengePlayerRepo.findByChallengeId(challenge.id);
  const team1Players = allPlayers.filter(p => p.team === 1);
  const team2Players = allPlayers.filter(p => p.team === 2);

  // Map player user IDs to Discord IDs
  const team1DiscordIds = [];
  const team2DiscordIds = [];
  const allDiscordIds = [];
  const captainDiscordIds = [];

  for (const player of team1Players) {
    const user = userRepo.findById(player.user_id);
    if (user) {
      team1DiscordIds.push(user.discord_id);
      allDiscordIds.push(user.discord_id);
      if (player.role === 'captain') {
        captainDiscordIds.push(user.discord_id);
      }
    }
  }

  for (const player of team2Players) {
    const user = userRepo.findById(player.user_id);
    if (user) {
      team2DiscordIds.push(user.discord_id);
      allDiscordIds.push(user.discord_id);
      if (player.role === 'captain') {
        captainDiscordIds.push(user.discord_id);
      }
    }
  }

  // Create a Discord category for this match
  const category = await guild.channels.create({
    name: `Match #${challenge.id}`,
    type: ChannelType.GuildCategory,
    reason: 'Wager bot match category',
  });

  // Create team 1 text channel
  const team1Text = await guild.channels.create({
    name: 'team-1',
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: privateTextOverwrites(guild, team1DiscordIds),
    reason: 'Wager bot match channel',
  });

  // Create team 1 voice channel
  const team1Voice = await guild.channels.create({
    name: 'Team 1',
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: privateVoiceOverwrites(guild, team1DiscordIds),
    reason: 'Wager bot match channel',
  });

  // Create team 2 text channel
  const team2Text = await guild.channels.create({
    name: 'team-2',
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: privateTextOverwrites(guild, team2DiscordIds),
    reason: 'Wager bot match channel',
  });

  // Create team 2 voice channel
  const team2Voice = await guild.channels.create({
    name: 'Team 2',
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: privateVoiceOverwrites(guild, team2DiscordIds),
    reason: 'Wager bot match channel',
  });

  // Create shared text channel
  const sharedText = await guild.channels.create({
    name: 'shared-chat',
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: sharedOverwrites(guild, allDiscordIds),
    reason: 'Wager bot match channel',
  });

  // Create shared voice channel
  const sharedVoice = await guild.channels.create({
    name: 'Shared Voice',
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: sharedOverwrites(guild, allDiscordIds),
    reason: 'Wager bot match channel',
  });

  // Create voting channel (captains can view, only bot can send)
  const voteChannel = await guild.channels.create({
    name: 'vote',
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: votingChannelOverwrites(guild, captainDiscordIds),
    reason: 'Wager bot match voting channel',
  });

  // Create match record in DB
  const match = matchRepo.create({
    challengeId: challenge.id,
    categoryId: category.id,
  });

  // Store all channel IDs
  matchRepo.setChannels(match.id, {
    team1VoiceId: team1Voice.id,
    team1TextId: team1Text.id,
    team2VoiceId: team2Voice.id,
    team2TextId: team2Text.id,
    sharedVoiceId: sharedVoice.id,
    sharedTextId: sharedText.id,
    votingChannelId: voteChannel.id,
  });

  // Send "Report Win" button in the vote channel
  const { EmbedBuilder } = require('discord.js');
  const reportEmbed = new EmbedBuilder()
    .setTitle(`Match #${match.id} — Report Result`)
    .setColor(0xe67e22)
    .setDescription(
      'When the match is over, the winning captain should click **Report Win**.\n\n' +
      'The other captain will be asked to confirm or dispute the result.',
    )
    .setFooter({ text: 'Only team captains can report results.' });

  const reportRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`report_win_${match.id}`)
      .setLabel('Report Win')
      .setStyle(ButtonStyle.Success),
  );

  await voteChannel.send({
    embeds: [reportEmbed],
    components: [reportRow],
  });

  // Build match info for welcome messages
  const isWager = challenge.type === CHALLENGE_TYPE.WAGER;
  const potText = isWager ? `\nPot: **${formatUsdc(challenge.total_pot_usdc)} USDC**` : '';

  // Send welcome messages in team channels
  await team1Text.send({
    content: `**Welcome, Team 1!**\n\nYour match for Challenge #${challenge.id} is ready.${potText}\n\nUse this channel to coordinate with your team. When the match is over, both captains must vote on the result in the voting channel.`,
  });

  await team2Text.send({
    content: `**Welcome, Team 2!**\n\nYour match for Challenge #${challenge.id} is ready.${potText}\n\nUse this channel to coordinate with your team. When the match is over, both captains must vote on the result in the voting channel.`,
  });

  // Send welcome message in shared channel
  const team1Mentions = team1DiscordIds.map(id => `<@${id}>`).join(', ');
  const team2Mentions = team2DiscordIds.map(id => `<@${id}>`).join(', ');

  await sharedText.send({
    content: [
      `**Match #${match.id} — Challenge #${challenge.id}**`,
      '',
      `**Team 1:** ${team1Mentions}`,
      `**Team 2:** ${team2Mentions}`,
      potText,
      '',
      'Good luck! When the match is complete, captains should head to the voting channel to confirm the result.',
    ].join('\n'),
  });

  // Update challenge status to in_progress
  challengeRepo.updateStatus(challenge.id, CHALLENGE_STATUS.IN_PROGRESS);

  console.log(`[MatchService] Created match #${match.id} channels for challenge #${challenge.id}`);
  return match;
}

/**
 * Start a match — transfer held funds to escrow and create match channels.
 * Called when all opponent teammates have accepted (team games) or immediately (1v1).
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {number} challengeId - The challenge ID.
 * @returns {Promise<object>} The match record.
 */
async function startMatch(client, challengeId) {
  const challenge = challengeRepo.findById(challengeId);
  if (!challenge) {
    throw new Error(`Challenge ${challengeId} not found`);
  }

  // Transfer all held funds to escrow for each player (wager challenges only)
  if (challenge.type === CHALLENGE_TYPE.WAGER && Number(challenge.entry_amount_usdc) > 0) {
    const allPlayers = challengePlayerRepo.findByChallengeId(challengeId);
    for (const player of allPlayers) {
      if (player.funds_held) {
        try {
          await escrowManager.transferToEscrow(
            player.user_id,
            challenge.entry_amount_usdc,
            challengeId,
          );
        } catch (err) {
          console.error(`[MatchService] Failed to transfer funds for player ${player.user_id}:`, err.message);
          // Continue with other players — partial failure handling could be enhanced
        }
      }
    }
  }

  // Create match channels
  const match = await createMatchChannels(client, challenge);

  // Update challenge status to in_progress (createMatchChannels already does this, but be explicit)
  challengeRepo.updateStatus(challengeId, CHALLENGE_STATUS.IN_PROGRESS);

  // Update match status to active
  matchRepo.updateStatus(match.id, MATCH_STATUS.ACTIVE);

  // Start 24h inactivity timer
  const timerService = require('./timerService');
  const { TIMERS } = require('../config/constants');
  timerService.createTimer('match_inactivity', match.id, TIMERS.MATCH_INACTIVITY);

  console.log(`[MatchService] Match #${match.id} started for challenge #${challengeId}`);
  return match;
}

/**
 * Resolve a match after captain voting.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {number} matchId - The match ID.
 * @param {number} winningTeam - The winning team number (1 or 2).
 */
async function resolveMatch(client, matchId, winningTeam) {
  const match = matchRepo.findById(matchId);
  if (!match) {
    throw new Error(`Match ${matchId} not found`);
  }

  const challenge = challengeRepo.findById(match.challenge_id);
  if (!challenge) {
    throw new Error(`Challenge ${match.challenge_id} not found for match ${matchId}`);
  }

  // Get winning team players
  const winningPlayers = challengePlayerRepo.findByChallengeAndTeam(match.challenge_id, winningTeam);
  const winnerUserIds = winningPlayers.map(p => p.user_id);

  // Disburse winnings (wager challenges only)
  if (challenge.type === CHALLENGE_TYPE.WAGER && Number(challenge.total_pot_usdc) > 0) {
    try {
      await escrowManager.disburseWinnings(match.challenge_id, winnerUserIds, challenge.total_pot_usdc);
      console.log(`[MatchService] Winnings disbursed for match #${matchId}, team ${winningTeam} won`);
    } catch (err) {
      console.error(`[MatchService] Failed to disburse winnings for match #${matchId}:`, err.message);
    }
  }

  // Update match: set winner and status to completed
  matchRepo.setWinner(matchId, winningTeam);
  matchRepo.updateStatus(matchId, MATCH_STATUS.COMPLETED);

  // Update challenge status to completed
  challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.COMPLETED);

  // Award XP and track stats
  const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
  const losingTeam = winningTeam === 1 ? 2 : 1;
  const losingPlayers = allPlayers.filter(p => p.team === losingTeam);
  const isWagerMatch = challenge.type === CHALLENGE_TYPE.WAGER && Number(challenge.total_pot_usdc) > 0;

  // Compute per-player net earnings for wager matches
  let perPlayerEarnings = '0';
  if (isWagerMatch) {
    const totalPot = BigInt(challenge.total_pot_usdc);
    const winnerCount = BigInt(winningPlayers.length);
    const entryAmount = BigInt(challenge.entry_amount_usdc);
    const share = totalPot / winnerCount;
    perPlayerEarnings = (share - entryAmount).toString();
  }

  // Winners
  for (const player of winningPlayers) {
    try {
      userRepo.addXp(player.user_id, XP_WAGER_WIN);
      userRepo.addWin(player.user_id);
      if (isWagerMatch) {
        userRepo.addEarnings(player.user_id, perPlayerEarnings);
        userRepo.addWagered(player.user_id, challenge.entry_amount_usdc);
      }
    } catch (err) {
      console.error(`[MatchService] Failed to update stats for winner ${player.user_id}:`, err.message);
    }

    // Sync XP to NeatQueue (fire and forget)
    if (neatqueueService.isConfigured()) {
      const winUser = userRepo.findById(player.user_id);
      if (winUser) {
        neatqueueService.addPoints(winUser.discord_id, XP_WAGER_WIN).catch(err => {
          console.error(`[MatchService] NeatQueue addPoints failed for winner ${winUser.discord_id}:`, err.message);
        });
      }
    }
  }

  // Losers
  for (const player of losingPlayers) {
    try {
      userRepo.addXp(player.user_id, XP_WAGER_LOSS);
      userRepo.addLoss(player.user_id);
      if (isWagerMatch) {
        userRepo.addWagered(player.user_id, challenge.entry_amount_usdc);
      }
    } catch (err) {
      console.error(`[MatchService] Failed to update stats for loser ${player.user_id}:`, err.message);
    }

    // Sync XP to NeatQueue (fire and forget)
    if (neatqueueService.isConfigured()) {
      const loseUser = userRepo.findById(player.user_id);
      if (loseUser) {
        neatqueueService.addPoints(loseUser.discord_id, XP_WAGER_LOSS).catch(err => {
          console.error(`[MatchService] NeatQueue addPoints failed for loser ${loseUser.discord_id}:`, err.message);
        });
      }
    }
  }

  // Send result message in shared channel
  if (match.shared_text_id) {
    try {
      const sharedChannel = client.channels.cache.get(match.shared_text_id);
      if (sharedChannel) {
        const isWager = challenge.type === CHALLENGE_TYPE.WAGER;
        const potText = isWager ? `\nPot of **${formatUsdc(challenge.total_pot_usdc)} USDC** has been distributed to the winners.` : '';

        await sharedChannel.send({
          content: [
            `**Match #${matchId} Complete!**`,
            '',
            `**Winner: Team ${winningTeam}**`,
            potText,
            '',
            'These channels will be cleaned up in 5 minutes. GG!',
          ].join('\n'),
        });
      }
    } catch (err) {
      console.error(`[MatchService] Failed to send result message for match #${matchId}:`, err.message);
    }
  }

  // Post result to the results channel
  const resultsChannelId = process.env.RESULTS_CHANNEL_ID;
  if (resultsChannelId) {
    try {
      const resultsChannel = client.channels.cache.get(resultsChannelId);
      if (resultsChannel) {
        const { EmbedBuilder } = require('discord.js');
        const { GAME_MODES } = require('../config/constants');

        const modeInfo = GAME_MODES[challenge.game_modes];
        const modeLabel = modeInfo ? modeInfo.label : challenge.game_modes;
        const totalPot = Number(challenge.total_pot_usdc);
        const entryAmount = Number(challenge.entry_amount_usdc);
        const perPlayerPayout = totalPot > 0 ? totalPot / winningPlayers.length : 0;

        const perPlayerProfit = perPlayerPayout - entryAmount; // actual gain = payout - their entry
        const winnerLines = [];
        for (const p of winningPlayers) {
          const u = userRepo.findById(p.user_id);
          if (u) winnerLines.push(`<@${u.discord_id}> ${u.cod_ign ? `(${u.cod_ign})` : ''} — **+${formatUsdc(perPlayerProfit)} USDC** +350 XP`);
        }
        const loserLines = [];
        for (const p of losingPlayers) {
          const u = userRepo.findById(p.user_id);
          if (u) loserLines.push(`<@${u.discord_id}> ${u.cod_ign ? `(${u.cod_ign})` : ''} — **-${formatUsdc(entryAmount)} USDC**`);
        }

        const resultEmbed = new EmbedBuilder()
          .setTitle(`Match #${matchId} — Result`)
          .setColor(0x2ecc71)
          .setDescription([
            `**Team ${winningTeam} wins! Total Pot: ${formatUsdc(totalPot)} USDC**`,
            '',
            `**Winners**`,
            ...winnerLines,
            '',
            `**Losers**`,
            ...loserLines,
          ].join('\n'))
          .addFields(
            { name: 'Mode', value: modeLabel, inline: true },
            { name: 'Series', value: `Best of ${challenge.series_length}`, inline: true },
            { name: 'Team Size', value: `${challenge.team_size}v${challenge.team_size}`, inline: true },
            { name: 'Entry', value: `${formatUsdc(entryAmount)} per player`, inline: true },
          )
          .setTimestamp();

        await resultsChannel.send({ embeds: [resultEmbed] });
      }
    } catch (err) {
      console.error(`[MatchService] Failed to post result for match #${matchId}:`, err.message);
    }
  }

  // Schedule channel cleanup after 5 minutes
  setTimeout(() => {
    cleanupChannels(client, matchId).catch(err => {
      console.error(`[MatchService] Error during scheduled cleanup for match #${matchId}:`, err.message);
    });
  }, 5 * 60 * 1000);

  console.log(`[MatchService] Match #${matchId} resolved. Team ${winningTeam} wins.`);
}

/**
 * Clean up match channels after a match is completed or cancelled.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {number} matchId - The match ID.
 */
async function cleanupChannels(client, matchId) {
  const match = matchRepo.findById(matchId);
  if (!match) {
    console.error(`[MatchService] Match ${matchId} not found for cleanup`);
    return;
  }

  const channelIds = [
    match.team1_text_id,
    match.team1_voice_id,
    match.team2_text_id,
    match.team2_voice_id,
    match.shared_text_id,
    match.shared_voice_id,
    match.voting_channel_id,
  ];

  // Delete all channels
  for (const channelId of channelIds) {
    if (!channelId) continue;
    try {
      const channel = client.channels.cache.get(channelId);
      if (channel && channel.deletable) {
        await channel.delete('Wager bot match cleanup');
      }
    } catch (err) {
      console.error(`[MatchService] Failed to delete channel ${channelId}:`, err.message);
    }
  }

  // Delete the category
  if (match.category_id) {
    try {
      const category = client.channels.cache.get(match.category_id);
      if (category && category.deletable) {
        await category.delete('Wager bot match cleanup');
      }
    } catch (err) {
      console.error(`[MatchService] Failed to delete category ${match.category_id}:`, err.message);
    }
  }

  console.log(`[MatchService] Cleaned up channels for match #${matchId}`);
}

module.exports = { createMatchChannels, startMatch, resolveMatch, cleanupChannels };
