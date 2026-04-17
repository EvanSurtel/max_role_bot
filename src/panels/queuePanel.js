// Ranked queue join/leave panel — posted in RANKED_QUEUE_CHANNEL_ID.
//
// Shows current queue status and lets users join/leave with buttons.
// When the queue fills to 10, automatically triggers match creation.
// Uses interaction.update() to refresh the shared panel in-place
// (not ephemeral) so everyone sees the current player list.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { buildLanguageDropdownRow } = require('../utils/languageButtonHelper');
const queueService = require('../queue');
const QUEUE_CONFIG = require('../config/queueConfig');
const userRepo = require('../database/repositories/userRepo');
const onboarding = require('../interactions/onboarding');

// ═══════════════════════════════════════════════════════════════════
// Panel builder
// ═══════════════════════════════════════════════════════════════════

/**
 * Build the ranked queue panel embed + buttons.
 */
function buildQueuePanel(lang = 'en') {
  const players = queueService.getQueuePlayers();
  const count = players.length;

  // Build player list lines
  let playerList = '';
  if (count === 0) {
    playerList = '_No players in queue._';
  } else {
    playerList = players
      .map((p, i) => {
        const xpStr = p.xp != null ? p.xp.toLocaleString() : '0';
        return `${i + 1}. <@${p.discordId}> — ${xpStr} XP`;
      })
      .join('\n');
  }

  const embed = new EmbedBuilder()
    .setTitle('5v5 Ranked Queue')
    .setColor(0x3498db)
    .setDescription([
      'Click **Join Queue** to enter. When 10 players are ready, the match begins.',
      '',
      `**Players in Queue: ${count}/${QUEUE_CONFIG.TOTAL_PLAYERS}**`,
      '',
      playerList,
    ].join('\n'))
    .setFooter({ text: 'Hardpoint | Bo3 | 5v5' });

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ranked_queue_join')
      .setLabel('Join Queue')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('ranked_queue_leave')
      .setLabel('Leave Queue')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('ranked_queue_refresh')
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [actionRow, ...buildLanguageDropdownRow(lang)] };
}

// ═══════════════════════════════════════════════════════════════════
// Post / refresh panel
// ═══════════════════════════════════════════════════════════════════

/**
 * Post (or update) the queue panel in the configured channel.
 * Follows the same pattern as lobbyPanel.postLobbyPanel.
 */
async function postQueuePanel(client, lang = 'en') {
  const channelId = process.env.RANKED_QUEUE_CHANNEL_ID;
  if (!channelId) {
    console.warn('[QueuePanel] RANKED_QUEUE_CHANNEL_ID not set — skipping queue panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn(`[QueuePanel] Queue channel ${channelId} not found in cache`);
    return;
  }

  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    const existingPanel = botMessages.find(m => m.embeds.length > 0);
    const panel = buildQueuePanel(lang);

    if (existingPanel) {
      // Clean up extra bot messages, keep only the panel
      for (const [, m] of botMessages) {
        if (m.id !== existingPanel.id) try { await m.delete(); } catch { /* */ }
      }
      await existingPanel.edit(panel);
      console.log(`[QueuePanel] Updated existing queue panel (${lang})`);
    } else {
      // Remove any leftover bot messages, post fresh
      for (const [, m] of botMessages) { try { await m.delete(); } catch { /* */ } }
      await channel.send(panel);
      console.log(`[QueuePanel] Posted new queue panel (${lang})`);
    }
  } catch (err) {
    console.error('[QueuePanel] Failed to post queue panel:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Interaction handler
// ═══════════════════════════════════════════════════════════════════

/**
 * Handle join/leave/refresh button presses on the queue panel.
 * Uses interaction.update() to refresh the panel in-place.
 */
async function handleQueueButton(interaction) {
  const id = interaction.customId;
  const discordId = interaction.user.id;

  // ── Refresh ──────────────────────────────────────────────────
  if (id === 'ranked_queue_refresh') {
    return interaction.update(buildQueuePanel());
  }

  // ── Join ─────────────────────────────────────────────────────
  if (id === 'ranked_queue_join') {
    // Check if user is registered (accepted TOS + has wallet)
    const user = userRepo.findByDiscordId(discordId);
    if (!user || !user.accepted_tos) {
      return interaction.reply({
        content: 'You need to register first. Head to the welcome channel and accept the Terms of Service.',
        ephemeral: true,
        _autoDeleteMs: 15_000,
      });
    }

    // Check if already in queue
    if (queueService.isInQueue(discordId)) {
      return interaction.reply({
        content: 'You are already in the queue.',
        ephemeral: true,
        _autoDeleteMs: 10_000,
      });
    }

    // Check if in an active queue match
    const activeMatchId = queueService.isInActiveMatch(discordId);
    if (activeMatchId) {
      return interaction.reply({
        content: `You are already in an active queue match (#${activeMatchId}). Finish that match first.`,
        ephemeral: true,
        _autoDeleteMs: 10_000,
      });
    }

    // Check if in a wager/XP match (cross-system check)
    const { isPlayerBusy } = require('../utils/playerStatus');
    const busy = isPlayerBusy(user.id, discordId);
    if (busy.busy) {
      return interaction.reply({
        content: busy.reason,
        ephemeral: true,
        _autoDeleteMs: 10_000,
      });
    }

    const xp = user.xp_points || 0;
    const newSize = queueService.joinQueue(discordId, xp);

    // Update the panel in-place so everyone sees the new list
    await interaction.update(buildQueuePanel());

    // Check if queue is full
    if (newSize >= QUEUE_CONFIG.TOTAL_PLAYERS) {
      try {
        const guild = interaction.guild || interaction.client.guilds.cache.get(process.env.GUILD_ID);
        if (guild) {
          await queueService.createMatch(interaction.client, guild);

          // Refresh the panel to show the queue is now empty (players were popped)
          await _refreshPanelInChannel(interaction.client);
        }
      } catch (err) {
        console.error('[QueuePanel] Failed to create match from full queue:', err.message);
      }
    }

    return;
  }

  // ── Leave ────────────────────────────────────────────────────
  if (id === 'ranked_queue_leave') {
    if (!queueService.isInQueue(discordId)) {
      return interaction.reply({
        content: 'You are not in the queue.',
        ephemeral: true,
        _autoDeleteMs: 10_000,
      });
    }

    queueService.leaveQueue(discordId);
    return interaction.update(buildQueuePanel());
  }
}

// ═══════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Re-fetch and edit the panel message in the queue channel. Used after
 * match creation empties the queue — the interaction.update() already
 * happened for the joining player, but the panel needs a second refresh
 * to reflect the now-empty queue.
 */
async function _refreshPanelInChannel(client) {
  const channelId = process.env.RANKED_QUEUE_CHANNEL_ID;
  if (!channelId) return;

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    const botPanel = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
    if (botPanel) {
      await botPanel.edit(buildQueuePanel());
    }
  } catch (err) {
    console.error('[QueuePanel] Failed to refresh panel after match creation:', err.message);
  }
}

module.exports = { buildQueuePanel, postQueuePanel, handleQueueButton };
