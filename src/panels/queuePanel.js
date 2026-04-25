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

// Track which thresholds have been pinged this fill cycle (7/10, 8/10, 9/10).
// Reset when the queue empties (match created) or times out.
const _lastPingedAt = {};

// Shows "Player Joined Queue!" / "Player Left Queue!" at the top of the embed.
let _lastAction = '';

// 1-hour queue timeout — if the queue doesn't fill in 60 minutes,
// remove all waiting players and reset. Prevents players from being
// stuck in a queue that will never fill (late night, low population).
const QUEUE_TIMEOUT_MS = 60 * 60 * 1000;
let _queueTimeoutTimer = null;

function _startQueueTimeout(client) {
  _clearQueueTimeout();
  _queueTimeoutTimer = setTimeout(async () => {
    const size = queueService.getQueueSize();
    if (size === 0) return;

    console.log(`[QueuePanel] Queue timeout — removing ${size} player(s) after 1 hour`);

    // Clear the queue
    const players = queueService.getQueuePlayers();
    for (const p of players) {
      queueService.leaveQueue(p.discordId);
    }

    // Reset ping thresholds
    for (const k of Object.keys(_lastPingedAt)) delete _lastPingedAt[k];

    // Notify in the queue channel
    const channelId = process.env.RANKED_QUEUE_CHANNEL_ID;
    const ch = client?.channels?.cache?.get(channelId);
    if (ch) {
      ch.send({
        content: 'Queue has been cleared — not enough players joined within 1 hour. Join again when ready!',
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }

    // Refresh the panel
    await _refreshPanelInChannel(client);
  }, QUEUE_TIMEOUT_MS);
}

function _clearQueueTimeout() {
  if (_queueTimeoutTimer) {
    clearTimeout(_queueTimeoutTimer);
    _queueTimeoutTimer = null;
  }
}

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
  const playerList = count > 0
    ? players.map(p => `<@${p.discordId}>`).join(', ')
    : '';

  const embed = new EmbedBuilder()
    .setTitle('5v5 Ranked Queue')
    .setColor(0x3498db)
    .setDescription([
      _lastAction || '',
      '',
      'Click **Join Queue** to enter. When 10 players are ready, the match begins.',
      '',
      `**Players in Queue: ${count}/${QUEUE_CONFIG.TOTAL_PLAYERS}**`,
      playerList,
    ].filter(Boolean).join('\n'))
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
  );

  // No language dropdown on the queue panel — it updates frequently
  // as players join/leave, and the content is universal enough
  // (player names + XP numbers) that translation isn't needed.
  return { embeds: [embed], components: [actionRow] };
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

    // Block queue join while season-end pause is active. Without
    // this, players could accumulate in the queue during the season-
    // transition window and form a fresh match between the admin's
    // "End Season" click and the XP reset, which would clobber the
    // new match's roster with starting XP. seasonPanel's
    // handleSeasonModal also re-checks matches_paused at submit
    // time as defense in depth.
    try {
      const { isMatchesPaused } = require('./seasonPanel');
      if (isMatchesPaused()) {
        return interaction.reply({
          content: 'Match creation is paused for a season transition. Try again once the new season starts.',
          ephemeral: true,
          _autoDeleteMs: 15_000,
        });
      }
    } catch { /* season panel not loaded — fall through */ }

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
    _lastAction = `**Player Joined Queue!**\n<@${discordId}>`;

    // Start the 1-hour timeout on first join. Resets if someone
    // else joins later (timer restarts). Clears when queue fills.
    if (newSize === 1) {
      _startQueueTimeout(interaction.client);
    }

    // Update the panel in-place so everyone sees the new list
    await interaction.update(buildQueuePanel());

    // Auto-ping when queue is almost full (7/10, 8/10, 9/10).
    // Only ping ONCE per threshold per fill cycle — the state
    // resets when the queue empties (match created or timeout).
    const PING_THRESHOLDS = [7, 8, 9];
    if (PING_THRESHOLDS.includes(newSize) && newSize < QUEUE_CONFIG.TOTAL_PLAYERS) {
      if (!_lastPingedAt[newSize]) {
        _lastPingedAt[newSize] = true;
        const channelId = process.env.RANKED_QUEUE_CHANNEL_ID;
        const ch = interaction.client.channels.cache.get(channelId);
        if (ch) {
          const remaining = QUEUE_CONFIG.TOTAL_PLAYERS - newSize;
          ch.send({
            content: `**${newSize}/${QUEUE_CONFIG.TOTAL_PLAYERS}** in queue — ${remaining} more needed! 🎮`,
            allowedMentions: { parse: [] },
          }).catch(() => {});
        }
      }
    }

    // Check if queue is full
    if (newSize >= QUEUE_CONFIG.TOTAL_PLAYERS) {
      // Clear timeout + ping state for the next fill cycle
      _clearQueueTimeout();
      for (const k of Object.keys(_lastPingedAt)) delete _lastPingedAt[k];

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
    _lastAction = `**Player Left Queue!**\n<@${discordId}>`;

    // If queue is now empty, clear the timeout + ping state
    if (queueService.getQueueSize() === 0) {
      _clearQueueTimeout();
      for (const k of Object.keys(_lastPingedAt)) delete _lastPingedAt[k];
    }

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

module.exports = {
  buildQueuePanel,
  postQueuePanel,
  handleQueueButton,
  // Lightweight panel refresher (fetch limit 10, edit in place).
  // Used by external flows (e.g. the staff-cancel Rejoin Queue button)
  // to sync the shared panel without the 50-message scan that
  // postQueuePanel does on first-run.
  refreshQueuePanel: _refreshPanelInChannel,
};
