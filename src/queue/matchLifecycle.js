// Match creation, no-show handling, resolution, and cancellation.
//
// Depends on state.js and helpers.js. Calls captainVote.js to start the
// voting phase after voice join. Called by playPhase.js and interactions.js
// when a match result is confirmed.

const { ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const QUEUE_CONFIG = require('../config/queueConfig');
const userRepo = require('../database/repositories/userRepo');
const { getCurrentSeason } = require('../panels/leaderboardPanel');
const {
  waitingQueue, activeMatches,
  _newQueueMatch, _newPlayer,
  nextMatchId,
  save: saveMatch,
  markResolved: markMatchResolved,
  markCancelled: markMatchCancelled,
} = require('./state');
const { _queueChannelOverwrites, _cleanupMatchChannels, findClosestXpReplacement } = require('./helpers');

/**
 * Pop 10 players from the queue, create Discord channels, and start
 * the voice-join countdown. Called automatically when queue size hits
 * TOTAL_PLAYERS.
 * @param {import('discord.js').Client} client — Discord client.
 * @param {import('discord.js').Guild} guild — The Discord guild.
 * @returns {Promise<object>} The QueueMatch object.
 */
async function createMatch(client, guild) {
  // Refuse if matches are paused for a season transition. Backstop
  // for queuePanel's join-time check; covers the edge where a join
  // raced past a just-flipped pause and the queue then filled.
  try {
    const { isMatchesPaused } = require('../panels/seasonPanel');
    if (isMatchesPaused()) {
      console.log('[Queue] createMatch aborted — matches paused for season transition');
      return null;
    }
  } catch { /* season panel not loaded */ }

  // Re-check the queue still has 10+ players. Between the queuePanel
  // handler's `newSize >= TOTAL_PLAYERS` check and the `await
  // interaction.update(...)` yield, a concurrent button click can
  // fire its own createMatch and drain the queue; when this call
  // resumes from the await, splice(0, 10) would build a short-count
  // "match" from whatever's left. The guard + splice are both
  // synchronous so no interleaving can slip between them.
  if (waitingQueue.length < QUEUE_CONFIG.TOTAL_PLAYERS) {
    console.log(
      `[Queue] createMatch aborted — queue no longer full ` +
      `(have ${waitingQueue.length}, need ${QUEUE_CONFIG.TOTAL_PLAYERS})`,
    );
    return null;
  }

  // Cross-system busy re-check against the would-be match roster.
  // The join-time check in queuePanel.js catches players who are
  // ALREADY in a wager/XP match, but a player can join a cash
  // challenge AFTER joining the queue and before it fills — at
  // createMatch time they'd be mid-wager and shouldn't be drafted
  // into a queue match. Scrub busy players out of the queue and
  // abort if that drops us below TOTAL_PLAYERS. The non-busy
  // players keep their queue position.
  const { isPlayerBusy } = require('../utils/playerStatus');
  const busyDiscordIds = [];
  for (let i = 0; i < QUEUE_CONFIG.TOTAL_PLAYERS; i++) {
    const entry = waitingQueue[i];
    const user = userRepo.findByDiscordId(entry.discordId);
    if (!user) continue;
    const busy = isPlayerBusy(user.id, entry.discordId);
    if (busy.busy) busyDiscordIds.push(entry.discordId);
  }
  if (busyDiscordIds.length > 0) {
    for (const discordId of busyDiscordIds) {
      const idx = waitingQueue.findIndex(p => p.discordId === discordId);
      if (idx !== -1) waitingQueue.splice(idx, 1);
    }
    console.warn(
      `[Queue] createMatch aborted — ${busyDiscordIds.length} player(s) ` +
      `(${busyDiscordIds.join(', ')}) are now busy in another match; ` +
      `removed from queue. Queue now at ${waitingQueue.length}.`,
    );
    return null;
  }

  const id = nextMatchId();
  const match = _newQueueMatch(id);

  // Pop 10 players (FIFO)
  const popped = waitingQueue.splice(0, QUEUE_CONFIG.TOTAL_PLAYERS);
  for (const entry of popped) {
    match.players.set(entry.discordId, _newPlayer(entry.discordId, entry.xp));
  }

  const allDiscordIds = [...match.players.keys()];

  // ── Discord channels ─────────────────────────────────────────
  // Create a category for this queue match
  const category = await guild.channels.create({
    name: `Queue #${match.id}`,
    type: ChannelType.GuildCategory,
    reason: 'Ranked queue match',
  });
  match.categoryId = category.id;

  // Shared text channel — all 10 players + bot + staff
  const textChannel = await guild.channels.create({
    name: 'queue-chat',
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: _queueChannelOverwrites(guild, allDiscordIds),
    reason: 'Queue match text channel',
  });
  match.textChannelId = textChannel.id;

  // Shared voice channel — all 10 players + bot + staff
  const voiceChannel = await guild.channels.create({
    name: 'Queue Voice',
    type: ChannelType.GuildVoice,
    parent: category.id,
    permissionOverwrites: _queueChannelOverwrites(guild, allDiscordIds),
    reason: 'Queue match voice channel',
  });
  match.voiceChannelId = voiceChannel.id;

  // Store match (in-memory Map + persist initial row so a restart
  // during channel creation can still clean up).
  activeMatches.set(category.id, match);
  saveMatch(match);

  // Reset 7/8/9-player ping flags. Without this, the rejoin-after-no-
  // show flow (which calls createMatch directly, bypassing the panel
  // button handler that previously did the reset) would leave the
  // pings flagged as already fired — so subsequent fills would never
  // re-ping at the thresholds. Keep this near match-create rather than
  // post-success: even if Discord-side setup fails below, the player
  // list has already been spliced out of the queue, so the next fill
  // is genuinely a new cycle.
  try {
    require('../panels/queuePanel').resetPingState();
  } catch (resetErr) {
    console.warn(`[Queue] resetPingState failed (non-fatal): ${resetErr.message}`);
  }

  // ── Ping players ─────────────────────────────────────────────
  const mentions = allDiscordIds.map(id => `<@${id}>`).join(' ');
  const timeoutMinutes = (QUEUE_CONFIG.VOICE_JOIN_TIMEOUT / 60_000).toFixed(1);

  const embed = new EmbedBuilder()
    .setTitle(`Queue Match #${match.id} — Join Voice`)
    .setColor(0x3498db)
    .setDescription([
      `${mentions}`,
      '',
      `**Your ranked match is ready!**`,
      `Join the voice channel within **${timeoutMinutes} minutes** or receive a **-${QUEUE_CONFIG.NO_SHOW_PENALTY} XP** penalty.`,
      '',
      `Mode: **Hardpoint** | Series: **Bo${QUEUE_CONFIG.SERIES_LENGTH}** | Teams: **${QUEUE_CONFIG.TEAM_SIZE}v${QUEUE_CONFIG.TEAM_SIZE}**`,
    ].join('\n'))
    .setTimestamp();

  await textChannel.send({ embeds: [embed] });

  // ── Voice join timer ─────────────────────────────────────────
  match.timerDeadline = Date.now() + QUEUE_CONFIG.VOICE_JOIN_TIMEOUT;
  match.timer = setTimeout(async () => {
    try {
      await handleNoShows(client, match);
    } catch (err) {
      console.error(`[QueueService] handleNoShows failed for match #${match.id}:`, err.message);
    }
  }, QUEUE_CONFIG.VOICE_JOIN_TIMEOUT);

  // Log to admin feed
  const { postTransaction } = require('../utils/transactionFeed');
  postTransaction({
    type: 'queue_match_created',
    memo: `Queue Match #${match.id} created | 5v5 HP Bo3\nPlayers: ${allDiscordIds.map(id => `<@${id}>`).join(', ')}`,
  });

  console.log(`[QueueService] Queue match #${match.id} created with ${allDiscordIds.length} players`);
  return match;
}

/**
 * Check who joined voice after the timeout. No-shows get penalized,
 * replacements pulled from the queue. If not enough replacements,
 * cancel the match and re-queue the players who showed up.
 * @param {import('discord.js').Client} client — Discord client.
 * @param {object} match — The QueueMatch object.
 * @returns {Promise<void>}
 */
async function handleNoShows(client, match) {
  if (match.phase !== 'WAITING_VOICE') return;

  const voiceChannel = client.channels.cache.get(match.voiceChannelId);
  const textChannel = client.channels.cache.get(match.textChannelId);
  if (!textChannel) return;

  // Determine who is in voice
  const inVoice = new Set();
  if (voiceChannel && voiceChannel.members) {
    for (const [memberId] of voiceChannel.members) {
      if (match.players.has(memberId)) inVoice.add(memberId);
    }
  }

  const allPlayerIds = [...match.players.keys()];
  const noShows = allPlayerIds.filter(id => !inVoice.has(id));
  const showed = allPlayerIds.filter(id => inVoice.has(id));

  if (noShows.length === 0) {
    // Everyone showed up — proceed to captain vote
    const { startCaptainVote } = require('./captainVote');
    await startCaptainVote(match, client);
    return;
  }

  // ── Penalize no-shows ────────────────────────────────────────
  // addXp + xp_history wrapped in one db.transaction so the player's
  // xp_points column and the leaderboard's xp_history view can't
  // diverge (rank roles read xp_points, leaderboard sums xp_history).
  const { postTransaction: ptxNoShow } = require('../utils/transactionFeed');
  const dbRef = require('../database/db');
  const insertNoShowXpHistory = dbRef.prepare(
    'INSERT INTO xp_history (user_id, match_id, match_type, xp_amount, season) VALUES (?, ?, ?, ?, ?)'
  );
  const currentSeason = getCurrentSeason();
  const penalizeNoShowTx = dbRef.transaction((userId) => {
    // addXp floors at 0; record the actual delta applied so the
    // audit trail matches reality for low-XP players.
    const actualDelta = userRepo.addXp(userId, -QUEUE_CONFIG.NO_SHOW_PENALTY);
    if (actualDelta !== 0) {
      // match_id is NULL here: xp_history.match_id has a FK to matches(id),
      // but queue matches live in queue_matches with a separate id sequence.
      // Passing match.id (a queue_match id) would trip FOREIGN KEY constraint
      // failed. The match_type='queue' column already marks the row as queue.
      insertNoShowXpHistory.run(userId, null, 'queue', actualDelta, currentSeason);
    }
  });
  for (const discordId of noShows) {
    try {
      const user = userRepo.findByDiscordId(discordId);
      if (user) {
        penalizeNoShowTx(user.id);

        ptxNoShow({
          type: 'queue_no_show',
          username: user.server_username,
          discordId,
          memo: `Queue Match #${match.id} no-show: <@${discordId}> — -${QUEUE_CONFIG.NO_SHOW_PENALTY} XP`,
        });
      }
    } catch (err) {
      console.error(`[QueueService] Failed to penalize no-show ${discordId}:`, err.message);
    }
    // Remove from match
    match.players.delete(discordId);
  }

  // ── Find replacements ────────────────────────────────────────
  const neededReplacements = noShows.length;
  const replacements = [];

  // For each no-show, find the closest-XP player in the waiting queue
  for (let i = 0; i < neededReplacements; i++) {
    // Use average XP of showed players as target
    const avgXp = showed.length > 0
      ? showed.reduce((sum, id) => {
          const p = match.players.get(id);
          return sum + (p ? p.xp : 0);
        }, 0) / showed.length
      : 500;
    const replacement = findClosestXpReplacement(avgXp);
    if (replacement) {
      replacements.push(replacement);
    }
  }

  const noShowMentions = noShows.map(id => `<@${id}>`).join(', ');

  if (replacements.length >= neededReplacements) {
    // Enough replacements — swap them in and continue
    for (const rep of replacements) {
      match.players.set(rep.discordId, _newPlayer(rep.discordId, rep.xp));
    }

    const repMentions = replacements.map(r => `<@${r.discordId}>`).join(', ');
    const embed = new EmbedBuilder()
      .setTitle('No-Show Replacements')
      .setColor(0xe67e22)
      .setDescription([
        `**No-shows** (${QUEUE_CONFIG.NO_SHOW_PENALTY} XP penalty): ${noShowMentions}`,
        '',
        `**Replacements found:** ${repMentions}`,
        'New players — join the voice channel now! Match continues.',
      ].join('\n'));

    // Update channel permissions for new players
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (guild) {
      for (const rep of replacements) {
        try {
          const tc = client.channels.cache.get(match.textChannelId);
          const vc = client.channels.cache.get(match.voiceChannelId);
          if (tc) {
            await tc.permissionOverwrites.create(rep.discordId, {
              ViewChannel: true,
              SendMessages: true,
            });
          }
          if (vc) {
            await vc.permissionOverwrites.create(rep.discordId, {
              ViewChannel: true,
              Connect: true,
              Speak: true,
            });
          }
        } catch (err) {
          console.error(`[QueueService] Failed to update perms for replacement ${rep.discordId}:`, err.message);
        }
      }
    }

    await textChannel.send({ embeds: [embed] });

    // Give replacements 60s to join voice, then proceed
    const { startCaptainVote } = require('./captainVote');
    match.timer = setTimeout(async () => {
      try {
        await startCaptainVote(match, client);
      } catch (err) {
        console.error(`[QueueService] startCaptainVote after replacement failed for match #${match.id}:`, err.message);
      }
    }, 60_000);
  } else {
    // Not enough replacements — flip the match to CANCELLED but keep the
    // channels open for a short rejoin window. Players are NOT auto-re-
    // queued: an unaware player dropped back in could get pulled into the
    // next match and eat another -300 XP no-show. They must click
    // Rejoin Queue in this window, or join from the queue panel.
    await cancelMatch(client, match, 'Not enough replacement players', { skipCleanupSchedule: true });

    // Showed-up players AND partial replacements (yanked from the waiting
    // queue but left stranded) both get the rejoin option — none of them
    // did anything wrong.
    const eligible = [...showed, ...replacements.map(r => r.discordId)];

    await _postCancelWithRejoinWindow(client, match, {
      title: 'Match Cancelled — Not Enough Players',
      headerLines: [
        `**No-shows** (-${QUEUE_CONFIG.NO_SHOW_PENALTY} XP): ${noShowMentions}`,
        '',
        `Not enough players in queue to replace them.`,
      ],
      eligibleDiscordIds: eligible,
    });
  }
}

/**
 * Resolve a queue match — award XP, update stats, nickname sync.
 * @param {import('discord.js').Client} client — Discord client.
 * @param {object} match — The QueueMatch object.
 * @param {number} winningTeam — 1 or 2.
 * @returns {Promise<void>}
 */
async function resolveMatch(client, match, winningTeam) {
  if (match.phase === 'RESOLVED' || match.phase === 'CANCELLED') return;
  match.phase = 'RESOLVED';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  markMatchResolved(match.id);

  const db = require('../database/db');
  const insertXpHistory = db.prepare(
    'INSERT INTO xp_history (user_id, match_id, match_type, xp_amount, season) VALUES (?, ?, ?, ?, ?)'
  );

  const losingTeam = winningTeam === 1 ? 2 : 1;
  const season = getCurrentSeason();

  // Per-user atomicity: wrap (addXp, addWin/Loss, insertXpHistory) in
  // one DB transaction so a mid-write failure (disk full, constraint
  // violation, etc.) can't leave a player with XP awarded but no
  // win/loss stat or no xp_history row. Without this, the leaderboard
  // (reads xp_history) and the player's xp_points column could drift
  // out of sync — the player sees their rank move but the season
  // standings don't reflect the match.
  const awardWinTx = db.transaction((userId) => {
    userRepo.addXp(userId, QUEUE_CONFIG.WIN_XP);
    userRepo.addWin(userId);
    // match_id NULL — see no-show penalty above for FK reasoning.
    insertXpHistory.run(userId, null, 'queue', QUEUE_CONFIG.WIN_XP, season);
  });
  const awardLossTx = db.transaction((userId, penalize) => {
    if (penalize) {
      // addXp floors at 0; use the returned actual delta for xp_history.
      const actualDelta = userRepo.addXp(userId, -QUEUE_CONFIG.LOSS_XP);
      if (actualDelta !== 0) {
        insertXpHistory.run(userId, null, 'queue', actualDelta, season);
      }
    }
    userRepo.addLoss(userId);
  });

  // Winners: +WIN_XP, addWin
  for (const [discordId, player] of match.players) {
    if (player.team !== winningTeam) continue;
    try {
      const user = userRepo.findByDiscordId(discordId);
      if (!user) continue;
      awardWinTx(user.id);
    } catch (err) {
      console.error(`[QueueService] Failed to award win XP to ${discordId}:`, err.message);
    }
  }

  // Losers: -LOSS_XP, addLoss (mid_series subs don't lose XP)
  for (const [discordId, player] of match.players) {
    if (player.team !== losingTeam) continue;
    try {
      const user = userRepo.findByDiscordId(discordId);
      if (!user) continue;
      awardLossTx(user.id, player.subType !== 'mid_series');
    } catch (err) {
      console.error(`[QueueService] Failed to apply loss for ${discordId}:`, err.message);
    }
  }

  // Update nicknames and sync ranks
  const allUserIds = [];
  for (const [discordId] of match.players) {
    const user = userRepo.findByDiscordId(discordId);
    if (user) allUserIds.push(user.id);
  }

  try {
    const { updateNicknames } = require('../utils/nicknameUpdater');
    await updateNicknames(client, allUserIds);
  } catch (err) {
    console.error(`[QueueService] Nickname update failed for match #${match.id}:`, err.message);
  }

  try {
    const { syncRanks } = require('../utils/rankRoleSync');
    syncRanks(client, allUserIds).catch(err => {
      console.error(`[QueueService] Rank sync failed for match #${match.id}:`, err.message);
    });
  } catch (err) {
    console.error(`[QueueService] Rank sync import failed:`, err.message);
  }

  // Schedule channel cleanup (5 min)
  setTimeout(() => {
    _cleanupMatchChannels(client, match).catch(err => {
      console.error(`[QueueService] Cleanup failed for match #${match.id}:`, err.message);
    });
  }, 5 * 60 * 1000);

  // Log to admin feed
  const { postTransaction: ptx } = require('../utils/transactionFeed');
  const winnerMentions = [...match.players.values()].filter(p => p.team === winningTeam).map(p => `<@${p.discordId}>`).join(', ');
  const loserMentions = [...match.players.values()].filter(p => p.team !== winningTeam && p.team).map(p => `<@${p.discordId}>`).join(', ');
  ptx({
    type: 'queue_match_resolved',
    memo: `Queue Match #${match.id} | Team ${winningTeam} wins\nWinners: ${winnerMentions} (+${QUEUE_CONFIG.WIN_XP} XP)\nLosers: ${loserMentions} (-${QUEUE_CONFIG.LOSS_XP} XP)`,
  });

  console.log(`[QueueService] Match #${match.id} resolved. Team ${winningTeam} wins.`);
}

/**
 * Cancel a queue match — mark cancelled, schedule channel cleanup.
 * @param {import('discord.js').Client} client — Discord client.
 * @param {object} match — The QueueMatch object.
 * @param {string} reason — Why the match was cancelled.
 * @param {{ skipCleanupSchedule?: boolean }} [options] — If skipCleanupSchedule
 *   is true, the caller is responsible for calling _cleanupMatchChannels later.
 *   Used by the staff-cancel path so it can run its own 15s rejoin window
 *   before tearing the channels down.
 * @returns {Promise<void>}
 */
async function cancelMatch(client, match, reason, options = {}) {
  if (match.phase === 'RESOLVED' || match.phase === 'CANCELLED') return;
  match.phase = 'CANCELLED';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  markMatchCancelled(match.id);

  // Log to admin feed
  const { postTransaction } = require('../utils/transactionFeed');
  postTransaction({
    type: 'queue_match_cancelled',
    memo: `Queue Match #${match.id} cancelled: ${reason}`,
  });

  console.log(`[QueueService] Match #${match.id} cancelled: ${reason}`);

  if (options.skipCleanupSchedule) return;

  // Schedule cleanup (1 min for cancelled matches)
  setTimeout(() => {
    _cleanupMatchChannels(client, match).catch(err => {
      console.error(`[QueueService] Cleanup failed for cancelled match #${match.id}:`, err.message);
    });
  }, 60_000);
}

/**
 * Post a "Match Cancelled" embed with a Rejoin Queue button in the match's
 * text channel, then schedule channel cleanup after the rejoin window
 * closes. Shared by both the auto-cancel (no-show) and staff-cancel
 * paths so their UX stays consistent.
 *
 * Caller is responsible for having already flipped the match into the
 * CANCELLED phase (via cancelMatch with skipCleanupSchedule: true).
 *
 * @param {import('discord.js').Client} client
 * @param {object} match
 * @param {object} opts
 * @param {string} [opts.title='Match Cancelled']
 * @param {number} [opts.color=0xe74c3c]
 * @param {string[]} opts.headerLines — lines that go at the top of the embed description (context-specific wording)
 * @param {string[]} opts.eligibleDiscordIds — players to ping + offer the rejoin button to
 * @param {number} [opts.windowMs=15_000] — how long the rejoin button stays live before cleanup
 * @returns {Promise<void>}
 */
async function _postCancelWithRejoinWindow(client, match, {
  title = 'Match Cancelled',
  color = 0xe74c3c,
  headerLines = [],
  eligibleDiscordIds,
  windowMs = 15_000,
}) {
  const playerMentions = eligibleDiscordIds.map(id => `<@${id}>`).join(', ') || '—';

  const rejoinRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_rejoin_${match.id}`)
      .setLabel('Rejoin Queue')
      .setStyle(ButtonStyle.Success),
  );

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setDescription([
      ...headerLines,
      '',
      `**Eligible to rejoin:** ${playerMentions}`,
      '',
      `Click **Rejoin Queue** within **${windowMs / 1000}s** to play again. If you don't, you are **not** auto-re-queued.`,
      `Channels will be deleted when the window closes.`,
    ].join('\n'))
    .setTimestamp();

  let cancelMsg = null;
  try {
    const tc = client.channels.cache.get(match.textChannelId);
    if (tc) {
      cancelMsg = await tc.send({
        content: playerMentions,
        embeds: [embed],
        components: [rejoinRow],
        allowedMentions: { users: eligibleDiscordIds },
      });
    }
  } catch (err) {
    console.error(`[QueueService] Failed to post cancel/rejoin embed for match #${match.id}:`, err.message);
  }

  // Window expiry → strip the button, tear down channels
  setTimeout(async () => {
    if (cancelMsg) {
      cancelMsg.edit({ components: [] }).catch(() => {});
    }
    _cleanupMatchChannels(client, match).catch(err => {
      console.error(`[QueueService] Cleanup failed for cancelled match #${match.id}:`, err.message);
    });
  }, windowMs);
}

module.exports = {
  createMatch,
  handleNoShows,
  resolveMatch,
  cancelMatch,
  _postCancelWithRejoinWindow,
};
