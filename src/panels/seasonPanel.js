const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { getCurrentSeason, setCurrentSeason } = require('./leaderboardPanel');
const neatqueueService = require('../services/neatqueueService');
const { logAdminAction } = require('../utils/adminAudit');

/**
 * Check if match creation is paused (stored in bot_settings).
 */
function isMatchesPaused() {
  try {
    const db = require('../database/db');
    const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'matches_paused'").get();
    return row && row.value === 'true';
  } catch {
    return false;
  }
}

/**
 * Set the match pause state.
 */
function setMatchesPaused(paused) {
  const db = require('../database/db');
  try {
    db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('matches_paused', ?)").run(paused ? 'true' : 'false');
  } catch {
    db.prepare('CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)').run();
    db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('matches_paused', ?)").run(paused ? 'true' : 'false');
  }
}

/**
 * Get count of active matches (not yet completed/cancelled).
 */
function getActiveMatchCount() {
  const db = require('../database/db');
  const row = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('active', 'voting', 'disputed')").get();
  return row?.c || 0;
}

/**
 * Build the season management panel for admin channel.
 */
function buildSeasonPanel() {
  const paused = isMatchesPaused();
  const activeMatches = getActiveMatchCount();
  const season = getCurrentSeason();

  const embed = new EmbedBuilder()
    .setTitle('Season Management')
    .setColor(paused ? 0xe74c3c : 0x2ecc71)
    .setDescription([
      `**Current Season:** ${season}`,
      `**Match Creation:** ${paused ? 'PAUSED' : 'Active'}`,
      `**Active Matches:** ${activeMatches}`,
      '',
      paused
        ? activeMatches > 0
          ? 'Waiting for active matches to finish before season can end.'
          : 'All matches complete. Ready to end season and start a new one.'
        : 'Matches are running normally. Pause match creation to prepare for a season transition.',
    ].join('\n'))
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('season_pause')
      .setLabel(paused ? 'Matches Paused' : 'Pause Matches')
      .setStyle(paused ? ButtonStyle.Secondary : ButtonStyle.Danger)
      .setDisabled(paused),
    new ButtonBuilder()
      .setCustomId('season_resume')
      .setLabel('Resume Matches')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!paused),
    new ButtonBuilder()
      .setCustomId('season_refresh')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('season_end')
      .setLabel('End Season & Start New')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!paused || activeMatches > 0),
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Post the season panel in the admin alerts channel.
 */
async function postSeasonPanel(client) {
  const channelId = process.env.SEASON_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] SEASON_CHANNEL_ID not set — skipping season panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    const existing = messages.find(
      m => m.author.id === client.user.id && m.embeds[0]?.title === 'Season Management',
    );
    const panel = buildSeasonPanel();
    if (existing) {
      await existing.edit(panel);
    } else {
      await channel.send(panel);
    }
    console.log('[Panel] Posted season management panel');
  } catch (err) {
    console.error('[Panel] Failed to post season panel:', err.message);
  }
}

/**
 * Handle season management buttons.
 */
async function handleSeasonButton(interaction) {
  const id = interaction.customId;

  // Check admin
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (adminRoleId && !interaction.member.roles.cache.has(adminRoleId)) {
    return interaction.reply({ content: 'Admin only.', ephemeral: true });
  }

  if (id === 'season_refresh') {
    const panel = buildSeasonPanel();
    return interaction.update(panel);
  }

  if (id === 'season_pause') {
    setMatchesPaused(true);
    logAdminAction(interaction.user.id, 'pause_matches', 'system', 0, { season: getCurrentSeason() });

    // Try to pause NeatQueue
    if (neatqueueService.isConfigured()) {
      try {
        await pauseNeatQueue();
      } catch (err) {
        console.warn('[Season] Failed to pause NeatQueue:', err.message);
      }
    }

    await interaction.reply({
      content: '**Matches paused.** No new wagers, XP matches, or NeatQueue queues can be created. Existing matches will continue until finished.',
      ephemeral: true,
    });

    const panel = buildSeasonPanel();
    return interaction.message.edit(panel);
  }

  if (id === 'season_resume') {
    setMatchesPaused(false);
    logAdminAction(interaction.user.id, 'resume_matches', 'system', 0, { season: getCurrentSeason() });

    // Try to resume NeatQueue
    if (neatqueueService.isConfigured()) {
      try {
        await resumeNeatQueue();
      } catch (err) {
        console.warn('[Season] Failed to resume NeatQueue:', err.message);
      }
    }

    await interaction.reply({
      content: '**Matches resumed.** Wagers, XP matches, and NeatQueue queues are active again.',
      ephemeral: true,
    });

    const panel = buildSeasonPanel();
    return interaction.message.edit(panel);
  }

  if (id === 'season_end') {
    const activeMatches = getActiveMatchCount();
    if (activeMatches > 0) {
      return interaction.reply({
        content: `Cannot end season — ${activeMatches} match(es) still active. Wait for them to finish.`,
        ephemeral: true,
      });
    }

    // Show modal for new season name
    const modal = new ModalBuilder()
      .setCustomId('season_end_modal')
      .setTitle('End Season & Start New');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('new_season_name')
          .setLabel(`Ending: ${getCurrentSeason()}. New season name:`)
          .setPlaceholder('e.g. 2026-S2')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(20),
      ),
    );

    return interaction.showModal(modal);
  }
}

