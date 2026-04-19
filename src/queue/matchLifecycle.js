// Match creation, no-show handling, resolution, and cancellation.
//
// Depends on state.js and helpers.js. Calls captainVote.js to start the
// voting phase after voice join. Called by playPhase.js and interactions.js
// when a match result is confirmed.

const { ChannelType, EmbedBuilder } = require('discord.js');
const QUEUE_CONFIG = require('../config/queueConfig');
const userRepo = require('../database/repositories/userRepo');
const { getCurrentSeason } = require('../panels/leaderboardPanel');
const {
  waitingQueue, activeMatches,
  _newQueueMatch, _newPlayer,
  nextMatchId,
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

  // Store match
  activeMatches.set(category.id, match);

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
  const { postTransaction: ptxNoShow } = require('../utils/transactionFeed');
  for (const discordId of noShows) {
    try {
      const user = userRepo.findByDiscordId(discordId);
      if (user) {
        userRepo.addXp(user.id, -QUEUE_CONFIG.NO_SHOW_PENALTY);

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
    // Not enough replacements — cancel match. Players are NOT auto-re-queued
    // because an unaware player dropped back into queue can get pulled
    // into the next match and eat another -300 XP no-show. Manual rejoin
    // via the queue panel only.
    const showedMentions = showed.map(id => `<@${id}>`).join(', ') || '—';
    const partialRepMentions = replacements.map(r => `<@${r.discordId}>`).join(', ');
    const stranded = [showedMentions, partialRepMentions].filter(s => s && s !== '—').join(', ') || '—';
    const rankedQueueChannelId = process.env.RANKED_QUEUE_CHANNEL_ID;
    const queueChannelMention = rankedQueueChannelId ? `<#${rankedQueueChannelId}>` : 'the ranked queue channel';

    const embed = new EmbedBuilder()
      .setTitle('Match Cancelled — Not Enough Players')
      .setColor(0xe74c3c)
      .setDescription([
        `**No-shows** (-${QUEUE_CONFIG.NO_SHOW_PENALTY} XP): ${noShowMentions}`,
        '',
        `Not enough players in queue to replace them.`,
        '',
        `**${stranded}** — you were **not** automatically re-queued. Head to ${queueChannelMention} and hit **Join Queue** if you want to play again.`,
        '',
        `This channel will be deleted in 1 minute.`,
      ].join('\n'));

    await textChannel.send({ embeds: [embed] });

    await cancelMatch(client, match, 'Not enough replacement players');
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

  const db = require('../database/db');
  const insertXpHistory = db.prepare(
    'INSERT INTO xp_history (user_id, match_id, match_type, xp_amount, season) VALUES (?, ?, ?, ?, ?)'
  );

  const losingTeam = winningTeam === 1 ? 2 : 1;
  const season = getCurrentSeason();

  // Winners: +WIN_XP, addWin
  for (const [discordId, player] of match.players) {
    if (player.team !== winningTeam) continue;
    try {
      const user = userRepo.findByDiscordId(discordId);
      if (!user) continue;

      userRepo.addXp(user.id, QUEUE_CONFIG.WIN_XP);
      userRepo.addWin(user.id);
      insertXpHistory.run(user.id, match.id, 'queue', QUEUE_CONFIG.WIN_XP, season);
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

      // Mid-series subs don't get penalized
      if (player.subType !== 'mid_series') {
        userRepo.addXp(user.id, -QUEUE_CONFIG.LOSS_XP);
        insertXpHistory.run(user.id, match.id, 'queue', -QUEUE_CONFIG.LOSS_XP, season);
      }

      userRepo.addLoss(user.id);
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

module.exports = {
  createMatch,
  handleNoShows,
  resolveMatch,
  cancelMatch,
};
