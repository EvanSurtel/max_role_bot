const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const { USDC_PER_UNIT } = require('../config/constants');

const REGIONS = ['global', 'na', 'latam', 'eu', 'asia'];
const REGION_LABELS = { global: 'Global', na: 'NA', latam: 'LATAM', eu: 'EU', asia: 'Asia' };

let currentSeason = null;

function getCurrentSeason() {
  if (currentSeason) return currentSeason;
  try {
    const db = require('../database/db');
    const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'current_season'").get();
    if (row) { currentSeason = row.value; return currentSeason; }
  } catch { /* */ }
  currentSeason = process.env.CURRENT_SEASON || '2026-S1';
  return currentSeason;
}

function setCurrentSeason(season) {
  currentSeason = season;
  const db = require('../database/db');
  try {
    db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('current_season', ?)").run(season);
  } catch {
    db.prepare('CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)').run();
    db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('current_season', ?)").run(season);
  }
}

function getAvailableSeasons() {
  try {
    const db = require('../database/db');
    return db.prepare('SELECT DISTINCT season FROM xp_history ORDER BY season DESC').all().map(r => r.season);
  } catch { return []; }
}

function isAdmin(member) {
  const a = process.env.ADMIN_ROLE_ID;
  const w = process.env.WAGER_STAFF_ROLE_ID;
  const x = process.env.XP_STAFF_ROLE_ID;
  if (a && member.roles.cache.has(a)) return true;
  if (w && member.roles.cache.has(w)) return true;
  if (x && member.roles.cache.has(x)) return true;
  return false;
}

const rankEmoji = (i) => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;

// ─── XP Leaderboard (one channel, region + season dropdowns) ─────

async function buildXpPanel(region = 'global', view = 'season', seasonOverride = null) {
  if (!REGIONS.includes(region)) region = 'global';
  const db = require('../database/db');
  const cs = getCurrentSeason();
  const viewSeason = seasonOverride || cs;
  const regionFilter = region === 'global' ? '' : ' AND u.region = ?';
  const regionParams = region === 'global' ? [] : [region];

  let entries = [], title, footerText;

  if (view === 'season') {
    const isCurrent = viewSeason === cs;
    title = `${REGION_LABELS[region]} XP — ${viewSeason}${isCurrent ? ' (Current)' : ''}`;
    footerText = `${viewSeason}${isCurrent ? ' (Current)' : ''}`;
    const rows = db.prepare(`
      SELECT u.discord_id, u.cod_ign, u.total_wins, u.total_losses,
             COALESCE(SUM(xh.xp_amount), 0) as season_xp
      FROM users u LEFT JOIN xp_history xh ON xh.user_id = u.id AND xh.season = ?
      WHERE u.accepted_tos = 1${regionFilter} GROUP BY u.id HAVING season_xp > 0
      ORDER BY season_xp DESC LIMIT 10
    `).all(viewSeason, ...regionParams);
    entries = rows.map(r => ({ discord_id: r.discord_id, cod_ign: r.cod_ign, points: r.season_xp, wins: r.total_wins, losses: r.total_losses }));
  } else {
    title = `${REGION_LABELS[region]} XP — All-Time`;
    footerText = 'All-Time';
    const rows = db.prepare(`SELECT * FROM users WHERE accepted_tos = 1 AND xp_points > 0${regionFilter.replace('u.', '')} ORDER BY xp_points DESC LIMIT 10`).all(...regionParams);
    entries = rows.map(r => ({ discord_id: r.discord_id, cod_ign: r.cod_ign, points: r.xp_points, wins: r.total_wins, losses: r.total_losses }));
  }

  const lines = entries.length > 0
    ? entries.map((e, i) => `${rankEmoji(i)} <@${e.discord_id}>${e.cod_ign ? ` \`${e.cod_ign}\`` : ''} — **${e.points.toLocaleString()} XP** \`(${e.wins}W-${e.losses}L)\``)
    : ['No players on this leaderboard yet.'];

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setColor(view === 'season' ? 0xe67e22 : 0x5865F2)
    .setFooter({ text: footerText })
    .setTimestamp();

  // Region dropdown
  const regionMenu = new StringSelectMenuBuilder()
    .setCustomId('xplb_region')
    .setPlaceholder('Select Region')
    .addOptions(REGIONS.map(r => ({ label: REGION_LABELS[r], value: r, default: r === region })));

  // Season dropdown
  const seasons = [{ label: 'All-Time', value: 'alltime' }];
  seasons.push({ label: `${cs} (Current)`, value: cs });
  for (const s of getAvailableSeasons().filter(s => s !== cs).slice(0, 10)) {
    seasons.push({ label: s, value: s });
  }
  const seasonMenu = new StringSelectMenuBuilder()
    .setCustomId('xplb_season')
    .setPlaceholder('Select Season')
    .addOptions(seasons.map(s => ({ ...s, default: (view === 'alltime' && s.value === 'alltime') || (view === 'season' && s.value === viewSeason) })));

  const row1 = new ActionRowBuilder().addComponents(regionMenu);
  const row2 = new ActionRowBuilder().addComponents(seasonMenu);
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lb_admin_adjust_xp').setLabel('Adjust XP').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('lb_admin_adjust_wl').setLabel('Adjust W/L').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

