const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const { USDC_PER_UNIT } = require('../config/constants');

const REGIONS = ['global', 'na', 'latam', 'eu', 'asia'];
const REGION_LABELS = {
  global: 'Global',
  na: 'North America',
  latam: 'Latin America',
  eu: 'Europe',
  asia: 'Asia',
};

/**
 * Build the leaderboard panel — posted in the leaderboard channel on startup.
 */
function buildLeaderboardPanel() {
  const embed = new EmbedBuilder()
    .setTitle('Leaderboards')
    .setColor(0x5865F2)
    .setDescription('Select a region to view the leaderboard.');

  const row = new ActionRowBuilder().addComponents(
    ...REGIONS.map(region =>
      new ButtonBuilder()
        .setCustomId(`lb_${region}`)
        .setLabel(REGION_LABELS[region])
        .setStyle(region === 'global' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );

  return { embeds: [embed], components: [row] };
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
    console.warn(`[Panel] Leaderboard channel ${channelId} not found in cache`);
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

/**
 * Handle leaderboard region button clicks.
 */
async function handleLeaderboardButton(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('lb_')) return;

  const region = id.replace('lb_', '');
  if (!REGIONS.includes(region)) return;

  const callerId = interaction.user.id;
  const db = require('../database/db');

  // Query users filtered by region (global = all)
  let rows;
  if (region === 'global') {
    rows = db.prepare(
      'SELECT * FROM users WHERE accepted_tos = 1 AND xp_points > 0 ORDER BY xp_points DESC LIMIT 10'
    ).all();
  } else {
    rows = db.prepare(
      'SELECT * FROM users WHERE accepted_tos = 1 AND region = ? AND xp_points > 0 ORDER BY xp_points DESC LIMIT 10'
    ).all(region);
  }

  if (rows.length === 0) {
    return interaction.reply({
      content: `No players on the ${REGION_LABELS[region]} leaderboard yet.`,
      ephemeral: true,
    });
  }

  const lines = rows.map((row, i) => {
    const earnings = Number(row.total_earnings_usdc || 0) / USDC_PER_UNIT;
    const record = `${row.total_wins || 0}W - ${row.total_losses || 0}L`;
    return `**#${i + 1}.** <@${row.discord_id}> — ${row.xp_points.toLocaleString()} XP | ${record} | $${earnings.toFixed(2)} earned`;
  });

  // Check if caller is in top 10
  const callerInTop = rows.some(r => r.discord_id === callerId);
  if (!callerInTop) {
    const callerUser = userRepo.findByDiscordId(callerId);
    if (callerUser && callerUser.xp_points > 0) {
      let allUsers;
      if (region === 'global') {
        allUsers = db.prepare(
          'SELECT * FROM users WHERE accepted_tos = 1 AND xp_points > 0 ORDER BY xp_points DESC'
        ).all();
      } else {
        allUsers = db.prepare(
          'SELECT * FROM users WHERE accepted_tos = 1 AND region = ? AND xp_points > 0 ORDER BY xp_points DESC'
        ).all(region);
      }
      const callerIndex = allUsers.findIndex(r => r.discord_id === callerId);
      if (callerIndex !== -1) {
        const earnings = Number(callerUser.total_earnings_usdc || 0) / USDC_PER_UNIT;
        const record = `${callerUser.total_wins || 0}W - ${callerUser.total_losses || 0}L`;
        lines.push('');
        lines.push(`**#${callerIndex + 1}.** <@${callerId}> — ${callerUser.xp_points.toLocaleString()} XP | ${record} | $${earnings.toFixed(2)} earned`);
      }
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(`${REGION_LABELS[region]} Leaderboard`)
    .setDescription(lines.join('\n'))
    .setColor(0x5865F2)
    .setTimestamp();

  return interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { buildLeaderboardPanel, postLeaderboardPanel, handleLeaderboardButton };
