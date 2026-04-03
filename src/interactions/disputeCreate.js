const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
} = require('discord.js');
const matchRepo = require('../database/repositories/matchRepo');
const challengeRepo = require('../database/repositories/challengeRepo');
const challengePlayerRepo = require('../database/repositories/challengePlayerRepo');
const userRepo = require('../database/repositories/userRepo');
const { MATCH_STATUS, CHALLENGE_STATUS, GAME_MODES } = require('../config/constants');
const { formatUsdc } = require('../utils/embeds');
const { sharedOverwrites, privateTextOverwrites, privateVoiceOverwrites } = require('../utils/permissions');
const escrowManager = require('../solana/escrowManager');
const { logAdminAction } = require('../utils/adminAudit');

/**
 * Handle the "Create Dispute" button from the lobby panel.
 * Shows the user's recent matches to pick from.
 */
async function handleCreateDispute(interaction) {
  const discordId = interaction.user.id;
  const user = userRepo.findByDiscordId(discordId);
  if (!user) {
    return interaction.reply({ content: 'You must be registered first.', ephemeral: true });
  }

  // Find recent matches this user was in (completed, active, or voting — last 10)
  const db = require('../database/db');
  const recentMatches = db.prepare(`
    SELECT m.*, c.game_modes, c.series_length, c.team_size, c.entry_amount_usdc, c.total_pot_usdc, c.type
    FROM matches m
    JOIN challenges c ON m.challenge_id = c.id
    JOIN challenge_players cp ON cp.challenge_id = c.id
    WHERE cp.user_id = ? AND m.status IN ('completed', 'active', 'voting', 'disputed')
    ORDER BY m.created_at DESC
    LIMIT 10
  `).all(user.id);

  if (recentMatches.length === 0) {
    return interaction.reply({
      content: 'You have no recent matches to dispute.',
      ephemeral: true,
    });
  }

  // Build buttons for each match (max 5 per row, max 2 rows = 10 matches)
  const rows = [];
  for (let i = 0; i < recentMatches.length; i += 5) {
    const chunk = recentMatches.slice(i, i + 5);
    const row = new ActionRowBuilder().addComponents(
      ...chunk.map(m => {
        const modeInfo = GAME_MODES[m.game_modes];
        const modeLabel = modeInfo ? modeInfo.label : m.game_modes;
        const pot = Number(m.total_pot_usdc) > 0 ? ` ${formatUsdc(m.total_pot_usdc)}` : '';
        return new ButtonBuilder()
          .setCustomId(`dispute_select_${m.id}`)
          .setLabel(`#${m.id} ${modeLabel}${pot}`)
          .setStyle(m.status === 'disputed' ? ButtonStyle.Secondary : ButtonStyle.Danger);
      }),
    );
    rows.push(row);
  }

  const embed = new EmbedBuilder()
    .setTitle('Create Dispute')
    .setColor(0xe74c3c)
    .setDescription('Select the match you want to dispute:');

  return interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
}

/**
 * Handle match selection for dispute — create the dispute category and channels.
 */
