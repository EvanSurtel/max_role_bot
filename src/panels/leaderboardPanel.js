const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const { USDC_PER_UNIT, CURRENT_SEASON } = require('../config/constants');

const REGIONS = ['global', 'na', 'latam', 'eu', 'asia'];
const REGION_LABELS = {
  global: 'Global',
  na: 'NA',
  latam: 'LATAM',
  eu: 'EU',
  asia: 'Asia',
};

/**
 * Build the leaderboard panel.
 */
function buildLeaderboardPanel() {
  const embed = new EmbedBuilder()
    .setTitle('Leaderboards')
    .setColor(0x5865F2)
    .setDescription('Select a leaderboard type, then a region.');

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('lb_alltime').setLabel('All-Time XP').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('lb_season').setLabel(`Season (${CURRENT_SEASON})`).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('lb_earnings').setLabel('Earnings').setStyle(ButtonStyle.Success),
  );

  const row2 = new ActionRowBuilder().addComponents(
    ...REGIONS.map(r =>
      new ButtonBuilder()
        .setCustomId(`lb_region_${r}`)
        .setLabel(REGION_LABELS[r])
        .setStyle(r === 'global' ? ButtonStyle.Secondary : ButtonStyle.Secondary),
    ),
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Post (or refresh) the leaderboard panel.
 */
async function postLeaderboardPanel(client) {
  const channelId = process.env.LEADERBOARD_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] LEADERBOARD_CHANNEL_ID not set — skipping leaderboard panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[Panel] Leaderboard channel ${channelId} not found`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    const existingPanel = messages.find(
      m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0]?.title === 'Leaderboards',
    );

    const panel = buildLeaderboardPanel();

    if (existingPanel) {
      await existingPanel.edit(panel);
      console.log('[Panel] Updated existing leaderboard panel');
    } else {
      await channel.send(panel);
      console.log('[Panel] Posted new leaderboard panel');
    }
  } catch (err) {
    console.error('[Panel] Failed to post leaderboard panel:', err.message);
  }
}

// Track selected region per user (default: global)
const userRegionSelection = new Map();

/**
 * Handle leaderboard button clicks.
 */
async function handleLeaderboardButton(interaction) {
  const id = interaction.customId;
  const callerId = interaction.user.id;
  const db = require('../database/db');

  // Region selection — store and show instruction
  if (id.startsWith('lb_region_')) {
    const region = id.replace('lb_region_', '');
    userRegionSelection.set(callerId, region);
    return interaction.reply({
      content: `Region set to **${REGION_LABELS[region]}**. Now click a leaderboard type above.`,
      ephemeral: true,
    });
  }

  const region = userRegionSelection.get(callerId) || 'global';
  const regionFilter = region === 'global' ? '' : ' AND region = ?';
  const regionParams = region === 'global' ? [] : [region];

  if (id === 'lb_alltime') {
    const rows = db.prepare(
      `SELECT * FROM users WHERE accepted_tos = 1 AND xp_points > 0${regionFilter} ORDER BY xp_points DESC LIMIT 10`
    ).all(...regionParams);

    return showLeaderboard(interaction, `${REGION_LABELS[region]} — All-Time XP`, rows, callerId, (row) => {
      const record = `${row.total_wins || 0}W-${row.total_losses || 0}L`;
      return `${row.xp_points.toLocaleString()} XP | ${record}`;
    }, 0x5865F2);
  }

  if (id === 'lb_season') {
    // Sum XP from xp_history for current season
    const rows = db.prepare(`
      SELECT u.*, COALESCE(SUM(xh.xp_amount), 0) as season_xp
      FROM users u
      LEFT JOIN xp_history xh ON xh.user_id = u.id AND xh.season = ?
      WHERE u.accepted_tos = 1${regionFilter}
      GROUP BY u.id
      HAVING season_xp > 0
      ORDER BY season_xp DESC
      LIMIT 10
    `).all(CURRENT_SEASON, ...regionParams);

    return showLeaderboard(interaction, `${REGION_LABELS[region]} — Season ${CURRENT_SEASON}`, rows, callerId, (row) => {
      const record = `${row.total_wins || 0}W-${row.total_losses || 0}L`;
      return `${row.season_xp.toLocaleString()} XP | ${record}`;
    }, 0xe67e22);
  }

  if (id === 'lb_earnings') {
    const rows = db.prepare(
      `SELECT * FROM users WHERE accepted_tos = 1 AND CAST(total_earnings_usdc AS INTEGER) > 0${regionFilter} ORDER BY CAST(total_earnings_usdc AS INTEGER) DESC LIMIT 10`
    ).all(...regionParams);

    return showLeaderboard(interaction, `${REGION_LABELS[region]} — Earnings`, rows, callerId, (row) => {
      const usdc = (Number(row.total_earnings_usdc) / USDC_PER_UNIT).toFixed(2);
      return `$${usdc} USDC earned`;
    }, 0x57F287);
  }
}

/**
 * Helper to build and send a leaderboard embed.
 */
function showLeaderboard(interaction, title, rows, callerId, formatLine, color) {
  if (rows.length === 0) {
    return interaction.reply({ content: `No data for ${title} yet.`, ephemeral: true });
  }

  const lines = rows.map((row, i) => {
    const ign = row.cod_ign ? ` (${row.cod_ign})` : '';
    return `**#${i + 1}.** <@${row.discord_id}>${ign} — ${formatLine(row)}`;
  });

  // Show caller's rank if not in top 10
  const callerInTop = rows.some(r => r.discord_id === callerId);
  if (!callerInTop) {
    const callerUser = userRepo.findByDiscordId(callerId);
    if (callerUser && callerUser.xp_points > 0) {
      lines.push('');
      lines.push(`**You:** <@${callerId}> — ${formatLine(callerUser)}`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setColor(color)
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { buildLeaderboardPanel, postLeaderboardPanel, handleLeaderboardButton };
