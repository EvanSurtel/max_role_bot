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

// Per-player queue idle timeout — each player is removed individually
// after sitting in the queue for 1 hour without a match filling. The
// queue, the panel, and other players are NOT touched. A background
// sweep runs every minute and pulls out anyone whose joinedAt is older
// than the cap. Replaces the prior whole-queue wipe (which deleted the
// entire roster + made the panel feel broken to anyone still sitting
// there).
const PLAYER_IDLE_CAP_MS = 60 * 60 * 1000;     // 1 hour
const SWEEP_INTERVAL_MS = 60 * 1000;           // check every minute
let _sweepInterval = null;

function _startStalePlayerSweep(client) {
  if (_sweepInterval) return; // already running — sweeps are idempotent
  _sweepInterval = setInterval(async () => {
    try {
      const now = Date.now();
      const players = queueService.getQueuePlayers();
      const stale = players.filter(p => p.joinedAt && (now - p.joinedAt) >= PLAYER_IDLE_CAP_MS);
      if (stale.length === 0) return;

      for (const p of stale) {
        queueService.leaveQueue(p.discordId);
        console.log(`[QueuePanel] Removed idle player ${p.discordId} after ${Math.round((now - p.joinedAt) / 60000)} minutes in queue`);
      }

      // Surface the removal in the panel's _lastAction slot — same
      // mechanism as "Player Joined Queue!" / "Player Left Queue!"
      // — so it's just another line in the existing panel rather
      // than a separate channel message that adds noise.
      const names = stale.map(p => `<@${p.discordId}>`).join(', ');
      _lastAction = stale.length === 1
        ? `**Player Removed (Idle 1h)!**\n${names}`
        : `**Players Removed (Idle 1h)!**\n${names}`;

      // Refresh the panel so the roster + _lastAction reflect the
      // removals. Do NOT touch _lastPingedAt — fill-progress pings
      // are scoped to the lifecycle of a match, not to individual
      // idle drops, so a 7/8/9-player ping that already fired this
      // cycle stays fired.
      await _refreshPanelInChannel(client);
    } catch (err) {
      console.error('[QueuePanel] Stale-player sweep failed:', err.message);
    }
  }, SWEEP_INTERVAL_MS);
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

  // Build description with explicit blank line between "Player Joined"
  // and the "Queue X/10" roster. Using ​ (zero-width space) for
  // the blank line because Discord collapses bare empty strings, and
  // filtering with Boolean would strip the spacer when _lastAction is
  // empty.
  // Spacing chosen to match the reference panel — generous breathing
  // room between the recent-action banner, the live roster, and the
  // bottom of the embed (which sits above the action buttons). Each
  // '​' is a zero-width space — Discord renders them as a real
  // blank line, while plain empty strings get collapsed.
  const SPACER = '​'; // zero-width space
  const lines = [];
  if (_lastAction) {
    lines.push(_lastAction);
    for (let i = 0; i < 4; i++) lines.push(SPACER);
  }
  lines.push(`**Queue ${count}/${QUEUE_CONFIG.TOTAL_PLAYERS}**`);
  if (playerList) lines.push(playerList);
  for (let i = 0; i < 4; i++) lines.push(SPACER);

  const embed = new EmbedBuilder()
    .setTitle('5v5 Ranked Queue — Hardpoint | Bo3')
    .setColor(0x3498db)
    .setDescription(lines.join('\n'))
    .setTimestamp();

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
        content: 'You need to register first. Head to **#welcome** and accept the Terms of Service.',
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

    // Start the per-player idle sweep on first join (idempotent).
    // The sweep removes individual players sitting >1h, never the
    // whole queue.
    _startStalePlayerSweep(interaction.client);

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
      // Reset ping state for the next fill cycle. The per-player
      // idle sweep keeps running independent of fill cycles.
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

    // If queue is now empty, reset ping state. The per-player idle
    // sweep keeps running — it'll just have nothing to do until
    // someone joins.
    if (queueService.getQueueSize() === 0) {
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
  // Reset 7/8/9-player ping flags. Called by queueState.createMatch so
  // EVERY fill cycle (panel button OR rejoin-after-no-show) resets the
  // pings — without this, the rejoin path bypassed the panel-button
  // reset and pings stopped firing after a few cycles.
  resetPingState() {
    for (const k of Object.keys(_lastPingedAt)) delete _lastPingedAt[k];
  },
};
