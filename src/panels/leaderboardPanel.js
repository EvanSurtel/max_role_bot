const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const neatqueueService = require('../services/neatqueueService');
const { USDC_PER_UNIT } = require('../config/constants');

const REGIONS = ['global', 'na', 'latam', 'eu', 'asia'];
const REGION_LABELS = { global: 'Global', na: 'NA', latam: 'LATAM', eu: 'EU', asia: 'Asia' };

// Cache NeatQueue leaderboard data (refresh every 2 min)
let nqCache = { data: null, fetchedAt: 0 };
const NQ_CACHE_TTL = 2 * 60 * 1000;

/**
 * Fetch NeatQueue leaderboard with caching.
 */
async function getNeatQueueData() {
  if (nqCache.data && Date.now() - nqCache.fetchedAt < NQ_CACHE_TTL) {
    return nqCache.data;
  }

  if (!neatqueueService.isConfigured()) return null;

  try {
    const data = await neatqueueService.getChannelLeaderboard();
    if (data) {
      nqCache = { data, fetchedAt: Date.now() };
    }
    return data;
  } catch (err) {
    console.error('[Leaderboard] Failed to fetch NeatQueue data:', err.message);
    return nqCache.data; // return stale cache on error
  }
}

// ─── XP Leaderboard Panel ────────────────────────────────────────