// ─── Earnings Leaderboard (one channel, region dropdown) ─────────

async function buildEarningsPanel(region = 'global') {
  if (!REGIONS.includes(region)) region = 'global';
  const db = require('../database/db');
  const regionFilter = region === 'global' ? '' : ' AND region = ?';
  const regionParams = region === 'global' ? [] : [region];

  const rows = db.prepare(
    `SELECT * FROM users WHERE accepted_tos = 1 AND CAST(total_earnings_usdc AS INTEGER) > 0${regionFilter} ORDER BY CAST(total_earnings_usdc AS INTEGER) DESC LIMIT 10`
  ).all(...regionParams);

  const title = `${REGION_LABELS[region]} Earnings Leaderboard`;

  const lines = rows.length > 0
    ? rows.map((row, i) => {
        const usdc = (Number(row.total_earnings_usdc) / USDC_PER_UNIT).toFixed(2);
        return `${rankEmoji(i)} <@${row.discord_id}>${row.cod_ign ? ` \`${row.cod_ign}\`` : ''} — **$${usdc} USDC** \`(${row.total_wins}W-${row.total_losses}L)\``;
      })
    : ['No earnings data yet.'];

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setColor(0x57F287)
    .setTimestamp();

  const regionMenu = new StringSelectMenuBuilder()
    .setCustomId('earnlb_region')
    .setPlaceholder('Select Region')
    .addOptions(REGIONS.map(r => ({ label: REGION_LABELS[r], value: r, default: r === region })));

  const row1 = new ActionRowBuilder().addComponents(regionMenu);
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lb_admin_adjust_earnings').setLabel('Adjust Earnings').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row1, row2] };
}

// ─── Post Panels on Startup ─────────────────────────────────────

async function postAllLeaderboardPanels(client) {
  // XP Leaderboard — one channel
  const xpChId = process.env.XP_LEADERBOARD_CHANNEL_ID;
  if (xpChId) {
    try {
      const ch = client.channels.cache.get(xpChId);
      if (ch) {
        const messages = await ch.messages.fetch({ limit: 20 });
        for (const [, m] of messages) { if (m.author.id === client.user.id) try { await m.delete(); } catch { /* */ } }
        const panel = await buildXpPanel('global', 'season');
        await ch.send(panel);
        console.log('[Panel] Posted XP leaderboard');
      }
    } catch (err) { console.error('[Panel] XP leaderboard failed:', err.message); }
  }

  // Earnings Leaderboard — one channel
  const earnChId = process.env.EARNINGS_LEADERBOARD_CHANNEL_ID;
  if (earnChId) {
    try {
      const ch = client.channels.cache.get(earnChId);
      if (ch) {
        const messages = await ch.messages.fetch({ limit: 20 });
        for (const [, m] of messages) { if (m.author.id === client.user.id) try { await m.delete(); } catch { /* */ } }
        const panel = await buildEarningsPanel('global');
        await ch.send(panel);
        console.log('[Panel] Posted earnings leaderboard');
      }
    } catch (err) { console.error('[Panel] Earnings leaderboard failed:', err.message); }
  }
}

// ─── Interaction Handlers ────────────────────────────────────────

async function handleLeaderboardButton(interaction) {
  const id = interaction.customId;

  // Admin adjust buttons
  if (id === 'lb_admin_adjust_xp' || id === 'lb_admin_adjust_wl' || id === 'lb_admin_adjust_earnings' || id === 'lb_admin_change_season') {
    return handleAdminButton(interaction);
  }
}

async function handleLeaderboardSelect(interaction) {
  const id = interaction.customId;
  const selected = interaction.values[0];

  // XP leaderboard — region change
  if (id === 'xplb_region') {
    const panel = await buildXpPanel(selected, 'season');
    return interaction.update(panel);
  }

  // XP leaderboard — season change
  if (id === 'xplb_season') {
    const region = getCurrentRegionFromEmbed(interaction);
    if (selected === 'alltime') {
      const panel = await buildXpPanel(region, 'alltime');
      return interaction.update(panel);
    } else {
      const panel = await buildXpPanel(region, 'season', selected);
      return interaction.update(panel);
    }
  }

  // Earnings leaderboard — region change
  if (id === 'earnlb_region') {
    const panel = await buildEarningsPanel(selected);
    return interaction.update(panel);
  }
}

/**
 * Extract current region from the embed title (e.g. "NA XP — ..." → "na")
 */
function getCurrentRegionFromEmbed(interaction) {
  const title = interaction.message?.embeds?.[0]?.title || '';
  for (const [key, label] of Object.entries(REGION_LABELS)) {
    if (title.startsWith(label)) return key;
  }
  return 'global';
}

// ─── Admin Buttons ───────────────────────────────────────────────

