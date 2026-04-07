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

/**
 * Handle the "Create Dispute" button from the lobby panel.
 */
async function handleCreateDispute(interaction) {
  const discordId = interaction.user.id;
  const user = userRepo.findByDiscordId(discordId);
  if (!user) {
    return interaction.reply({ content: 'You must be registered first.', ephemeral: true });
  }

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
    return interaction.reply({ content: 'You have no recent matches to dispute.', ephemeral: true });
  }

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
 * Handle match selection — show confirmation before creating dispute.
 */
async function handleDisputeSelect(interaction) {
  const matchId = parseInt(interaction.customId.replace('dispute_select_', ''), 10);
  if (isNaN(matchId)) return interaction.reply({ content: 'Invalid match.', ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true });

  if (match.status === MATCH_STATUS.DISPUTED) {
    return interaction.reply({ content: 'This match is already being disputed.', ephemeral: true });
  }

  const discordId = interaction.user.id;
  const user = userRepo.findByDiscordId(discordId);
  if (!user) return interaction.reply({ content: 'You must be registered.', ephemeral: true });

  const playerRecord = challengePlayerRepo.findByChallengeAndUser(match.challenge_id, user.id);
  if (!playerRecord) return interaction.reply({ content: 'You are not a player in this match.', ephemeral: true });

  const confirmEmbed = new EmbedBuilder()
    .setTitle('Confirm Dispute')
    .setColor(0xe74c3c)
    .setDescription(`Are you sure you want to dispute **Match #${matchId}**?\n\nThis will create dispute channels and notify staff.`);

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`dispute_confirm_${matchId}`).setLabel('Yes, Dispute').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`dispute_nevermind`).setLabel('Nevermind').setStyle(ButtonStyle.Secondary),
  );

  return interaction.update({ embeds: [confirmEmbed], components: [confirmRow] });
}

/**
 * Handle confirmed dispute — create dispute channels.
 */
async function handleDisputeConfirm(interaction) {
  const matchId = parseInt(interaction.customId.replace('dispute_confirm_', ''), 10);
  if (isNaN(matchId)) return interaction.reply({ content: 'Invalid match.', ephemeral: true });

  const match = matchRepo.findById(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true });
  if (match.status === MATCH_STATUS.DISPUTED) {
    return interaction.update({ content: 'Already disputed.', embeds: [], components: [] });
  }

  await interaction.update({ content: 'Creating dispute channels...', embeds: [], components: [] });

  try {
    matchRepo.updateStatus(matchId, MATCH_STATUS.DISPUTED);
    challengeRepo.updateStatus(match.challenge_id, CHALLENGE_STATUS.DISPUTED);

    const challenge = challengeRepo.findById(match.challenge_id);
    const allPlayers = challengePlayerRepo.findByChallengeId(match.challenge_id);
    const team1Players = allPlayers.filter(p => p.team === 1);
    const team2Players = allPlayers.filter(p => p.team === 2);

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

    const category = await guild.channels.create({
      name: `Dispute #${matchId}`,
      type: ChannelType.GuildCategory,
      reason: 'Wager bot dispute',
    });

    await guild.channels.create({ name: 'team-1', type: ChannelType.GuildText, parent: category.id, permissionOverwrites: privateTextOverwrites(guild, team1DiscordIds, true) });
    await guild.channels.create({ name: 'Team 1 Voice', type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: privateVoiceOverwrites(guild, team1DiscordIds, true) });
    await guild.channels.create({ name: 'team-2', type: ChannelType.GuildText, parent: category.id, permissionOverwrites: privateTextOverwrites(guild, team2DiscordIds, true) });
    await guild.channels.create({ name: 'Team 2 Voice', type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: privateVoiceOverwrites(guild, team2DiscordIds, true) });

    const disputeChat = await guild.channels.create({ name: 'dispute-chat', type: ChannelType.GuildText, parent: category.id, permissionOverwrites: sharedOverwrites(guild, allDiscordIds) });
    await guild.channels.create({ name: 'Dispute Call', type: ChannelType.GuildVoice, parent: category.id, permissionOverwrites: sharedOverwrites(guild, allDiscordIds) });

    const modeInfo = GAME_MODES[challenge?.game_modes];
    const modeLabel = modeInfo ? modeInfo.label : (challenge?.game_modes || 'N/A');
    const potText = challenge && Number(challenge.total_pot_usdc) > 0
      ? `**Pot:** ${formatUsdc(challenge.total_pot_usdc)} USDC` : '';

    const adminRoleId = process.env.ADMIN_ROLE_ID;
    const wagerStaffId = process.env.WAGER_STAFF_ROLE_ID;
    const xpStaffId = process.env.XP_STAFF_ROLE_ID;
    const rolePings = [];
    if (wagerStaffId) rolePings.push(`<@&${wagerStaffId}>`);
    if (xpStaffId) rolePings.push(`<@&${xpStaffId}>`);
    if (adminRoleId) rolePings.push(`<@&${adminRoleId}>`);
    const staffPing = rolePings.length > 0 ? rolePings.join(' ') : 'Staff';
    const allPings = allDiscordIds.map(id => `<@${id}>`).join(' ');

    const disputeEmbed = new EmbedBuilder()
      .setTitle(`Dispute — Match #${matchId}`)
      .setColor(0xe74c3c)
      .setDescription([
        '**Match Details**',
        `Mode: ${modeLabel} | Series: Bo${challenge?.series_length || '?'} | ${challenge?.team_size || '?'}v${challenge?.team_size || '?'}`,
        potText,
        '',
        `**Team 1:** ${team1DiscordIds.map(id => `<@${id}>`).join(', ')}`,
        `**Team 2:** ${team2DiscordIds.map(id => `<@${id}>`).join(', ')}`,
        '',
        '**Post your evidence directly in this channel** — screenshots, photos, videos, links, text.',
        'Join the voice call to discuss with staff.',
      ].join('\n'));

    await disputeChat.send({
      content: `${allPings}\n\n${staffPing} — a dispute has been created for Match #${matchId}.`,
      embeds: [disputeEmbed],
    });

    const adminRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`admin_resolve_team1_${matchId}`).setLabel('Team 1 Wins').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`admin_resolve_team2_${matchId}`).setLabel('Team 2 Wins').setStyle(ButtonStyle.Danger),
    );

    await disputeChat.send({ content: '**Staff Panel** — After reviewing evidence, resolve:', components: [adminRow] });

    const db = require('../database/db');
    db.prepare('UPDATE matches SET dispute_category_id = ? WHERE id = ?').run(category.id, matchId);

    await interaction.followUp({
      content: `Dispute created for Match #${matchId}. Head to <#${disputeChat.id}>.`,
      ephemeral: true,
    });

    console.log(`[Dispute] Created dispute category for match #${matchId}`);
  } catch (err) {
    console.error(`[Dispute] Error creating dispute for match #${matchId}:`, err);
    await interaction.followUp({ content: 'Failed to create dispute. Contact an administrator.', ephemeral: true });
  }
}

/**
 * Clean up dispute channels after resolution.
 */
async function cleanupDisputeChannels(client, matchId) {
  const match = matchRepo.findById(matchId);
  if (!match || !match.dispute_category_id) return;

  const guild = client.guilds.cache.get(process.env.GUILD_ID) || client.guilds.cache.first();
  if (!guild) return;

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

module.exports = { handleCreateDispute, handleDisputeSelect, handleDisputeConfirm, cleanupDisputeChannels };
