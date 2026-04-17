// Match channel creation — Discord categories, voice, text, voting.
const { ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const matchRepo = require('../../database/repositories/matchRepo');
const challengeRepo = require('../../database/repositories/challengeRepo');
const challengePlayerRepo = require('../../database/repositories/challengePlayerRepo');
const userRepo = require('../../database/repositories/userRepo');
const { privateTextOverwrites, privateVoiceOverwrites, votingChannelOverwrites, sharedOverwrites } = require('../../utils/permissions');
const { CHALLENGE_STATUS, CHALLENGE_TYPE, PLAYER_ROLE } = require('../../config/constants');
const { t, getLang } = require('../../locales/i18n');
const { buildLanguageDropdownRow } = require('../../utils/languageButtonHelper');
const { captainLang } = require('./helpers');

/**
 * Create match channels (team voice, team text, shared, voting) for a
 * matched challenge.
 *
 * @param {import('discord.js').Client} client - The Discord client.
 * @param {object} challenge - The challenge DB record.
 * @param {number} matchId - The match ID (already created via createMatchRecord).
 * @returns {Promise<object>} The match record (re-fetched after channel IDs are set).
 */
async function createMatchChannels(client, challenge, matchId) {
  // Get the guild
  let guild;
  if (challenge.challenge_channel_id) {
    const boardChannel = client.channels.cache.get(challenge.challenge_channel_id);
    if (boardChannel) guild = boardChannel.guild;
  }
  if (!guild) {
    const guildId = process.env.GUILD_ID;
    if (guildId) guild = client.guilds.cache.get(guildId);
    if (!guild) guild = client.guilds.cache.first();
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
      if (player.role === PLAYER_ROLE.CAPTAIN) captainDiscordIds.push(user.discord_id);
    }
  }

  for (const player of team2Players) {
    const user = userRepo.findById(player.user_id);
    if (user) {
      team2DiscordIds.push(user.discord_id);
      allDiscordIds.push(user.discord_id);
      if (player.role === PLAYER_ROLE.CAPTAIN) captainDiscordIds.push(user.discord_id);
    }
  }

  // Create category + all channels
  const category = await guild.channels.create({
    name: `Match #${challenge.id}`,
    type: ChannelType.GuildCategory,
    reason: 'Match category',
  });

  const team1Text = await guild.channels.create({
    name: 'team-1', type: ChannelType.GuildText, parent: category.id,
    permissionOverwrites: privateTextOverwrites(guild, team1DiscordIds, true), reason: 'Match channel',
  });
  const team1Voice = await guild.channels.create({
    name: 'Team 1', type: ChannelType.GuildVoice, parent: category.id,
    permissionOverwrites: privateVoiceOverwrites(guild, team1DiscordIds, true), reason: 'Match channel',
  });
  const team2Text = await guild.channels.create({
    name: 'team-2', type: ChannelType.GuildText, parent: category.id,
    permissionOverwrites: privateTextOverwrites(guild, team2DiscordIds, true), reason: 'Match channel',
  });
  const team2Voice = await guild.channels.create({
    name: 'Team 2', type: ChannelType.GuildVoice, parent: category.id,
    permissionOverwrites: privateVoiceOverwrites(guild, team2DiscordIds, true), reason: 'Match channel',
  });
  const sharedText = await guild.channels.create({
    name: 'shared-chat', type: ChannelType.GuildText, parent: category.id,
    permissionOverwrites: sharedOverwrites(guild, allDiscordIds), reason: 'Match channel',
  });
  const sharedVoice = await guild.channels.create({
    name: 'Shared Voice', type: ChannelType.GuildVoice, parent: category.id,
    permissionOverwrites: sharedOverwrites(guild, allDiscordIds), reason: 'Match channel',
  });
  const voteChannel = await guild.channels.create({
    name: 'vote', type: ChannelType.GuildText, parent: category.id,
    permissionOverwrites: votingChannelOverwrites(guild, captainDiscordIds), reason: 'Match voting channel',
  });

  // Update match record with category + channel IDs
  matchRepo.updateCategoryId(matchId, category.id);
  const match = matchRepo.findById(matchId);
  matchRepo.setChannels(match.id, {
    team1VoiceId: team1Voice.id, team1TextId: team1Text.id,
    team2VoiceId: team2Voice.id, team2TextId: team2Text.id,
    sharedVoiceId: sharedVoice.id, sharedTextId: sharedText.id,
    votingChannelId: voteChannel.id,
  });

  // Calculate estimated match duration and post vote panel
  const { estimateMatchDuration, formatDuration } = require('../../utils/matchTimer');
  const estimatedMinutes = estimateMatchDuration(challenge.game_modes, challenge.series_length);

  const sharedLang = captainLang(captainDiscordIds);
  const team1CaptainLang = getLang(team1DiscordIds.find(id => captainDiscordIds.includes(id)));
  const team2CaptainLang = getLang(team2DiscordIds.find(id => captainDiscordIds.includes(id)));

  const reportEmbed = new EmbedBuilder()
    .setTitle(t('match_channel.report_title', sharedLang, { matchId: match.id }))
    .setColor(0xe67e22)
    .setDescription([
      t('match_channel.estimated_time', sharedLang, { duration: formatDuration(estimatedMinutes) }),
      '', t('match_channel.report_intro', sharedLang),
      '', t('match_channel.report_how', sharedLang),
      '', t('match_channel.agree_resolved', sharedLang),
      t('match_channel.disagree_dispute', sharedLang),
      '', t('match_channel.no_show_hint', sharedLang),
    ].join('\n'))
    .setFooter({ text: t('match_channel.only_captains_footer', sharedLang) });

  const reportRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report_won_${match.id}`).setLabel(t('match_channel.btn_we_won', sharedLang)).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`report_lost_${match.id}`).setLabel(t('match_channel.btn_we_lost', sharedLang)).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`noshow_report_${match.id}`).setLabel(t('match_channel.btn_no_show', sharedLang)).setStyle(ButtonStyle.Secondary),
  );

  const voteLangRow = buildLanguageDropdownRow(sharedLang);
  await voteChannel.send({ embeds: [reportEmbed], components: [reportRow, ...voteLangRow] });

  // Build match info for welcome messages
  const isCashMatch = challenge.type === CHALLENGE_TYPE.CASH_MATCH;
  const prizeAmountFormatted = isCashMatch ? (Number(challenge.total_pot_usdc) / 1_000_000).toFixed(2) : '0';

  const typeLabel1 = isCashMatch ? t('challenge_create.type_cash_match', team1CaptainLang) : t('challenge_create.type_xp_match', team1CaptainLang);
  const typeLabel2 = isCashMatch ? t('challenge_create.type_cash_match', team2CaptainLang) : t('challenge_create.type_xp_match', team2CaptainLang);
  const typeLabelShared = isCashMatch ? t('challenge_create.type_cash_match', sharedLang) : t('challenge_create.type_xp_match', sharedLang);
  const prizeText1 = isCashMatch ? t('match_channel.match_prize_label', team1CaptainLang, { amount: prizeAmountFormatted }) : '';
  const prizeText2 = isCashMatch ? t('match_channel.match_prize_label', team2CaptainLang, { amount: prizeAmountFormatted }) : '';
  const prizeTextShared = isCashMatch ? t('match_channel.match_prize_label', sharedLang, { amount: prizeAmountFormatted }) : '';

  // Send welcome messages in team channels
  const team1LangRow = buildLanguageDropdownRow(team1CaptainLang);
  await team1Text.send({
    content: t('match_channel.team_welcome', team1CaptainLang, {
      team: 1, type: typeLabel1, num: challenge.display_number || challenge.id, pot_text: prizeText1,
    }),
    components: [...team1LangRow],
  });

  const team2LangRow = buildLanguageDropdownRow(team2CaptainLang);
  await team2Text.send({
    content: t('match_channel.team_welcome', team2CaptainLang, {
      team: 2, type: typeLabel2, num: challenge.display_number || challenge.id, pot_text: prizeText2,
    }),
    components: [...team2LangRow],
  });

  // Generate random map picks
  const { pickMaps, formatMapPicks } = require('../../utils/mapPicker');
  const mapPicks = pickMaps(challenge.game_modes, challenge.series_length);
  const mapText = mapPicks.length > 0 ? `\n\n${t('match_channel.shared_maps_header', sharedLang)}\n${formatMapPicks(mapPicks)}` : '';

  // Build team rosters with captain labels
  const captainLabel = t('challenge_accept.captain_label', sharedLang);
  const team1Lines = team1DiscordIds.map(id => {
    const isCaptain = captainDiscordIds.includes(id);
    return `<@${id}>${isCaptain ? ' ' + captainLabel : ''}`;
  });
  const team2Lines = team2DiscordIds.map(id => {
    const isCaptain = captainDiscordIds.includes(id);
    return `<@${id}>${isCaptain ? ' ' + captainLabel : ''}`;
  });

  // Shared chat welcome
  const sharedLangRow = buildLanguageDropdownRow(sharedLang);
  await sharedText.send({
    content: [
      t('match_channel.shared_match_header', sharedLang, {
        matchId: match.id, type: typeLabelShared, num: challenge.display_number || challenge.id,
      }),
      '',
      t('match_channel.shared_team1', sharedLang, { players: team1Lines.join(', ') }),
      t('match_channel.shared_team2', sharedLang, { players: team2Lines.join(', ') }),
      prizeTextShared, mapText, '',
      t('match_channel.shared_good_luck', sharedLang),
    ].join('\n'),
    components: [...sharedLangRow],
  });

  challengeRepo.updateStatus(challenge.id, CHALLENGE_STATUS.IN_PROGRESS);

  console.log(`[MatchService] Created match #${match.id} channels for challenge #${challenge.id}`);
  return match;
}

module.exports = { createMatchChannels };