async function handleAdminButton(interaction) {
  const id = interaction.customId;
  if (!isAdmin(interaction.member)) return interaction.reply({ content: 'Admin only.', ephemeral: true });

  const { ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

  if (id === 'lb_admin_adjust_xp') {
    const modal = new ModalBuilder().setCustomId('lb_admin_xp_modal').setTitle('Adjust User XP');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('target_user_id').setLabel('Discord User ID').setPlaceholder('Right-click user → Copy User ID').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('xp_amount').setLabel('XP Amount (+ to add, - to subtract)').setPlaceholder('e.g. 500 or -200').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason').setPlaceholder('e.g. Manual correction').setStyle(TextInputStyle.Short).setRequired(true)),
    );
    return interaction.showModal(modal);
  }

  if (id === 'lb_admin_adjust_wl') {
    const modal = new ModalBuilder().setCustomId('lb_admin_wl_modal').setTitle('Adjust Wins/Losses');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('target_user_id').setLabel('Discord User ID').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('wins_adjust').setLabel('Wins adjustment (e.g. 1 or -1)').setPlaceholder('0').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('losses_adjust').setLabel('Losses adjustment (e.g. 1 or -1)').setPlaceholder('0').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason').setStyle(TextInputStyle.Short).setRequired(true)),
    );
    return interaction.showModal(modal);
  }

  if (id === 'lb_admin_adjust_earnings') {
    const modal = new ModalBuilder().setCustomId('lb_admin_earn_modal').setTitle('Adjust Earnings');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('target_user_id').setLabel('Discord User ID').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('usdc_amount').setLabel('USDC Amount (e.g. 10.50 or -5.00)').setPlaceholder('e.g. 10.50').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason').setStyle(TextInputStyle.Short).setRequired(true)),
    );
    return interaction.showModal(modal);
  }
}

// ─── Admin Modal Handlers ────────────────────────────────────────

async function handleAdminModal(interaction) {
  const id = interaction.customId;
  if (!isAdmin(interaction.member)) return interaction.reply({ content: 'Admin only.', ephemeral: true });

  const { logAdminAction } = require('../utils/adminAudit');
  const db = require('../database/db');
  const neatqueueService = require('../services/neatqueueService');

  if (id === 'lb_admin_xp_modal') {
    const targetId = interaction.fields.getTextInputValue('target_user_id').trim();
    const xpAmount = parseInt(interaction.fields.getTextInputValue('xp_amount').trim(), 10);
    const reason = interaction.fields.getTextInputValue('reason').trim();
    if (isNaN(xpAmount)) return interaction.reply({ content: 'Invalid XP amount.', ephemeral: true });
    const user = userRepo.findByDiscordId(targetId);
    if (!user) return interaction.reply({ content: `User ${targetId} not found.`, ephemeral: true });
    userRepo.addXp(user.id, xpAmount);
    db.prepare('INSERT INTO xp_history (user_id, match_id, match_type, xp_amount, season) VALUES (?, NULL, ?, ?, ?)').run(user.id, 'admin_adjust', xpAmount, getCurrentSeason());
    if (neatqueueService.isConfigured()) neatqueueService.addPoints(targetId, xpAmount).catch(() => {});
    logAdminAction(interaction.user.id, 'adjust_xp', 'user', user.id, { xpAmount, reason });
    return interaction.reply({ content: `**XP adjusted.** <@${targetId}>: ${xpAmount > 0 ? '+' : ''}${xpAmount} XP. Reason: ${reason}`, ephemeral: true });
  }

  if (id === 'lb_admin_wl_modal') {
    const targetId = interaction.fields.getTextInputValue('target_user_id').trim();
    const winsAdj = parseInt(interaction.fields.getTextInputValue('wins_adjust').trim(), 10);
    const lossesAdj = parseInt(interaction.fields.getTextInputValue('losses_adjust').trim(), 10);
    const reason = interaction.fields.getTextInputValue('reason').trim();
    if (isNaN(winsAdj) || isNaN(lossesAdj)) return interaction.reply({ content: 'Invalid numbers.', ephemeral: true });
    const user = userRepo.findByDiscordId(targetId);
    if (!user) return interaction.reply({ content: `User ${targetId} not found.`, ephemeral: true });
    if (winsAdj !== 0) db.prepare('UPDATE users SET total_wins = MAX(0, total_wins + ?) WHERE id = ?').run(winsAdj, user.id);
    if (lossesAdj !== 0) db.prepare('UPDATE users SET total_losses = MAX(0, total_losses + ?) WHERE id = ?').run(lossesAdj, user.id);
    logAdminAction(interaction.user.id, 'adjust_wl', 'user', user.id, { winsAdj, lossesAdj, reason });
    return interaction.reply({ content: `**W/L adjusted.** <@${targetId}>: ${winsAdj >= 0 ? '+' : ''}${winsAdj}W, ${lossesAdj >= 0 ? '+' : ''}${lossesAdj}L. Reason: ${reason}`, ephemeral: true });
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
    return interaction.reply({ content: `**Earnings adjusted.** <@${targetId}>: ${usdcAmount >= 0 ? '+' : ''}$${usdcAmount.toFixed(2)} USDC. Reason: ${reason}`, ephemeral: true });
  }
}

module.exports = { postAllLeaderboardPanels, handleLeaderboardButton, handleLeaderboardSelect, handleAdminModal, getCurrentSeason, setCurrentSeason };
