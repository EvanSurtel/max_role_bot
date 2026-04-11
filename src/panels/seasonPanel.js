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
const { t, langFor } = require('../locales/i18n');

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
function buildSeasonPanel(lang = 'en') {
  const paused = isMatchesPaused();
  const activeMatches = getActiveMatchCount();
  const season = getCurrentSeason();

  const embed = new EmbedBuilder()
    .setTitle(t('season_panel.title', lang))
    .setColor(paused ? 0xe74c3c : 0x2ecc71)
    .setDescription([
      `**${t('season_panel.current_season', lang)}:** ${season}`,
      `**${t('season_panel.match_creation', lang)}:** ${paused ? t('season_panel.status_paused', lang) : t('season_panel.status_active', lang)}`,
      `**${t('season_panel.active_matches', lang)}:** ${activeMatches}`,
      '',
      paused
        ? activeMatches > 0
          ? t('season_panel.waiting_for_matches', lang)
          : t('season_panel.ready_to_end', lang)
        : t('season_panel.running_normally', lang),
    ].join('\n'))
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('season_pause')
      .setLabel(paused ? t('season_panel.btn_paused', lang) : t('season_panel.btn_pause', lang))
      .setStyle(paused ? ButtonStyle.Secondary : ButtonStyle.Danger)
      .setDisabled(paused),
    new ButtonBuilder()
      .setCustomId('season_resume')
      .setLabel(t('season_panel.btn_resume', lang))
      .setStyle(ButtonStyle.Success)
      .setDisabled(!paused),
    new ButtonBuilder()
      .setCustomId('season_refresh')
      .setLabel(t('season_panel.btn_refresh', lang))
      .setStyle(ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('season_end')
      .setLabel(t('season_panel.btn_end_season', lang))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!paused || activeMatches > 0),
    new ButtonBuilder()
      .setCustomId('lb_admin_change_season')
      .setLabel(t('season_panel.btn_change_name', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * Post the season panel in the admin alerts channel. Wipes any existing
 * bot messages and reposts so the panel always reflects the requested
 * language (title is translated, so we can't match the old one by title).
 */
async function postSeasonPanel(client, lang = 'en') {
  const channelId = process.env.SEASON_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] SEASON_CHANNEL_ID not set — skipping season panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    for (const [, m] of messages) {
      if (m.author.id === client.user.id) {
        try { await m.delete(); } catch { /* */ }
      }
    }
    const panel = buildSeasonPanel(lang);
    await channel.send(panel);
    console.log(`[Panel] Posted season management panel (${lang})`);
  } catch (err) {
    console.error('[Panel] Failed to post season panel:', err.message);
  }
}

/**
 * Handle season management buttons.
 *
 * The season panel is a SHARED admin message — panel rebuilds (refresh,
 * pause, resume) use the bot display language so the panel doesn't switch
 * into the clicker's preferred language for every other admin viewing it.
 * Ephemeral replies and modals shown only to the clicker still use their
 * personal language.
 */
async function handleSeasonButton(interaction) {
  const id = interaction.customId;
  const lang = langFor(interaction);
  const { getBotDisplayLanguage } = require('../utils/languageRefresh');
  const sharedLang = getBotDisplayLanguage();

  // Check admin — ads, CEO, and owner roles are admin-equivalent.
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  const ownerRoleId = process.env.OWNER_ROLE_ID;
  const ceoRoleId = process.env.CEO_ROLE_ID;
  const adsRoleId = process.env.ADS_ROLE_ID;
  const hasAdmin = adminRoleId && interaction.member.roles.cache.has(adminRoleId);
  const hasOwner = ownerRoleId && interaction.member.roles.cache.has(ownerRoleId);
  const hasCeo = ceoRoleId && interaction.member.roles.cache.has(ceoRoleId);
  const hasAds = adsRoleId && interaction.member.roles.cache.has(adsRoleId);
  if (!hasAdmin && !hasOwner && !hasCeo && !hasAds) {
    return interaction.reply({ content: t('season_panel.admin_only', lang), ephemeral: true });
  }

  if (id === 'season_refresh') {
    const panel = buildSeasonPanel(sharedLang);
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

    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({
      type: 'season_paused',
      discordId: interaction.user.id,
      memo: `Match creation paused by admin <@${interaction.user.id}> — Season: ${getCurrentSeason()}`,
    });

    await interaction.reply({
      content: t('season_panel.pause_msg', lang),
      ephemeral: true,
    });

    const panel = buildSeasonPanel(sharedLang);
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

    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({
      type: 'season_resumed',
      discordId: interaction.user.id,
      memo: `Match creation resumed by admin <@${interaction.user.id}> — Season: ${getCurrentSeason()}`,
    });

    await interaction.reply({
      content: t('season_panel.resume_msg', lang),
      ephemeral: true,
    });

    const panel = buildSeasonPanel(sharedLang);
    return interaction.message.edit(panel);
  }

  if (id === 'season_end') {
    const activeMatches = getActiveMatchCount();
    if (activeMatches > 0) {
      return interaction.reply({
        content: t('season_panel.cannot_end', lang, { n: activeMatches }),
        ephemeral: true,
      });
    }

    // Modal is shown only to this admin, so use their personal language.
    const modal = new ModalBuilder()
      .setCustomId('season_end_modal')
      .setTitle(t('season_panel.modal_title', lang));

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('new_season_name')
          .setLabel(t('season_panel.modal_label', lang, { old: getCurrentSeason() }))
          .setPlaceholder(t('season_panel.modal_placeholder', lang))
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

  const lang = langFor(interaction);
  // Admin-equivalent: ads, CEO, and owner roles share all admin powers.
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  const ownerRoleId = process.env.OWNER_ROLE_ID;
  const ceoRoleId = process.env.CEO_ROLE_ID;
  const adsRoleId = process.env.ADS_ROLE_ID;
  const hasAdmin = adminRoleId && interaction.member.roles.cache.has(adminRoleId);
  const hasOwner = ownerRoleId && interaction.member.roles.cache.has(ownerRoleId);
  const hasCeo = ceoRoleId && interaction.member.roles.cache.has(ceoRoleId);
  const hasAds = adsRoleId && interaction.member.roles.cache.has(adsRoleId);
  if (!hasAdmin && !hasOwner && !hasCeo && !hasAds) {
    return interaction.reply({ content: t('season_panel.admin_only', lang), ephemeral: true });
  }

  const newSeason = interaction.fields.getTextInputValue('new_season_name').trim();
  const oldSeason = getCurrentSeason();
  const db = require('../database/db');

  await interaction.deferReply();

  try {
    // 1. Save season snapshot — the xp_history table already has all data
    //    Just log the season end event
    const totalPlayers = db.prepare('SELECT COUNT(*) as c FROM users WHERE accepted_tos = 1').get()?.c || 0;
    logAdminAction(interaction.user.id, 'end_season', 'system', 0, {
      oldSeason,
      newSeason,
      totalPlayers,
    });
    const { postTransaction } = require('../utils/transactionFeed');
    postTransaction({
      type: 'season_ended',
      discordId: interaction.user.id,
      memo: `Season ended by admin <@${interaction.user.id}> — ${oldSeason} → ${newSeason} (${totalPlayers} players reset to 500 XP, 0W-0L)`,
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
        t('season_panel.season_ended_complete', lang),
        '',
        t('season_panel.season_ended_old', lang, { old: oldSeason }),
        t('season_panel.season_ended_new', lang, { new: newSeason }),
        t('season_panel.season_ended_neatqueue', lang),
        '',
        t('season_panel.season_ended_active', lang),
      ].join('\n'),
    });

    // Repost the season panel in the bot DISPLAY language (shared message,
    // visible to all admins) — not the clicker's language. We wipe + repost
    // because the translated title means we can't match the old one by title.
    try {
      const { getBotDisplayLanguage } = require('../utils/languageRefresh');
      const sharedLang = getBotDisplayLanguage();
      const channelId = process.env.SEASON_CHANNEL_ID;
      if (channelId) {
        const channel = interaction.client.channels.cache.get(channelId);
        if (channel) {
          const messages = await channel.messages.fetch({ limit: 20 });
          for (const [, m] of messages) {
            if (m.author.id === interaction.client.user.id) {
              try { await m.delete(); } catch { /* */ }
            }
          }
          await channel.send(buildSeasonPanel(sharedLang));
        }
      }
    } catch { /* */ }

    console.log(`[Season] Season ended: ${oldSeason} → ${newSeason}`);
  } catch (err) {
    console.error('[Season] Error ending season:', err);
    await interaction.editReply({ content: t('season_panel.failed_end', lang) });
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

module.exports = { isMatchesPaused, buildSeasonPanel, postSeasonPanel, handleSeasonButton, handleSeasonModal };