/**
 * Handle the end season modal.
 */
async function handleSeasonModal(interaction) {
  if (interaction.customId !== 'season_end_modal') return;

  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (adminRoleId && !interaction.member.roles.cache.has(adminRoleId)) {
    return interaction.reply({ content: 'Admin only.', ephemeral: true });
  }

  const newSeason = interaction.fields.getTextInputValue('new_season_name').trim();
  const oldSeason = getCurrentSeason();
  const db = require('../database/db');

  await interaction.deferReply();

  try {
    // 1. Save season snapshot — the xp_history table already has all data
    //    Just log the season end event
    logAdminAction(interaction.user.id, 'end_season', 'system', 0, {
      oldSeason,
      newSeason,
      totalPlayers: db.prepare('SELECT COUNT(*) as c FROM users WHERE accepted_tos = 1').get()?.c || 0,
    });

    // 2. Reset XP for all users to starting value (500)
    const STARTING_XP = 500;
    db.prepare('UPDATE users SET xp_points = ?, total_wins = 0, total_losses = 0 WHERE accepted_tos = 1').run(STARTING_XP);
    console.log(`[Season] Reset all users to ${STARTING_XP} XP, 0W-0L`);

    // 3. Set new season
    setCurrentSeason(newSeason);

    // 4. Resume matches for the new season
    setMatchesPaused(false);

    // 5. Reset NeatQueue stats and resume
    if (neatqueueService.isConfigured()) {
      try {
        await resetNeatQueue();
        console.log('[Season] NeatQueue stats reset');
      } catch (err) {
        console.warn('[Season] Failed to reset NeatQueue:', err.message);
      }

      // Set starting points (500) for all registered users in NeatQueue
      try {
        const allUsers = db.prepare('SELECT discord_id FROM users WHERE accepted_tos = 1').all();
        for (const u of allUsers) {
          await neatqueueService.addPoints(u.discord_id, STARTING_XP).catch(() => {});
        }
        console.log(`[Season] Set ${allUsers.length} users to ${STARTING_XP} starting XP in NeatQueue`);
      } catch (err) {
        console.warn('[Season] Failed to set NeatQueue starting points:', err.message);
      }

      try {
        await resumeNeatQueue();
      } catch (err) {
        console.warn('[Season] Failed to resume NeatQueue:', err.message);
      }
    }

    await interaction.editReply({
      content: [
        `**Season transition complete!**`,
        '',
        `**${oldSeason}** has ended. All season data preserved in history.`,
        `**${newSeason}** has started. All players reset to 500 XP, 0W-0L.`,
        'NeatQueue stats reset and starting points applied.',
        '',
        'Match creation is now active. Good luck everyone!',
      ].join('\n'),
    });

    // Update the season panel
    const panel = buildSeasonPanel();
    try {
      const channelId = process.env.SEASON_CHANNEL_ID;
      if (channelId) {
        const channel = interaction.client.channels.cache.get(channelId);
        if (channel) {
          const messages = await channel.messages.fetch({ limit: 10 });
          const existing = messages.find(
            m => m.author.id === interaction.client.user.id && m.embeds[0]?.title === 'Season Management',
          );
          if (existing) await existing.edit(panel);
        }
      }
    } catch { /* */ }

    console.log(`[Season] Season ended: ${oldSeason} → ${newSeason}`);
  } catch (err) {
    console.error('[Season] Error ending season:', err);
    await interaction.editReply({ content: 'Failed to end season. Check logs.' });
  }
}

/**
 * Reset all NeatQueue stats (points, wins, losses, MMR) for the queue.
 */
async function resetNeatQueue() {
  const token = process.env.NEATQUEUE_API_TOKEN;
  const channelId = process.env.NEATQUEUE_CHANNEL_ID;
  const guildId = process.env.GUILD_ID;
  if (!token || !channelId) return;

  const res = await fetch('https://api.neatqueue.com/api/v2/managestats/reset/all', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ server_id: parseInt(guildId), channel_id: parseInt(channelId) }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[NeatQueue] Reset failed (${res.status}): ${body}`);
  }
}

/**
 * Try to pause NeatQueue via API.
 */
async function pauseNeatQueue() {
  const token = process.env.NEATQUEUE_API_TOKEN;
  const channelId = process.env.NEATQUEUE_CHANNEL_ID;
  if (!token || !channelId) return;

  await fetch('https://api.neatqueue.com/api/v2/queue/pause', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_id: parseInt(channelId) }),
  });
  console.log('[NeatQueue] Queue paused');
}

/**
 * Try to resume NeatQueue via API.
 */
async function resumeNeatQueue() {
  const token = process.env.NEATQUEUE_API_TOKEN;
  const channelId = process.env.NEATQUEUE_CHANNEL_ID;
  if (!token || !channelId) return;

  await fetch('https://api.neatqueue.com/api/v2/queue/resume', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel_id: parseInt(channelId) }),
  });
  console.log('[NeatQueue] Queue resumed');
}

module.exports = { isMatchesPaused, postSeasonPanel, handleSeasonButton, handleSeasonModal };
