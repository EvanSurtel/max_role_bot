const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const neatqueueService = require('../services/neatqueueService');
const { USDC_PER_UNIT } = require('../config/constants');

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

async function buildXpLeaderboardEmbed(region) {
  const db = require('../database/db');
  const nqData = await getNeatQueueData();

  let entries = [];

  if (nqData && Array.isArray(nqData)) {
    for (const entry of nqData) {
      const discordId = String(entry.user_id || entry.discord_id);
      const user = userRepo.findByDiscordId(discordId);
      if (region !== 'global' && (!user || user.region !== region)) continue;
      entries.push({
        discord_id: discordId,
        cod_ign: user?.cod_ign || null,
        points: entry.points || entry.xp || 0,
        wins: entry.wins || 0,
        losses: entry.losses || 0,
      });
    }
    entries.sort((a, b) => b.points - a.points);
  } else {
    // Fallback to our DB
    const regionFilter = region === 'global' ? '' : ' AND region = ?';
    const regionParams = region === 'global' ? [] : [region];
    const rows = db.prepare(
      `SELECT * FROM users WHERE accepted_tos = 1 AND xp_points > 0${regionFilter} ORDER BY xp_points DESC LIMIT 10`
    ).all(...regionParams);
    entries = rows.map(r => ({
      discord_id: r.discord_id,
      cod_ign: r.cod_ign,
      points: r.xp_points,
      wins: r.total_wins,
      losses: r.total_losses,
    }));
  }

  const top10 = entries.slice(0, 10);

  const lines = top10.length > 0
    ? top10.map((e, i) => {
        const ign = e.cod_ign ? ` (${e.cod_ign})` : '';
        return `**#${i + 1}.** <@${e.discord_id}>${ign} — ${e.points.toLocaleString()} XP | ${e.wins}W-${e.losses}L`;
      })
    : ['No players on this leaderboard yet.'];

  const embed = new EmbedBuilder()
    .setTitle(`${REGION_LABELS[region]} XP Leaderboard`)
    .setDescription(lines.join('\n'))
    .setColor(0x5865F2)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`xplb_refresh_${region}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary),
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
          const panel = await buildXpLeaderboardEmbed(region);
          const messages = await ch.messages.fetch({ limit: 5 });
          const existing = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('XP Leaderboard'));
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

  if (id.startsWith('xplb_refresh_')) {
    const region = id.replace('xplb_refresh_', '');
    const panel = await buildXpLeaderboardEmbed(region);
    return interaction.update(panel);
  }

  if (id.startsWith('earnlb_refresh_')) {
    const region = id.replace('earnlb_refresh_', '');
    const panel = await buildEarningsLeaderboardEmbed(region);
    return interaction.update(panel);
  }
}

module.exports = { postAllLeaderboardPanels, handleLeaderboardButton };
