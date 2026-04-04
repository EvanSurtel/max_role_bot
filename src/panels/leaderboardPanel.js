const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const neatqueueService = require('../services/neatqueueService');
const { USDC_PER_UNIT, CURRENT_SEASON } = require('../config/constants');

const REGIONS = ['global', 'na', 'latam', 'eu', 'asia'];
const REGION_LABELS = { global: 'Global', na: 'NA', latam: 'LATAM', eu: 'EU', asia: 'Asia' };

// Cache NeatQueue data (2 min TTL)
let nqCache = { data: null, fetchedAt: 0 };
const NQ_CACHE_TTL = 2 * 60 * 1000;

async function getNeatQueueData() {
  if (nqCache.data && Date.now() - nqCache.fetchedAt < NQ_CACHE_TTL) return nqCache.data;
  if (!neatqueueService.isConfigured()) return null;
  try {
    const data = await neatqueueService.getChannelLeaderboard();
    if (data) nqCache = { data, fetchedAt: Date.now() };
    return data;
  } catch (err) {
    console.error('[Leaderboard] NeatQueue fetch failed:', err.message);
    return nqCache.data;
  }
}

// ─── Build Leaderboard Embeds ────────────────────────────────────

async function buildXpLeaderboardEmbed(region, view = 'alltime') {
  const db = require('../database/db');
  const regionFilter = region === 'global' ? '' : ' AND u.region = ?';
  const regionParams = region === 'global' ? [] : [region];

  let entries = [];
  let title, footerText;

  if (view === 'season') {
    // Season view — sum xp_history for current season
    title = `${REGION_LABELS[region]} XP — Season ${CURRENT_SEASON}`;
    footerText = `Season ${CURRENT_SEASON}`;

    const rows = db.prepare(`
      SELECT u.discord_id, u.cod_ign, u.total_wins, u.total_losses,
             COALESCE(SUM(xh.xp_amount), 0) as season_xp
      FROM users u
      LEFT JOIN xp_history xh ON xh.user_id = u.id AND xh.season = ?
      WHERE u.accepted_tos = 1${regionFilter}
      GROUP BY u.id
      HAVING season_xp > 0
      ORDER BY season_xp DESC
      LIMIT 10
    `).all(CURRENT_SEASON, ...regionParams);

    entries = rows.map(r => ({
      discord_id: r.discord_id,
      cod_ign: r.cod_ign,
      points: r.season_xp,
      wins: r.total_wins,
      losses: r.total_losses,
    }));
  } else {
    // All-time view — use accumulated xp_points from users table
    title = `${REGION_LABELS[region]} XP — All-Time`;
    footerText = 'All-Time';

    const rows = db.prepare(`
      SELECT * FROM users
      WHERE accepted_tos = 1 AND xp_points > 0${regionFilter.replace('u.', '')}
      ORDER BY xp_points DESC LIMIT 10
    `).all(...regionParams);

    entries = rows.map(r => ({
      discord_id: r.discord_id,
      cod_ign: r.cod_ign,
      points: r.xp_points,
      wins: r.total_wins,
      losses: r.total_losses,
    }));
  }

  const lines = entries.length > 0
    ? entries.map((e, i) => {
        const ign = e.cod_ign ? ` (${e.cod_ign})` : '';
        return `**#${i + 1}.** <@${e.discord_id}>${ign} — ${e.points.toLocaleString()} XP | ${e.wins}W-${e.losses}L`;
      })
    : ['No players on this leaderboard yet.'];

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setColor(view === 'season' ? 0xe67e22 : 0x5865F2)
    .setFooter({ text: footerText })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`xplb_alltime_${region}`)
      .setLabel('All-Time')
      .setStyle(view === 'alltime' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`xplb_season_${region}`)
      .setLabel(`Season ${CURRENT_SEASON}`)
      .setStyle(view === 'season' ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

async function buildEarningsLeaderboardEmbed(region) {
  const db = require('../database/db');
  const regionFilter = region === 'global' ? '' : ' AND region = ?';
  const regionParams = region === 'global' ? [] : [region];

  const rows = db.prepare(
    `SELECT * FROM users WHERE accepted_tos = 1 AND CAST(total_earnings_usdc AS INTEGER) > 0${regionFilter} ORDER BY CAST(total_earnings_usdc AS INTEGER) DESC LIMIT 10`
  ).all(...regionParams);

  const lines = rows.length > 0
    ? rows.map((row, i) => {
        const ign = row.cod_ign ? ` (${row.cod_ign})` : '';
        const usdc = (Number(row.total_earnings_usdc) / USDC_PER_UNIT).toFixed(2);
        return `**#${i + 1}.** <@${row.discord_id}>${ign} — **$${usdc} USDC** | ${row.total_wins}W-${row.total_losses}L`;
      })
    : ['No earnings data yet.'];

  const embed = new EmbedBuilder()
    .setTitle(`${REGION_LABELS[region]} Earnings Leaderboard`)
    .setDescription(lines.join('\n'))
    .setColor(0x57F287)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`earnlb_refresh_${region}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

// ─── Post Panels on Startup ─────────────────────────────────────

const XP_CHANNEL_KEYS = {
  global: 'XP_LB_GLOBAL_CHANNEL_ID',
  na: 'XP_LB_NA_CHANNEL_ID',
  latam: 'XP_LB_LATAM_CHANNEL_ID',
  eu: 'XP_LB_EU_CHANNEL_ID',
  asia: 'XP_LB_ASIA_CHANNEL_ID',
};

const EARN_CHANNEL_KEYS = {
  global: 'EARN_LB_GLOBAL_CHANNEL_ID',
  na: 'EARN_LB_NA_CHANNEL_ID',
  latam: 'EARN_LB_LATAM_CHANNEL_ID',
  eu: 'EARN_LB_EU_CHANNEL_ID',
  asia: 'EARN_LB_ASIA_CHANNEL_ID',
};

async function postAllLeaderboardPanels(client) {
  for (const region of REGIONS) {
    // XP leaderboard
    const xpChannelId = process.env[XP_CHANNEL_KEYS[region]];
    if (xpChannelId) {
      try {
        const ch = client.channels.cache.get(xpChannelId);
        if (ch) {
          const panel = await buildXpLeaderboardEmbed(region, 'alltime');
          const messages = await ch.messages.fetch({ limit: 5 });
          const existing = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('XP'));
          if (existing) {
            await existing.edit(panel);
          } else {
            await ch.send(panel);
          }
          console.log(`[Panel] Posted XP leaderboard: ${region}`);
        }
      } catch (err) {
        console.error(`[Panel] Failed to post XP leaderboard (${region}):`, err.message);
      }
    }

    // Earnings leaderboard
    const earnChannelId = process.env[EARN_CHANNEL_KEYS[region]];
    if (earnChannelId) {
      try {
        const ch = client.channels.cache.get(earnChannelId);
        if (ch) {
          const panel = await buildEarningsLeaderboardEmbed(region);
          const messages = await ch.messages.fetch({ limit: 5 });
          const existing = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Earnings Leaderboard'));
          if (existing) {
            await existing.edit(panel);
          } else {
            await ch.send(panel);
          }
          console.log(`[Panel] Posted earnings leaderboard: ${region}`);
        }
      } catch (err) {
        console.error(`[Panel] Failed to post earnings leaderboard (${region}):`, err.message);
      }
    }
  }
}

// ─── Refresh Button Handler ──────────────────────────────────────

async function handleLeaderboardButton(interaction) {
  const id = interaction.customId;

  // XP leaderboard — All-Time
  if (id.startsWith('xplb_alltime_')) {
    const region = id.replace('xplb_alltime_', '');
    const panel = await buildXpLeaderboardEmbed(region, 'alltime');
    return interaction.update(panel);
  }

  // XP leaderboard — Current Season
  if (id.startsWith('xplb_season_')) {
    const region = id.replace('xplb_season_', '');
    const panel = await buildXpLeaderboardEmbed(region, 'season');
    return interaction.update(panel);
  }

  // Earnings leaderboard — Refresh
  if (id.startsWith('earnlb_refresh_')) {
    const region = id.replace('earnlb_refresh_', '');
    const panel = await buildEarningsLeaderboardEmbed(region);
    return interaction.update(panel);
  }
}

module.exports = { postAllLeaderboardPanels, handleLeaderboardButton };
