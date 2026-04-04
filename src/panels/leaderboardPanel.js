const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const neatqueueService = require('../services/neatqueueService');
const { USDC_PER_UNIT } = require('../config/constants');

// Season stored in DB so it can be changed from Discord without restarting
let currentSeason = null;

function getCurrentSeason() {
  if (currentSeason) return currentSeason;
  try {
    const db = require('../database/db');
    const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'current_season'").get();
    if (row) {
      currentSeason = row.value;
      return currentSeason;
    }
  } catch { /* table may not exist yet */ }
  currentSeason = process.env.CURRENT_SEASON || '2026-S1';
  return currentSeason;
}

function setCurrentSeason(season) {
  currentSeason = season;
  const db = require('../database/db');
  try {
    db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('current_season', ?)").run(season);
  } catch {
    // Table might not exist, create it
    db.prepare('CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)').run();
    db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('current_season', ?)").run(season);
  }
}

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
  if (!REGIONS.includes(region)) region = 'global';
  const db = require('../database/db');
  const regionFilter = region === 'global' ? '' : ' AND u.region = ?';
  const regionParams = region === 'global' ? [] : [region];

  let entries = [];
  let title, footerText;

  if (view === 'season') {
    // Season view — sum xp_history for current season
    title = `${REGION_LABELS[region]} XP — Season ${getCurrentSeason()}`;
    footerText = `Season ${getCurrentSeason()}`;

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
    `).all(getCurrentSeason(), ...regionParams);

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

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`xplb_alltime_${region}`)
      .setLabel('All-Time')
      .setStyle(view === 'alltime' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`xplb_season_${region}`)
      .setLabel(`Season ${getCurrentSeason()}`)
      .setStyle(view === 'season' ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lb_admin_adjust_xp').setLabel('Adjust XP').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('lb_admin_adjust_wl').setLabel('Adjust W/L').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('lb_admin_change_season').setLabel('Change Season').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row1, row2] };
}

async function buildEarningsLeaderboardEmbed(region) {
  if (!REGIONS.includes(region)) region = 'global';
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

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`earnlb_refresh_${region}`)
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lb_admin_adjust_earnings').setLabel('Adjust Earnings').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row1, row2] };
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

function isAdmin(member) {
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  const staffRoleId = process.env.WAGER_STAFF_ROLE_ID;
  if (adminRoleId && member.roles.cache.has(adminRoleId)) return true;
  if (staffRoleId && member.roles.cache.has(staffRoleId)) return true;
  return false;
}

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

  // Admin: open adjust modal
  if (id === 'lb_admin_adjust_xp') {
    if (!isAdmin(interaction.member)) return interaction.reply({ content: 'Admin only.', ephemeral: true });
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
    const modal = new ModalBuilder().setCustomId('lb_admin_xp_modal').setTitle('Adjust User XP');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('target_user_id').setLabel('Discord User ID').setPlaceholder('Right-click user → Copy User ID').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('xp_amount').setLabel('XP Amount (positive to add, negative to subtract)').setPlaceholder('e.g. 500 or -200').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason').setPlaceholder('e.g. Manual correction').setStyle(TextInputStyle.Short).setRequired(true)),
    );
    return interaction.showModal(modal);
  }

  if (id === 'lb_admin_adjust_wl') {
    if (!isAdmin(interaction.member)) return interaction.reply({ content: 'Admin only.', ephemeral: true });
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
    const modal = new ModalBuilder().setCustomId('lb_admin_wl_modal').setTitle('Adjust Wins/Losses');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('target_user_id').setLabel('Discord User ID').setPlaceholder('Right-click user → Copy User ID').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wins_adjust').setLabel('Wins adjustment (e.g. 1 or -1)').setPlaceholder('0').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('losses_adjust').setLabel('Losses adjustment (e.g. 1 or -1)').setPlaceholder('0').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason').setPlaceholder('e.g. Dispute correction').setStyle(TextInputStyle.Short).setRequired(true)),
    );
    return interaction.showModal(modal);
  }

  if (id === 'lb_admin_change_season') {
    if (!isAdmin(interaction.member)) return interaction.reply({ content: 'Admin only.', ephemeral: true });
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
    const modal = new ModalBuilder().setCustomId('lb_admin_season_modal').setTitle('Change Season');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('new_season').setLabel(`Current: ${getCurrentSeason()}. Enter new season ID`).setPlaceholder('e.g. 2026-S2').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(20),
      ),
    );
    return interaction.showModal(modal);
  }

  if (id === 'lb_admin_adjust_earnings') {
    if (!isAdmin(interaction.member)) return interaction.reply({ content: 'Admin only.', ephemeral: true });
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
    const modal = new ModalBuilder().setCustomId('lb_admin_earn_modal').setTitle('Adjust Earnings');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('target_user_id').setLabel('Discord User ID').setPlaceholder('Right-click user → Copy User ID').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('usdc_amount').setLabel('USDC Amount (e.g. 10.50 or -5.00)').setPlaceholder('e.g. 10.50').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason').setPlaceholder('e.g. Manual correction').setStyle(TextInputStyle.Short).setRequired(true)),
    );
    return interaction.showModal(modal);
  }
}

/**
 * Handle admin adjustment modals.
 */
async function handleAdminModal(interaction) {
  const id = interaction.customId;

  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: 'Admin only.', ephemeral: true });
  }

  const { logAdminAction } = require('../utils/adminAudit');
  const db = require('../database/db');

  if (id === 'lb_admin_xp_modal') {
    const targetId = interaction.fields.getTextInputValue('target_user_id').trim();
    const xpAmount = parseInt(interaction.fields.getTextInputValue('xp_amount').trim(), 10);
    const reason = interaction.fields.getTextInputValue('reason').trim();

    if (isNaN(xpAmount)) return interaction.reply({ content: 'Invalid XP amount.', ephemeral: true });

    const user = userRepo.findByDiscordId(targetId);
    if (!user) return interaction.reply({ content: `User ${targetId} not found.`, ephemeral: true });

    userRepo.addXp(user.id, xpAmount);

    // Log to xp_history
    db.prepare('INSERT INTO xp_history (user_id, match_id, match_type, xp_amount, season) VALUES (?, NULL, ?, ?, ?)')
      .run(user.id, 'admin_adjust', xpAmount, getCurrentSeason());

    // Sync to NeatQueue
    if (neatqueueService.isConfigured()) {
      neatqueueService.addPoints(targetId, xpAmount).catch(() => {});
    }

    logAdminAction(interaction.user.id, 'adjust_xp', 'user', user.id, { xpAmount, reason });

    return interaction.reply({
      content: `**XP adjusted.** <@${targetId}>: ${xpAmount > 0 ? '+' : ''}${xpAmount} XP. Reason: ${reason}`,
      ephemeral: true,
    });
  }

  if (id === 'lb_admin_wl_modal') {
    const targetId = interaction.fields.getTextInputValue('target_user_id').trim();
    const winsAdj = parseInt(interaction.fields.getTextInputValue('wins_adjust').trim(), 10);
    const lossesAdj = parseInt(interaction.fields.getTextInputValue('losses_adjust').trim(), 10);
    const reason = interaction.fields.getTextInputValue('reason').trim();

    if (isNaN(winsAdj) || isNaN(lossesAdj)) return interaction.reply({ content: 'Invalid numbers.', ephemeral: true });

    const user = userRepo.findByDiscordId(targetId);
    if (!user) return interaction.reply({ content: `User ${targetId} not found.`, ephemeral: true });

    if (winsAdj !== 0) {
      db.prepare('UPDATE users SET total_wins = MAX(0, total_wins + ?) WHERE id = ?').run(winsAdj, user.id);
    }
    if (lossesAdj !== 0) {
      db.prepare('UPDATE users SET total_losses = MAX(0, total_losses + ?) WHERE id = ?').run(lossesAdj, user.id);
    }

    // Sync to NeatQueue
    if (neatqueueService.isConfigured()) {
      if (winsAdj > 0) for (let i = 0; i < winsAdj; i++) neatqueueService.addWin(targetId).catch(() => {});
      if (lossesAdj > 0) for (let i = 0; i < lossesAdj; i++) neatqueueService.addLoss(targetId).catch(() => {});
    }

    logAdminAction(interaction.user.id, 'adjust_wl', 'user', user.id, { winsAdj, lossesAdj, reason });

    return interaction.reply({
      content: `**W/L adjusted.** <@${targetId}>: ${winsAdj >= 0 ? '+' : ''}${winsAdj}W, ${lossesAdj >= 0 ? '+' : ''}${lossesAdj}L. Reason: ${reason}`,
      ephemeral: true,
    });
  }

  if (id === 'lb_admin_season_modal') {
    const newSeason = interaction.fields.getTextInputValue('new_season').trim();
    const oldSeason = getCurrentSeason();
    setCurrentSeason(newSeason);
    logAdminAction(interaction.user.id, 'change_season', 'system', 0, { oldSeason, newSeason });

    return interaction.reply({
      content: `**Season changed:** ${oldSeason} → **${newSeason}**\n\nAll new XP will be tracked under ${newSeason}. Old season data is preserved.`,
      ephemeral: true,
    });
  }

  if (id === 'lb_admin_earn_modal') {
    const targetId = interaction.fields.getTextInputValue('target_user_id').trim();
    const usdcAmount = parseFloat(interaction.fields.getTextInputValue('usdc_amount').trim());
    const reason = interaction.fields.getTextInputValue('reason').trim();

    if (isNaN(usdcAmount)) return interaction.reply({ content: 'Invalid USDC amount.', ephemeral: true });

    const user = userRepo.findByDiscordId(targetId);
    if (!user) return interaction.reply({ content: `User ${targetId} not found.`, ephemeral: true });

    const amountSmallest = Math.round(usdcAmount * USDC_PER_UNIT);
    userRepo.addEarnings(user.id, amountSmallest.toString());

    logAdminAction(interaction.user.id, 'adjust_earnings', 'user', user.id, { usdcAmount, reason });

    return interaction.reply({
      content: `**Earnings adjusted.** <@${targetId}>: ${usdcAmount >= 0 ? '+' : ''}$${usdcAmount.toFixed(2)} USDC. Reason: ${reason}`,
      ephemeral: true,
    });
  }
}

module.exports = { postAllLeaderboardPanels, handleLeaderboardButton, handleAdminModal, getCurrentSeason, setCurrentSeason };