async function handleDisputeSelect(interaction) {
  const matchId = parseInt(interaction.customId.replace('dispute_select_', ''), 10);
  if (isNaN(matchId)) {
    return interaction.reply({ content: 'Invalid match.', ephemeral: true });
  }

  const match = matchRepo.findById(matchId);
  if (!match) {
    return interaction.reply({ content: 'Match not found.', ephemeral: true });
  }

  // Don't allow duplicate disputes
  if (match.status === MATCH_STATUS.DISPUTED) {
    return interaction.reply({ content: 'This match is already being disputed.', ephemeral: true });
  }

  await interaction.deferUpdate();

  try {
    // Mark as disputed
    matchRepo.updateStatus(matchId, MATCH_STATUS.DISPUTED);
    challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.DISPUTED);

    const challenge = challengeRepo.findById(match.challenge_id);
    const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
    const team1Players = allPlayers.filter(p => p.team === 1);
    const team2Players = allPlayers.filter(p => p.team === 2);

    // Get Discord IDs
    const team1DiscordIds = [];
    const team2DiscordIds = [];
    const allDiscordIds = [];

    for (const p of team1Players) {
      const u = userRepo.findById(p.user_id);
      if (u) { team1DiscordIds.push(u.discord_id); allDiscordIds.push(u.discord_id); }
    }
    for (const p of team2Players) {
      const u = userRepo.findById(p.user_id);
      if (u) { team2DiscordIds.push(u.discord_id); allDiscordIds.push(u.discord_id); }
    }

    const guild = interaction.guild;

    // Create dispute category
    const category = await guild.channels.create({
      name: `Dispute #${matchId}`,
      type: ChannelType.GuildCategory,
      reason: 'Wager bot dispute',
    });

    // Team 1 channels
    const team1Text = await guild.channels.create({
      name: 'team-1',
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: privateTextOverwrites(guild, team1DiscordIds),
    });

    const team1Voice = await guild.channels.create({
      name: 'Team 1 Voice',
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: privateVoiceOverwrites(guild, team1DiscordIds),
    });

    // Team 2 channels
    const team2Text = await guild.channels.create({
      name: 'team-2',
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: privateTextOverwrites(guild, team2DiscordIds),
    });

    const team2Voice = await guild.channels.create({
      name: 'Team 2 Voice',
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: privateVoiceOverwrites(guild, team2DiscordIds),
    });

    // Shared channels (both teams + admins)
    const disputeChat = await guild.channels.create({
      name: 'dispute-chat',
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: sharedOverwrites(guild, allDiscordIds),
    });

    const disputeVoice = await guild.channels.create({
      name: 'Dispute Call',
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: sharedOverwrites(guild, allDiscordIds),
    });

    // Build match info for the dispute chat
    const modeInfo = GAME_MODES[challenge?.game_modes];
    const modeLabel = modeInfo ? modeInfo.label : (challenge?.game_modes || 'N/A');
    const potText = challenge && Number(challenge.total_pot_usdc) > 0
      ? `**Pot:** ${formatUsdc(challenge.total_pot_usdc)} USDC`
      : '';

    const adminRoleId = process.env.ADMIN_ROLE_ID;
    const adminPing = adminRoleId ? `<@&${adminRoleId}>` : 'Admins';
    const allPings = allDiscordIds.map(id => `<@${id}>`).join(' ');

    const disputeEmbed = new EmbedBuilder()
      .setTitle(`Dispute — Match #${matchId}`)
      .setColor(0xe74c3c)
      .setDescription([
        `**Match Details**`,
        `Mode: ${modeLabel} | Series: Bo${challenge?.series_length || '?'} | ${challenge?.team_size || '?'}v${challenge?.team_size || '?'}`,
        potText,
        '',
        `**Team 1:** ${team1DiscordIds.map(id => `<@${id}>`).join(', ')}`,
        `**Team 2:** ${team2DiscordIds.map(id => `<@${id}>`).join(', ')}`,
        '',
        'Submit evidence (screenshots, recordings) in this channel.',
        'Join the voice call to discuss with admins.',
      ].join('\n'));

    // Evidence submit button
    const evidenceRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`submit_evidence_${matchId}`)
        .setLabel('Submit Evidence')
        .setStyle(ButtonStyle.Primary),
    );

    await disputeChat.send({
      content: `${allPings}\n\n${adminPing} — a dispute has been created for Match #${matchId}.`,
      embeds: [disputeEmbed],
      components: [evidenceRow],
    });

    // Admin resolve panel
    const adminRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`admin_resolve_team1_${matchId}`)
        .setLabel('Team 1 Wins')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`admin_resolve_team2_${matchId}`)
        .setLabel('Team 2 Wins')
        .setStyle(ButtonStyle.Danger),
    );

    await disputeChat.send({
      content: `**Admin Panel** — After reviewing evidence, resolve the dispute:`,
      components: [adminRow],
    });

    // Store dispute category ID on the match for cleanup later
    const db = require('../database/db');
    db.prepare('UPDATE matches SET dispute_category_id = ? WHERE id = ?').run(category.id, matchId);

    await interaction.editReply({
      content: `Dispute created for Match #${matchId}. Head to <#${disputeChat.id}>.`,
      embeds: [],
      components: [],
    });

    console.log(`[Dispute] Created dispute category for match #${matchId}`);
  } catch (err) {
    console.error(`[Dispute] Error creating dispute for match #${matchId}:`, err);
    await interaction.editReply({
      content: 'Failed to create dispute. Please contact an administrator.',
      embeds: [],
      components: [],
    });
  }
}

/**
 * Handle admin "Dispute Handled" — clean up dispute channels after resolution.
 * Called after admin confirms which team wins in matchResult.js.
 */
async function cleanupDisputeChannels(client, matchId) {
  const match = matchRepo.findById(matchId);
  if (!match || !match.dispute_category_id) return;

  const guild = client.guilds.cache.get(process.env.GUILD_ID) || client.guilds.cache.first();
  if (!guild) return;

  // Delete all channels in the dispute category
  try {
    const category = guild.channels.cache.get(match.dispute_category_id);
    if (category) {
      const children = guild.channels.cache.filter(ch => ch.parentId === category.id);
      for (const [, ch] of children) {
        try { await ch.delete('Dispute resolved'); } catch { /* */ }
      }
      try { await category.delete('Dispute resolved'); } catch { /* */ }
    }
  } catch (err) {
    console.error(`[Dispute] Failed to clean up channels for match #${matchId}:`, err.message);
  }
}

module.exports = { handleCreateDispute, handleDisputeSelect, cleanupDisputeChannels };