function buildXpLeaderboardPanel() {
  const embed = new EmbedBuilder()
    .setTitle('XP Leaderboard')
    .setColor(0x5865F2)
    .setDescription('XP rankings from all matches (queue + wagers + XP matches).\nSelect a region:');

  const row = new ActionRowBuilder().addComponents(
    ...REGIONS.map(r =>
      new ButtonBuilder()
        .setCustomId(`xplb_${r}`)
        .setLabel(REGION_LABELS[r])
        .setStyle(r === 'global' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );

  return { embeds: [embed], components: [row] };
}

async function postXpLeaderboardPanel(client) {
  const channelId = process.env.XP_LEADERBOARD_CHANNEL_ID;
  if (!channelId) return;

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    const existing = messages.find(
      m => m.author.id === client.user.id && m.embeds[0]?.title === 'XP Leaderboard',
    );
    const panel = buildXpLeaderboardPanel();
    if (existing) {
      await existing.edit(panel);
      console.log('[Panel] Updated XP leaderboard panel');
    } else {
      await channel.send(panel);
      console.log('[Panel] Posted XP leaderboard panel');
    }
  } catch (err) {
    console.error('[Panel] Failed to post XP leaderboard panel:', err.message);
  }
}

// ─── Earnings Leaderboard Panel ──────────────────────────────────

function buildEarningsLeaderboardPanel() {
  const embed = new EmbedBuilder()
    .setTitle('Earnings Leaderboard')
    .setColor(0x57F287)
    .setDescription('Top earners from wager matches.\nSelect a region:');

  const row = new ActionRowBuilder().addComponents(
    ...REGIONS.map(r =>
      new ButtonBuilder()
        .setCustomId(`earnlb_${r}`)
        .setLabel(REGION_LABELS[r])
        .setStyle(r === 'global' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );

  return { embeds: [embed], components: [row] };
}

async function postEarningsLeaderboardPanel(client) {
  const channelId = process.env.EARNINGS_LEADERBOARD_CHANNEL_ID;
  if (!channelId) return;

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    const existing = messages.find(
      m => m.author.id === client.user.id && m.embeds[0]?.title === 'Earnings Leaderboard',
    );
    const panel = buildEarningsLeaderboardPanel();
    if (existing) {
      await existing.edit(panel);
      console.log('[Panel] Updated earnings leaderboard panel');
    } else {
      await channel.send(panel);
      console.log('[Panel] Posted earnings leaderboard panel');
    }
  } catch (err) {
    console.error('[Panel] Failed to post earnings leaderboard panel:', err.message);
  }
}

// ─── Button Handlers ─────────────────────────────────────────────

async function handleLeaderboardButton(interaction) {
  const id = interaction.customId;

  // XP leaderboard (pulls from NeatQueue, filters by region from our DB)
  if (id.startsWith('xplb_')) {
    const region = id.replace('xplb_', '');
    return showXpLeaderboard(interaction, region);
  }

  // Earnings leaderboard (our DB only)
  if (id.startsWith('earnlb_')) {
    const region = id.replace('earnlb_', '');
    return showEarningsLeaderboard(interaction, region);
  }
}

async function showXpLeaderboard(interaction, region) {
  await interaction.deferReply({ ephemeral: true });

  const db = require('../database/db');

  // Try NeatQueue first for complete XP data
  const nqData = await getNeatQueueData();

  if (nqData && Array.isArray(nqData)) {
    // NeatQueue returned leaderboard data — cross-reference with our DB for regions
    const entries = [];

    for (const entry of nqData) {
      const discordId = String(entry.user_id || entry.discord_id);
      const user = userRepo.findByDiscordId(discordId);

      // Filter by region (skip if not matching, unless global)
      if (region !== 'global' && (!user || user.region !== region)) continue;

      entries.push({
        discord_id: discordId,
        cod_ign: user?.cod_ign || null,
        points: entry.points || entry.xp || 0,
        wins: entry.wins || 0,
        losses: entry.losses || 0,
      });
    }

    // Sort by points descending
    entries.sort((a, b) => b.points - a.points);
    const top10 = entries.slice(0, 10);

    if (top10.length === 0) {
      return interaction.editReply({ content: `No XP data for ${REGION_LABELS[region]} yet.` });
    }

    const lines = top10.map((e, i) => {
      const ign = e.cod_ign ? ` (${e.cod_ign})` : '';
      return `**#${i + 1}.** <@${e.discord_id}>${ign} — ${e.points.toLocaleString()} XP | ${e.wins}W-${e.losses}L`;
    });

    // Show caller's rank
    const callerId = interaction.user.id;
    if (!top10.some(e => e.discord_id === callerId)) {
      const callerEntry = entries.find(e => e.discord_id === callerId);
      if (callerEntry) {
        const rank = entries.indexOf(callerEntry) + 1;
        const ign = callerEntry.cod_ign ? ` (${callerEntry.cod_ign})` : '';
        lines.push('', `**#${rank}.** <@${callerId}>${ign} — ${callerEntry.points.toLocaleString()} XP | ${callerEntry.wins}W-${callerEntry.losses}L`);
      }
    }

    const embed = new EmbedBuilder()
      .setTitle(`${REGION_LABELS[region]} — XP Leaderboard`)
      .setDescription(lines.join('\n'))
      .setColor(0x5865F2)
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  // Fallback: use our own DB xp_points (only has our matches, not NeatQueue queue matches)
  const regionFilter = region === 'global' ? '' : ' AND region = ?';
  const regionParams = region === 'global' ? [] : [region];

  const rows = db.prepare(
    `SELECT * FROM users WHERE accepted_tos = 1 AND xp_points > 0${regionFilter} ORDER BY xp_points DESC LIMIT 10`
  ).all(...regionParams);

  if (rows.length === 0) {
    return interaction.editReply({ content: `No XP data for ${REGION_LABELS[region]} yet.` });
  }

  const lines = rows.map((row, i) => {
    const ign = row.cod_ign ? ` (${row.cod_ign})` : '';
    return `**#${i + 1}.** <@${row.discord_id}>${ign} — ${row.xp_points.toLocaleString()} XP | ${row.total_wins}W-${row.total_losses}L`;
  });

  const callerId = interaction.user.id;
  if (!rows.some(r => r.discord_id === callerId)) {
    const callerUser = userRepo.findByDiscordId(callerId);
    if (callerUser && callerUser.xp_points > 0) {
      lines.push('', `**You:** <@${callerId}> — ${callerUser.xp_points.toLocaleString()} XP`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`${REGION_LABELS[region]} — XP Leaderboard`)
    .setDescription(lines.join('\n'))
    .setColor(0x5865F2)
    .setFooter({ text: 'Showing bot matches only — NeatQueue not connected' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

async function showEarningsLeaderboard(interaction, region) {
  const db = require('../database/db');
  const regionFilter = region === 'global' ? '' : ' AND region = ?';
  const regionParams = region === 'global' ? [] : [region];

  const rows = db.prepare(
    `SELECT * FROM users WHERE accepted_tos = 1 AND CAST(total_earnings_usdc AS INTEGER) > 0${regionFilter} ORDER BY CAST(total_earnings_usdc AS INTEGER) DESC LIMIT 10`
  ).all(...regionParams);

  if (rows.length === 0) {
    return interaction.reply({ content: `No earnings data for ${REGION_LABELS[region]} yet.`, ephemeral: true });
  }

  const lines = rows.map((row, i) => {
    const ign = row.cod_ign ? ` (${row.cod_ign})` : '';
    const usdc = (Number(row.total_earnings_usdc) / USDC_PER_UNIT).toFixed(2);
    return `**#${i + 1}.** <@${row.discord_id}>${ign} — **$${usdc} USDC** earned | ${row.total_wins}W-${row.total_losses}L`;
  });

  const callerId = interaction.user.id;
  if (!rows.some(r => r.discord_id === callerId)) {
    const callerUser = userRepo.findByDiscordId(callerId);
    if (callerUser && Number(callerUser.total_earnings_usdc) > 0) {
      const usdc = (Number(callerUser.total_earnings_usdc) / USDC_PER_UNIT).toFixed(2);
      lines.push('', `**You:** <@${callerId}> — **$${usdc} USDC** earned`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`${REGION_LABELS[region]} — Earnings Leaderboard`)
    .setDescription(lines.join('\n'))
    .setColor(0x57F287)
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = {
  postXpLeaderboardPanel,
  postEarningsLeaderboardPanel,
  handleLeaderboardButton,
};
