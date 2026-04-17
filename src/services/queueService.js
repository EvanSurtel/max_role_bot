// Queue service — in-memory state machine for 5v5 ranked queue matches.
//
// All state is transient (resets on bot restart). This is fine because
// queue matches are short-lived — a match that hasn't resolved before
// a restart was probably abandoned and the players can re-queue.
//
// Phase flow:
//   WAITING_VOICE → CAPTAIN_VOTE → CAPTAIN_PICK → ROLE_SELECT → PLAYING → VOTING → RESOLVED
//                                                                                 → CANCELLED

const { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const QUEUE_CONFIG = require('../config/queueConfig');
const userRepo = require('../database/repositories/userRepo');
const neatqueueService = require('./neatqueueService');
const { getCurrentSeason } = require('../panels/leaderboardPanel');
const { pickMaps, formatMapPicks } = require('../utils/mapPicker');

// Store the client reference so timer callbacks can access channels.
// Set by startCaptainVote on first call.
let _client = null;

// ─── In-memory state ───────────────────────────────────────────────
const waitingQueue = [];           // Array<{ discordId, joinedAt, xp }>
const activeMatches = new Map();   // matchCategoryId → QueueMatch
let matchIdCounter = 0;

// ─── QueueMatch factory ────────────────────────────────────────────
function _newQueueMatch(id) {
  return {
    id,
    categoryId: null,
    textChannelId: null,
    voiceChannelId: null,
    players: new Map(),            // discordId → player object
    phase: 'WAITING_VOICE',
    captainVotes: new Map(),       // voter → votedFor
    captains: { team1: null, team2: null },
    pickOrder: [],
    currentPicker: null,
    team1: [],
    team2: [],
    team1Roles: new Map(),         // role → count
    team2Roles: new Map(),
    team1Operators: new Map(),     // operator → discordId
    team2Operators: new Map(),
    maps: [],
    timer: null,
    timerDeadline: null,
    gamesPlayed: 0,
    captain1Vote: null,
    captain2Vote: null,
    createdAt: new Date(),
  };
}

function _newPlayer(discordId, xp) {
  return {
    discordId,
    xp,
    team: null,
    isCaptain: false,
    weaponRoles: [],
    operator: null,
    subType: null,                // 'fresh' | 'mid_series' | null
  };
}

// ═══════════════════════════════════════════════════════════════════
// Queue management
// ═══════════════════════════════════════════════════════════════════

/**
 * Add a player to the waiting queue. Returns the new queue size.
 */
function joinQueue(discordId, xp) {
  if (isInQueue(discordId)) return waitingQueue.length;
  waitingQueue.push({ discordId, joinedAt: Date.now(), xp });
  return waitingQueue.length;
}

/**
 * Remove a player from the waiting queue. Returns true if they were removed.
 */
function leaveQueue(discordId) {
  const idx = waitingQueue.findIndex(p => p.discordId === discordId);
  if (idx === -1) return false;
  waitingQueue.splice(idx, 1);
  return true;
}

function getQueueSize() {
  return waitingQueue.length;
}

function getQueuePlayers() {
  return [...waitingQueue];
}

function isInQueue(discordId) {
  return waitingQueue.some(p => p.discordId === discordId);
}

/**
 * Check if a player is in an active (non-resolved/cancelled) match.
 * Returns the match id or null.
 */
function isInActiveMatch(discordId) {
  for (const [, match] of activeMatches) {
    if (match.phase === 'RESOLVED' || match.phase === 'CANCELLED') continue;
    if (match.players.has(discordId)) return match.id;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Match lifecycle
// ═══════════════════════════════════════════════════════════════════

/**
 * Pop 10 players from the queue, create Discord channels, and start
 * the voice-join countdown. Called automatically when queue size
 * hits TOTAL_PLAYERS.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<object>} The QueueMatch object.
 */
async function createMatch(client, guild) {
  matchIdCounter += 1;
  const match = _newQueueMatch(matchIdCounter);

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

  console.log(`[QueueService] Queue match #${match.id} created with ${allDiscordIds.length} players`);
  return match;
}

/**
 * Check who joined voice after the timeout. No-shows get penalized,
 * replacements pulled from the queue. If not enough replacements,
 * cancel the match and re-queue the players who showed up.
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
    await startCaptainVote(match, client);
    return;
  }

  // ── Penalize no-shows ────────────────────────────────────────
  for (const discordId of noShows) {
    try {
      const user = userRepo.findByDiscordId(discordId);
      if (user) {
        userRepo.addXp(user.id, -QUEUE_CONFIG.NO_SHOW_PENALTY);

        // Sync penalty to NeatQueue
        if (neatqueueService.isConfigured()) {
          neatqueueService.addPoints(discordId, -QUEUE_CONFIG.NO_SHOW_PENALTY).catch(err => {
            console.error(`[QueueService] NeatQueue penalty sync failed for ${discordId}:`, err.message);
          });
        }
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
    match.timer = setTimeout(async () => {
      try {
        await startCaptainVote(match, client);
      } catch (err) {
        console.error(`[QueueService] startCaptainVote after replacement failed for match #${match.id}:`, err.message);
      }
    }, 60_000);
  } else {
    // Not enough replacements — cancel match, re-queue showed players
    const embed = new EmbedBuilder()
      .setTitle('Match Cancelled — Not Enough Players')
      .setColor(0xe74c3c)
      .setDescription([
        `**No-shows** (${QUEUE_CONFIG.NO_SHOW_PENALTY} XP penalty): ${noShowMentions}`,
        '',
        `Not enough players in queue to replace them.`,
        `Players who showed up have been re-added to the queue.`,
        '',
        `This channel will be deleted in 1 minute.`,
      ].join('\n'));

    await textChannel.send({ embeds: [embed] });

    // Re-queue players who showed up
    for (const discordId of showed) {
      const player = match.players.get(discordId);
      if (player && !isInQueue(discordId)) {
        waitingQueue.push({ discordId, joinedAt: Date.now(), xp: player.xp });
      }
    }

    // Re-queue any replacements that were found (partial)
    for (const rep of replacements) {
      if (!isInQueue(rep.discordId)) {
        waitingQueue.push({ discordId: rep.discordId, joinedAt: Date.now(), xp: rep.xp });
      }
    }

    await cancelMatch(client, match, 'Not enough replacement players');
  }
}

/**
 * Find the player in waitingQueue with the closest XP to the target.
 * Removes them from the queue and returns their entry, or null.
 */
function findClosestXpReplacement(targetXp) {
  if (waitingQueue.length === 0) return null;

  let bestIdx = 0;
  let bestDiff = Math.abs(waitingQueue[0].xp - targetXp);

  for (let i = 1; i < waitingQueue.length; i++) {
    const diff = Math.abs(waitingQueue[i].xp - targetXp);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }

  return waitingQueue.splice(bestIdx, 1)[0];
}

// ═══════════════════════════════════════════════════════════════════
// Captain vote phase (stub — Stage 2)
// ═══════════════════════════════════════════════════════════════════

/**
 * Begin captain voting. Each player votes for 2 players they want as captain.
 * Top 2 vote-getters become captains. Ties broken by XP, then random.
 */
async function startCaptainVote(match, client) {
  match.phase = 'CAPTAIN_VOTE';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  if (client) _client = client;
  console.log(`[QueueService] Match #${match.id} entering CAPTAIN_VOTE phase`);

  const textChannel = (_client || {}).channels?.cache?.get(match.textChannelId);
  if (!textChannel) {
    console.error(`[QueueService] Text channel not found for match #${match.id}`);
    return;
  }

  // Build player options for the select menu
  const playerOptions = [...match.players.values()].map(p => {
    const user = userRepo.findByDiscordId(p.discordId);
    const name = user?.display_name || p.discordId;
    const xpStr = (p.xp || 0).toLocaleString();
    return {
      label: `${name} (${xpStr} XP)`,
      value: p.discordId,
    };
  });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`queue_captain_vote_${match.id}`)
    .setPlaceholder('Vote for 2 captains...')
    .setMinValues(2)
    .setMaxValues(2)
    .addOptions(playerOptions);

  const row = new ActionRowBuilder().addComponents(selectMenu);

  const embed = new EmbedBuilder()
    .setTitle('Captain Vote')
    .setColor(0xf1c40f)
    .setDescription([
      'Vote for **2 players** you want as captain.',
      'You **cannot** vote for yourself.',
      '',
      `Time: **${QUEUE_CONFIG.CAPTAIN_VOTE_TIMEOUT / 1000}s** — if you don't vote, the highest XP players will be chosen.`,
    ].join('\n'));

  match._captainVoteMsg = await textChannel.send({ embeds: [embed], components: [row] });

  // Start timer — when it expires, finalize with whatever votes we have
  match.timer = setTimeout(async () => {
    try {
      await finalizeCaptainVote(match);
    } catch (err) {
      console.error(`[QueueService] finalizeCaptainVote timer failed for match #${match.id}:`, err.message);
    }
  }, QUEUE_CONFIG.CAPTAIN_VOTE_TIMEOUT);
}

/**
 * Record a captain vote (2 picks). Returns { success, allVoted, error }.
 */
function recordCaptainVote(matchId, voterId, votedForIds) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'CAPTAIN_VOTE') return { success: false, error: 'Not in captain vote phase' };
  if (!match.players.has(voterId)) return { success: false, error: 'Not a player in this match' };

  // votedForIds is an array of 2 discord IDs
  if (!Array.isArray(votedForIds) || votedForIds.length !== 2) {
    return { success: false, error: 'Must vote for exactly 2 players' };
  }
  if (votedForIds.includes(voterId)) {
    return { success: false, error: 'You cannot vote for yourself' };
  }
  for (const id of votedForIds) {
    if (!match.players.has(id)) return { success: false, error: 'Voted player not in this match' };
  }

  match.captainVotes.set(voterId, votedForIds);

  // Check if all players have voted
  const allVoted = match.captainVotes.size >= match.players.size;
  return { success: true, allVoted };
}

/**
 * Tally votes and assign the top 2 captains. Tiebreak: XP desc, then random.
 */
async function finalizeCaptainVote(match) {
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  console.log(`[QueueService] Match #${match.id} finalizing captain vote`);

  const textChannel = _client?.channels?.cache?.get(match.textChannelId);

  // Disable the vote select menu
  if (match._captainVoteMsg) {
    try {
      const disabledRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`queue_captain_vote_${match.id}_done`)
          .setPlaceholder('Voting closed')
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions({ label: 'Closed', value: 'closed' })
          .setDisabled(true),
      );
      await match._captainVoteMsg.edit({ components: [disabledRow] });
    } catch { /* message may be gone */ }
    delete match._captainVoteMsg;
  }

  // Tally votes — each vote is an array of 2 discord IDs
  const tally = new Map(); // discordId → vote count
  for (const [, p] of match.players) {
    tally.set(p.discordId, 0);
  }
  for (const [, votedForIds] of match.captainVotes) {
    const ids = Array.isArray(votedForIds) ? votedForIds : [votedForIds];
    for (const id of ids) {
      tally.set(id, (tally.get(id) || 0) + 1);
    }
  }

  // Sort by votes DESC, then XP DESC, then random
  const sorted = [...tally.entries()]
    .map(([discordId, votes]) => {
      const player = match.players.get(discordId);
      return { discordId, votes, xp: player?.xp || 0 };
    })
    .sort((a, b) => {
      if (b.votes !== a.votes) return b.votes - a.votes;
      if (b.xp !== a.xp) return b.xp - a.xp;
      return Math.random() - 0.5;
    });

  const captain1Id = sorted[0].discordId;
  const captain2Id = sorted[1].discordId;

  // Assign captains
  match.captains = { team1: captain1Id, team2: captain2Id };
  const cap1Player = match.players.get(captain1Id);
  const cap2Player = match.players.get(captain2Id);
  cap1Player.team = 1;
  cap1Player.isCaptain = true;
  cap2Player.team = 2;
  cap2Player.isCaptain = true;
  match.team1 = [captain1Id];
  match.team2 = [captain2Id];

  // Post result
  if (textChannel) {
    const embed = new EmbedBuilder()
      .setTitle('Captains Selected')
      .setColor(0x2ecc71)
      .setDescription([
        `**Captain 1 (Team 1):** <@${captain1Id}> (${sorted[0].votes} votes, ${sorted[0].xp.toLocaleString()} XP)`,
        `**Captain 2 (Team 2):** <@${captain2Id}> (${sorted[1].votes} votes, ${sorted[1].xp.toLocaleString()} XP)`,
      ].join('\n'));
    await textChannel.send({ embeds: [embed] });
  }

  // Proceed to captain pick
  await startCaptainPick(match);
}

// ═══════════════════════════════════════════════════════════════════
// Captain pick phase (stub — Stage 2)
// ═══════════════════════════════════════════════════════════════════

/**
 * Begin pick phase. Random first pick; captains alternate (snake draft) picking players.
 * Snake draft order for 8 picks: C1, C2, C2, C1, C1, C2, C2, C1
 */
async function startCaptainPick(match) {
  match.phase = 'CAPTAIN_PICK';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  console.log(`[QueueService] Match #${match.id} entering CAPTAIN_PICK phase`);

  // Randomly decide who picks first
  const firstPicker = Math.random() < 0.5 ? match.captains.team1 : match.captains.team2;
  const secondPicker = firstPicker === match.captains.team1 ? match.captains.team2 : match.captains.team1;

  // Snake draft: 1-2-2-1-1-2-2-1 for 8 picks
  match.pickOrder = [
    firstPicker,
    secondPicker, secondPicker,
    firstPicker, firstPicker,
    secondPicker, secondPicker,
    firstPicker,
  ];
  match._pickIndex = 0;
  match.currentPicker = match.pickOrder[0];

  await _postPickMessage(match);
}

/**
 * Post or update the captain pick message with buttons for remaining players.
 */
async function _postPickMessage(match) {
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (!textChannel) return;

  const unpicked = [...match.players.values()].filter(p => !p.team);
  const pickerTeam = match.players.get(match.currentPicker)?.team;
  const teamLabel = pickerTeam === 1 ? 'Team 1' : 'Team 2';

  const embed = new EmbedBuilder()
    .setTitle('Captain Pick Phase')
    .setColor(0x3498db)
    .setDescription([
      `<@${match.currentPicker}> (**${teamLabel}**) — pick a player!`,
      '',
      `**Remaining players (${unpicked.length}):**`,
      ...unpicked.map(p => `- <@${p.discordId}> — ${(p.xp || 0).toLocaleString()} XP`),
      '',
      `Pick ${match._pickIndex + 1} of ${match.pickOrder.length} | Time: **${QUEUE_CONFIG.CAPTAIN_PICK_TIMEOUT / 1000}s**`,
    ].join('\n'));

  // Build button rows (up to 5 per row)
  const rows = [];
  let currentRow = new ActionRowBuilder();
  let btnCount = 0;

  for (const p of unpicked) {
    const user = userRepo.findByDiscordId(p.discordId);
    const name = user?.display_name || p.discordId.slice(0, 15);
    const xpStr = (p.xp || 0).toLocaleString();

    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_pick_${match.id}_${p.discordId}`)
        .setLabel(`${name} (${xpStr} XP)`)
        .setStyle(ButtonStyle.Primary),
    );
    btnCount++;

    if (btnCount % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }
  if (currentRow.components.length > 0) rows.push(currentRow);

  // Edit existing message or send new one
  if (match._pickMsg) {
    try {
      await match._pickMsg.edit({ embeds: [embed], components: rows });
    } catch {
      match._pickMsg = await textChannel.send({ embeds: [embed], components: rows });
    }
  } else {
    match._pickMsg = await textChannel.send({ embeds: [embed], components: rows });
  }

  // Start pick timer
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  match.timer = setTimeout(async () => {
    try {
      await _handlePickTimeout(match);
    } catch (err) {
      console.error(`[QueueService] Pick timeout failed for match #${match.id}:`, err.message);
    }
  }, QUEUE_CONFIG.CAPTAIN_PICK_TIMEOUT);
}

/**
 * Handle pick timeout — auto-pick highest XP remaining player.
 */
async function _handlePickTimeout(match) {
  if (match.phase !== 'CAPTAIN_PICK' || !match.currentPicker) return;

  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  autoPickForCaptain(match);

  const lastPicked = [...match.players.values()]
    .filter(p => p.team && !p.isCaptain)
    .sort((a, b) => b.xp - a.xp)[0];

  if (textChannel && lastPicked) {
    await textChannel.send({
      content: `Auto-picked <@${lastPicked.discordId}> (highest XP available) for <@${match.currentPicker}>`,
    });
  }

  await _advancePick(match);
}

/**
 * Record a captain pick. Returns { success, error }.
 */
function recordCaptainPick(matchId, captainId, pickedPlayerId) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'CAPTAIN_PICK') return { success: false, error: 'Not in captain pick phase' };
  if (match.currentPicker !== captainId) return { success: false, error: 'Not your turn to pick' };
  if (!match.players.has(pickedPlayerId)) return { success: false, error: 'Player not in this match' };

  const player = match.players.get(pickedPlayerId);
  if (player.team) return { success: false, error: 'Player already on a team' };

  // Assign to picker's team
  const pickerPlayer = match.players.get(captainId);
  player.team = pickerPlayer.team;
  if (player.team === 1) match.team1.push(pickedPlayerId);
  else match.team2.push(pickedPlayerId);

  return { success: true };
}

/**
 * Advance to the next pick in the snake draft, or move to role select if done.
 */
async function _advancePick(match) {
  match._pickIndex = (match._pickIndex || 0) + 1;

  // Check if all picks are done
  const unpicked = [...match.players.values()].filter(p => !p.team);
  if (unpicked.length === 0 || match._pickIndex >= match.pickOrder.length) {
    // All players picked — disable the pick message and move on
    if (match._pickMsg) {
      try {
        await match._pickMsg.edit({ components: [] });
      } catch { /* */ }
      delete match._pickMsg;
    }
    if (match.timer) { clearTimeout(match.timer); match.timer = null; }
    await startRoleSelect(match);
    return;
  }

  // Advance to next captain in the pick order
  match.currentPicker = match.pickOrder[match._pickIndex];
  await _postPickMessage(match);
}

/**
 * Auto-pick highest XP remaining player. Called when captain timer expires.
 */
function autoPickForCaptain(match) {
  if (!match.currentPicker) return;
  const pickerTeam = match.players.get(match.currentPicker)?.team;
  if (!pickerTeam) return;

  // Find unpicked players (no team assignment, not a captain)
  const unpicked = [...match.players.values()]
    .filter(p => !p.team)
    .sort((a, b) => b.xp - a.xp);

  if (unpicked.length === 0) return;

  const picked = unpicked[0];
  picked.team = pickerTeam;
  if (pickerTeam === 1) match.team1.push(picked.discordId);
  else match.team2.push(picked.discordId);

  console.log(`[QueueService] Auto-picked ${picked.discordId} for team ${pickerTeam} in match #${match.id}`);
}

// ═══════════════════════════════════════════════════════════════════
// Role select phase (stub — Stage 2)
// ═══════════════════════════════════════════════════════════════════

/**
 * Begin role selection. Each team gets a message with weapon role + operator buttons.
 * Players pick up to 2 weapon roles and 1 operator.
 */
async function startRoleSelect(match) {
  match.phase = 'ROLE_SELECT';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  console.log(`[QueueService] Match #${match.id} entering ROLE_SELECT phase`);

  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (!textChannel) return;

  // Initialize role counters
  match.team1Roles = new Map();
  match.team2Roles = new Map();
  match.team1Operators = new Map();
  match.team2Operators = new Map();

  // Post a message for each team
  for (const teamNum of [1, 2]) {
    const msg = await _postRoleSelectMessage(match, teamNum, textChannel);
    if (teamNum === 1) match._roleMsg1 = msg;
    else match._roleMsg2 = msg;
  }

  // Start timer
  match.timer = setTimeout(async () => {
    try {
      await _handleRoleTimeout(match);
    } catch (err) {
      console.error(`[QueueService] Role select timeout failed for match #${match.id}:`, err.message);
    }
  }, QUEUE_CONFIG.ROLE_SELECT_TIMEOUT);
}

/**
 * Build and post (or edit) the role selection message for one team.
 */
async function _postRoleSelectMessage(match, teamNum, textChannel) {
  const teamPlayers = [...match.players.values()].filter(p => p.team === teamNum);
  const teamRoles = teamNum === 1 ? match.team1Roles : match.team2Roles;
  const teamOps = teamNum === 1 ? match.team1Operators : match.team2Operators;
  const captainId = teamNum === 1 ? match.captains.team1 : match.captains.team2;

  // Player status lines
  const playerLines = teamPlayers.map(p => {
    const roles = p.weaponRoles.length > 0 ? p.weaponRoles.join('/') : '_none_';
    const op = p.operator || '_none_';
    return `<@${p.discordId}> — Roles: **${roles}** | Operator: **${op}**`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`Team ${teamNum} — Role Selection`)
    .setColor(teamNum === 1 ? 0x3498db : 0xe74c3c)
    .setDescription([
      `Captain: <@${captainId}>`,
      '',
      playerLines,
      '',
      `Pick **up to 2 weapon roles** and **1 operator**. Time: **${QUEUE_CONFIG.ROLE_SELECT_TIMEOUT / 1000}s**`,
    ].join('\n'));

  // Row 1: AR, SMG, LMG
  const weaponRow1 = new ActionRowBuilder();
  for (const roleKey of ['AR', 'SMG', 'LMG']) {
    const cfg = QUEUE_CONFIG.WEAPON_ROLES[roleKey];
    const count = teamRoles.get(roleKey) || 0;
    const isFull = count >= cfg.max;
    weaponRow1.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_role_${match.id}_${teamNum}_${roleKey}`)
        .setLabel(`${cfg.emoji} ${cfg.label} (${count}/${cfg.max})`)
        .setStyle(isFull ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(isFull),
    );
  }

  // Row 2: Shotgun, Marksman, Sniper
  const weaponRow2 = new ActionRowBuilder();
  for (const roleKey of ['SHOTGUN', 'MARKSMAN', 'SNIPER']) {
    const cfg = QUEUE_CONFIG.WEAPON_ROLES[roleKey];
    const count = teamRoles.get(roleKey) || 0;
    const isFull = count >= cfg.max;
    weaponRow2.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_role_${match.id}_${teamNum}_${roleKey}`)
        .setLabel(`${cfg.emoji} ${cfg.label} (${count}/${cfg.max})`)
        .setStyle(isFull ? ButtonStyle.Secondary : ButtonStyle.Primary)
        .setDisabled(isFull),
    );
  }

  // Row 3: First 5 operators
  const ops1 = QUEUE_CONFIG.OPERATORS.slice(0, 5);
  const opRow1 = new ActionRowBuilder();
  for (const op of ops1) {
    const taken = teamOps.has(op);
    const takenBy = taken ? teamOps.get(op) : null;
    opRow1.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_op_${match.id}_${teamNum}_${op.replace(/\s+/g, '_')}`)
        .setLabel(taken ? `${op} (taken)` : op)
        .setStyle(taken ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(taken),
    );
  }

  // Row 4: Last 5 operators
  const ops2 = QUEUE_CONFIG.OPERATORS.slice(5, 10);
  const opRow2 = new ActionRowBuilder();
  for (const op of ops2) {
    const taken = teamOps.has(op);
    opRow2.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_op_${match.id}_${teamNum}_${op.replace(/\s+/g, '_')}`)
        .setLabel(taken ? `${op} (taken)` : op)
        .setStyle(taken ? ButtonStyle.Secondary : ButtonStyle.Success)
        .setDisabled(taken),
    );
  }

  const payload = { embeds: [embed], components: [weaponRow1, weaponRow2, opRow1, opRow2] };

  // Edit existing or send new
  const existingMsg = teamNum === 1 ? match._roleMsg1 : match._roleMsg2;
  if (existingMsg) {
    try {
      await existingMsg.edit(payload);
      return existingMsg;
    } catch { /* send new */ }
  }
  return await textChannel.send(payload);
}

/**
 * Handle role selection timeout — auto-assign remaining roles and operators.
 */
async function _handleRoleTimeout(match) {
  if (match.phase !== 'ROLE_SELECT') return;
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }

  const textChannel = _client?.channels?.cache?.get(match.textChannelId);

  // Auto-assign weapon roles for players who haven't chosen
  autoAssignRoles(match);

  // Auto-assign operators for players who haven't chosen
  _autoAssignOperators(match);

  // Post summary
  if (textChannel) {
    await textChannel.send({
      content: 'Role selection time expired. Remaining roles and operators have been auto-assigned.',
    });
  }

  // Disable role select messages
  for (const msg of [match._roleMsg1, match._roleMsg2]) {
    if (msg) try { await msg.edit({ components: [] }); } catch { /* */ }
  }
  delete match._roleMsg1;
  delete match._roleMsg2;

  await startPlayPhase(match);
}

/**
 * Auto-assign operators to players who didn't pick one.
 */
function _autoAssignOperators(match) {
  for (const teamNum of [1, 2]) {
    const teamOps = teamNum === 1 ? match.team1Operators : match.team2Operators;
    const teamPlayers = [...match.players.values()].filter(p => p.team === teamNum);
    const unassigned = teamPlayers.filter(p => !p.operator);

    for (const player of unassigned) {
      const available = QUEUE_CONFIG.OPERATORS.filter(op => !teamOps.has(op));
      if (available.length === 0) break;
      const pick = available[Math.floor(Math.random() * available.length)];
      player.operator = pick;
      teamOps.set(pick, player.discordId);
      console.log(`[QueueService] Auto-assigned operator ${pick} to ${player.discordId} in match #${match.id}`);
    }
  }
}

/**
 * Record a weapon role choice (up to 2 per player). Returns { success, error }.
 */
function recordRoleChoice(matchId, discordId, role) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'ROLE_SELECT') return { success: false, error: 'Not in role select phase' };

  const player = match.players.get(discordId);
  if (!player) return { success: false, error: 'Not a player in this match' };

  const roleConfig = QUEUE_CONFIG.WEAPON_ROLES[role];
  if (!roleConfig) return { success: false, error: 'Invalid weapon role' };

  // Check player hasn't already picked 2 weapon roles
  if (player.weaponRoles.length >= 2) {
    return { success: false, error: 'You already picked 2 weapon roles' };
  }

  // Check if player already picked this exact role
  if (player.weaponRoles.includes(role)) {
    return { success: false, error: `You already picked ${roleConfig.label}` };
  }

  const teamRoles = player.team === 1 ? match.team1Roles : match.team2Roles;
  const currentCount = teamRoles.get(role) || 0;
  if (currentCount >= roleConfig.max) return { success: false, error: `${roleConfig.label} is full (max ${roleConfig.max})` };

  player.weaponRoles.push(role);
  teamRoles.set(role, currentCount + 1);

  return { success: true };
}

/**
 * Record an operator choice. Returns { success, error }.
 */
function recordOperatorChoice(matchId, discordId, operator) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'ROLE_SELECT') return { success: false, error: 'Not in role select phase' };

  const player = match.players.get(discordId);
  if (!player) return { success: false, error: 'Not a player in this match' };

  if (!QUEUE_CONFIG.OPERATORS.includes(operator)) {
    return { success: false, error: 'Invalid operator' };
  }

  const teamOps = player.team === 1 ? match.team1Operators : match.team2Operators;
  if (teamOps.has(operator) && teamOps.get(operator) !== discordId) {
    return { success: false, error: `${operator} is already taken by a teammate` };
  }

  // Remove previous operator if any
  if (player.operator) {
    const prevOps = player.team === 1 ? match.team1Operators : match.team2Operators;
    if (prevOps.get(player.operator) === discordId) {
      prevOps.delete(player.operator);
    }
  }

  player.operator = operator;
  teamOps.set(operator, discordId);

  return { success: true };
}

/**
 * Auto-assign remaining roles after timer expires. Uses AUTO_ROLE_PRIORITY
 * to fill players who have fewer than 2 weapon roles.
 */
function autoAssignRoles(match) {
  for (const teamNum of [1, 2]) {
    const teamRoles = teamNum === 1 ? match.team1Roles : match.team2Roles;
    const teamPlayers = [...match.players.values()].filter(p => p.team === teamNum);
    const needsRoles = teamPlayers.filter(p => p.weaponRoles.length < 2);

    for (const player of needsRoles) {
      while (player.weaponRoles.length < 2) {
        let assigned = false;
        for (const role of QUEUE_CONFIG.AUTO_ROLE_PRIORITY) {
          if (player.weaponRoles.includes(role)) continue;
          const config = QUEUE_CONFIG.WEAPON_ROLES[role];
          const current = teamRoles.get(role) || 0;
          if (current < config.max) {
            player.weaponRoles.push(role);
            teamRoles.set(role, current + 1);
            console.log(`[QueueService] Auto-assigned ${player.discordId} to ${role} in match #${match.id}`);
            assigned = true;
            break;
          }
        }
        // If no role could be assigned (all full), break out
        if (!assigned) break;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Play + voting phases (stub — Stage 2)
// ═══════════════════════════════════════════════════════════════════

/**
 * Display match info (teams, roles, operators, maps) and start the play timer.
 * Captains can report results. Staff can sub/DQ.
 */
async function startPlayPhase(match) {
  match.phase = 'PLAYING';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  console.log(`[QueueService] Match #${match.id} entering PLAYING phase`);

  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (!textChannel) return;

  // Pick maps — always HP Bo3
  match.maps = pickMaps(QUEUE_CONFIG.GAME_MODE, QUEUE_CONFIG.SERIES_LENGTH);

  // Build team roster lines
  function teamRoster(teamNum) {
    const teamArr = teamNum === 1 ? match.team1 : match.team2;
    return teamArr.map(id => {
      const p = match.players.get(id);
      const roles = p.weaponRoles.length > 0 ? p.weaponRoles.join('/') : 'N/A';
      const op = p.operator || 'N/A';
      const capTag = p.isCaptain ? ' (C)' : '';
      return `<@${id}>${capTag} — ${roles} — ${op}`;
    }).join('\n');
  }

  const mapList = match.maps.map(m => `${m.game}. ${m.map}`).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`5v5 Ranked Queue -- Match #${match.id}`)
    .setColor(0x2ecc71)
    .setDescription([
      `**Team 1** (Captain: <@${match.captains.team1}>)`,
      teamRoster(1),
      '',
      `**Team 2** (Captain: <@${match.captains.team2}>)`,
      teamRoster(2),
      '',
      `**Maps (Bo${QUEUE_CONFIG.SERIES_LENGTH} Hardpoint)**`,
      mapList,
      '',
      '**Good luck! Report results below after 10 minutes.**',
    ].join('\n'))
    .setTimestamp();

  // Report buttons (captains only)
  const reportRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_report_${match.id}_1`)
      .setLabel('Team 1 Won')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`queue_report_${match.id}_2`)
      .setLabel('Team 2 Won')
      .setStyle(ButtonStyle.Danger),
  );

  // Admin sub/DQ buttons
  const adminRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`queue_sub_fresh_${match.id}`)
      .setLabel('Sub Player (Fresh)')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`queue_sub_mid_${match.id}`)
      .setLabel('Sub Player (Mid-Series)')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`queue_dq_${match.id}`)
      .setLabel('DQ Player (-300 XP)')
      .setStyle(ButtonStyle.Danger),
  );

  match._matchMsg = await textChannel.send({ embeds: [embed], components: [reportRow, adminRow] });

  // 10-minute play timer — just a reminder
  match.timer = setTimeout(async () => {
    try {
      const tc = _client?.channels?.cache?.get(match.textChannelId);
      if (tc && match.phase === 'PLAYING') {
        await tc.send({ content: "Time's up! Captains, report the result using the buttons above." });
      }
    } catch (err) {
      console.error(`[QueueService] Play reminder failed for match #${match.id}:`, err.message);
    }
  }, QUEUE_CONFIG.PLAY_TIMEOUT);
}

/**
 * Record a captain's vote for the winning team. Returns { success, allVoted, agreed, winningTeam }.
 * Accepts votes during PLAYING or VOTING phase (first vote transitions to VOTING).
 */
function recordVote(matchId, captainDiscordId, winningTeam) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'PLAYING' && match.phase !== 'VOTING') {
    return { success: false, error: 'Not in playing/voting phase' };
  }

  const isCap1 = captainDiscordId === match.captains.team1;
  const isCap2 = captainDiscordId === match.captains.team2;
  if (!isCap1 && !isCap2) {
    return { success: false, error: 'Only captains can report results' };
  }

  // Transition to VOTING on first vote
  if (match.phase === 'PLAYING') {
    match.phase = 'VOTING';
  }

  if (isCap1) match.captain1Vote = winningTeam;
  else match.captain2Vote = winningTeam;

  const allVoted = match.captain1Vote !== null && match.captain2Vote !== null;
  const agreed = allVoted && match.captain1Vote === match.captain2Vote;

  return {
    success: true,
    allVoted,
    agreed,
    winningTeam: agreed ? match.captain1Vote : null,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Match resolution
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve a queue match — award XP, update stats, schedule cleanup.
 *
 * @param {import('discord.js').Client} client
 * @param {object} match - The QueueMatch object.
 * @param {number} winningTeam - 1 or 2.
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

      // Sync to NeatQueue
      if (neatqueueService.isConfigured()) {
        neatqueueService.addPoints(discordId, QUEUE_CONFIG.WIN_XP).catch(err => {
          console.error(`[QueueService] NeatQueue points failed for winner ${discordId}:`, err.message);
        });
        neatqueueService.addWin(discordId).catch(err => {
          console.error(`[QueueService] NeatQueue win failed for ${discordId}:`, err.message);
        });
      }
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

        if (neatqueueService.isConfigured()) {
          neatqueueService.addPoints(discordId, -QUEUE_CONFIG.LOSS_XP).catch(err => {
            console.error(`[QueueService] NeatQueue loss points failed for ${discordId}:`, err.message);
          });
        }
      }

      userRepo.addLoss(user.id);
      if (neatqueueService.isConfigured()) {
        neatqueueService.addLoss(discordId).catch(err => {
          console.error(`[QueueService] NeatQueue loss failed for ${discordId}:`, err.message);
        });
      }
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

  console.log(`[QueueService] Match #${match.id} resolved. Team ${winningTeam} wins.`);
}

/**
 * Cancel a queue match — re-queue players who showed up, clean up channels.
 */
async function cancelMatch(client, match, reason) {
  if (match.phase === 'RESOLVED' || match.phase === 'CANCELLED') return;
  match.phase = 'CANCELLED';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }

  console.log(`[QueueService] Match #${match.id} cancelled: ${reason}`);

  // Schedule cleanup (1 min for cancelled matches)
  setTimeout(() => {
    _cleanupMatchChannels(client, match).catch(err => {
      console.error(`[QueueService] Cleanup failed for cancelled match #${match.id}:`, err.message);
    });
  }, 60_000);
}

// ═══════════════════════════════════════════════════════════════════
// Sub management
// ═══════════════════════════════════════════════════════════════════

/**
 * Sub a player out and bring in a replacement.
 *
 * @param {number} matchId
 * @param {string} discordId - Player being subbed out.
 * @param {string} replacementDiscordId - Replacement player.
 * @param {'fresh'|'mid_series'} subType - 'fresh' (no games played) or 'mid_series'.
 * @returns {{ success: boolean, error?: string }}
 */
function subPlayerOut(matchId, discordId, replacementDiscordId, subType) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };

  const player = match.players.get(discordId);
  if (!player) return { success: false, error: 'Player not in match' };

  // Create replacement player on the same team
  const repUser = userRepo.findByDiscordId(replacementDiscordId);
  const repXp = repUser ? repUser.xp_points : 500;
  const replacement = _newPlayer(replacementDiscordId, repXp);
  replacement.team = player.team;
  replacement.subType = subType;

  // Update team arrays
  if (player.team === 1) {
    const idx = match.team1.indexOf(discordId);
    if (idx !== -1) match.team1[idx] = replacementDiscordId;
  } else if (player.team === 2) {
    const idx = match.team2.indexOf(discordId);
    if (idx !== -1) match.team2[idx] = replacementDiscordId;
  }

  // Mark original player as subbed out
  player.subType = 'subbed_out';

  // Add replacement, remove original
  match.players.set(replacementDiscordId, replacement);
  match.players.delete(discordId);

  console.log(`[QueueService] Subbed ${discordId} out for ${replacementDiscordId} (${subType}) in match #${match.id}`);
  return { success: true };
}

// ═══════════════════════════════════════════════════════════════════
// Match lookup
// ═══════════════════════════════════════════════════════════════════

/**
 * Get a match by its auto-increment ID.
 */
function getMatch(matchId) {
  for (const [, match] of activeMatches) {
    if (match.id === matchId) return match;
  }
  return null;
}

/**
 * Get a match by one of its channel IDs (text or voice).
 */
function getMatchByChannel(channelId) {
  for (const [, match] of activeMatches) {
    if (match.textChannelId === channelId || match.voiceChannelId === channelId) {
      return match;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Internal helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Build permission overwrites for queue match channels. All 10 players
 * can view, send, connect, and speak. Staff can view too.
 */
function _queueChannelOverwrites(guild, playerDiscordIds) {
  const overwrites = [
    {
      id: guild.id, // @everyone
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: guild.client.user.id, // bot
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    },
  ];

  for (const playerId of playerDiscordIds) {
    overwrites.push({
      id: playerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    });
  }

  // Staff visibility
  const staffRoles = [
    process.env.WAGER_STAFF_ROLE_ID,
    process.env.XP_STAFF_ROLE_ID,
    process.env.ADMIN_ROLE_ID,
    process.env.OWNER_ROLE_ID,
    process.env.CEO_ROLE_ID,
    process.env.ADS_ROLE_ID,
  ].filter(Boolean);

  for (const roleId of staffRoles) {
    overwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    });
  }

  return overwrites;
}

/**
 * Delete all channels and category for a queue match.
 */
async function _cleanupMatchChannels(client, match) {
  const channelIds = [match.textChannelId, match.voiceChannelId].filter(Boolean);

  for (const channelId of channelIds) {
    try {
      const channel = client.channels.cache.get(channelId);
      if (channel && channel.deletable) {
        await channel.delete('Queue match cleanup');
      }
    } catch (err) {
      console.error(`[QueueService] Failed to delete channel ${channelId}:`, err.message);
    }
  }

  if (match.categoryId) {
    try {
      const category = client.channels.cache.get(match.categoryId);
      if (category && category.deletable) {
        await category.delete('Queue match cleanup');
      }
    } catch (err) {
      console.error(`[QueueService] Failed to delete category ${match.categoryId}:`, err.message);
    }
  }

  // Remove from activeMatches
  activeMatches.delete(match.categoryId);
  console.log(`[QueueService] Cleaned up channels for queue match #${match.id}`);
}

// ═══════════════════════════════════════════════════════════════════
// Interaction router — handles all queue_* customIds from interactionCreate
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if a guild member has staff/admin privileges.
 */
function _isStaffMember(member) {
  const roles = member?.roles?.cache;
  if (!roles) return false;
  const staffIds = [
    process.env.ADMIN_ROLE_ID,
    process.env.OWNER_ROLE_ID,
    process.env.CEO_ROLE_ID,
    process.env.ADS_ROLE_ID,
    process.env.WAGER_STAFF_ROLE_ID,
    process.env.XP_STAFF_ROLE_ID,
  ].filter(Boolean);
  return staffIds.some(id => roles.has(id));
}

/**
 * Master interaction handler — parse the customId prefix and route.
 * All queue_* button and select menu interactions land here.
 */
async function handleQueueInteraction(interaction) {
  const id = interaction.customId;
  if (!_client) _client = interaction.client;

  // ── Captain vote select menu ────────────────────────────────
  if (id.startsWith('queue_captain_vote_')) {
    return await _handleCaptainVoteSelect(interaction);
  }

  // ── Captain pick button ─────────────────────────────────────
  if (id.startsWith('queue_pick_')) {
    return await _handleCaptainPickButton(interaction);
  }

  // ── Role select button ──────────────────────────────────────
  if (id.startsWith('queue_role_')) {
    return await _handleRoleButton(interaction);
  }

  // ── Operator select button ──────────────────────────────────
  if (id.startsWith('queue_op_')) {
    return await _handleOperatorButton(interaction);
  }

  // ── Report result button ────────────────────────────────────
  if (id.startsWith('queue_report_')) {
    return await _handleReportButton(interaction);
  }

  // ── Admin resolve (dispute) button ──────────────────────────
  if (id.startsWith('queue_admin_resolve_')) {
    return await _handleAdminResolveButton(interaction);
  }

  // ── Sub / DQ buttons ────────────────────────────────────────
  if (id.startsWith('queue_sub_fresh_') || id.startsWith('queue_sub_mid_')) {
    return await _handleSubButton(interaction);
  }
  if (id.startsWith('queue_dq_')) {
    return await _handleDqButton(interaction);
  }

  // ── Sub player selection buttons ────────────────────────────
  if (id.startsWith('queue_subselect_')) {
    return await _handleSubSelectButton(interaction);
  }

  // ── DQ player selection buttons ─────────────────────────────
  if (id.startsWith('queue_dqselect_')) {
    return await _handleDqSelectButton(interaction);
  }

  console.warn(`[QueueService] Unhandled queue interaction: ${id}`);
  if (!interaction.replied && !interaction.deferred) {
    await interaction.deferUpdate().catch(() => {});
  }
}

// ── Captain Vote Select Menu handler ──────────────────────────
async function _handleCaptainVoteSelect(interaction) {
  // customId: queue_captain_vote_{matchId}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[3], 10);
  const voterId = interaction.user.id;
  const votedForIds = interaction.values; // array of 2 discord IDs

  const result = recordCaptainVote(matchId, voterId, votedForIds);
  if (!result.success) {
    return interaction.reply({ content: result.error, ephemeral: true, _autoDeleteMs: 10_000 });
  }

  await interaction.reply({
    content: `Your vote has been recorded! (${votedForIds.map(id => `<@${id}>`).join(', ')})`,
    ephemeral: true,
    _autoDeleteMs: 10_000,
  });

  // If all voted, finalize immediately
  if (result.allVoted) {
    const match = getMatch(matchId);
    if (match) {
      if (match.timer) { clearTimeout(match.timer); match.timer = null; }
      await finalizeCaptainVote(match);
    }
  }
}

// ── Captain Pick Button handler ───────────────────────────────
async function _handleCaptainPickButton(interaction) {
  // customId: queue_pick_{matchId}_{pickedDiscordId}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);
  const pickedPlayerId = parts[3];
  const captainId = interaction.user.id;

  const result = recordCaptainPick(matchId, captainId, pickedPlayerId);
  if (!result.success) {
    return interaction.reply({ content: result.error, ephemeral: true, _autoDeleteMs: 10_000 });
  }

  const match = getMatch(matchId);
  if (!match) return;

  // Cancel the pick timer
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }

  const pickerTeam = match.players.get(captainId)?.team;
  const teamLabel = pickerTeam === 1 ? 'Team 1' : 'Team 2';

  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (textChannel) {
    await textChannel.send({
      content: `<@${captainId}> picked <@${pickedPlayerId}> for **${teamLabel}**`,
    });
  }

  // Defer the button update (the message will be edited by _advancePick)
  await interaction.deferUpdate().catch(() => {});

  await _advancePick(match);
}

// ── Role Button handler ───────────────────────────────────────
async function _handleRoleButton(interaction) {
  // customId: queue_role_{matchId}_{team}_{roleKey}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);
  const teamNum = parseInt(parts[3], 10);
  const roleKey = parts[4];
  const discordId = interaction.user.id;

  const match = getMatch(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true, _autoDeleteMs: 10_000 });

  // Verify player is on this team
  const player = match.players.get(discordId);
  if (!player) return interaction.reply({ content: 'You are not in this match.', ephemeral: true, _autoDeleteMs: 10_000 });
  if (player.team !== teamNum) return interaction.reply({ content: 'This is not your team panel.', ephemeral: true, _autoDeleteMs: 10_000 });

  const result = recordRoleChoice(matchId, discordId, roleKey);
  if (!result.success) {
    return interaction.reply({ content: result.error, ephemeral: true, _autoDeleteMs: 10_000 });
  }

  // Refresh the team's role select message
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (textChannel) {
    const msg = await _postRoleSelectMessage(match, teamNum, textChannel);
    if (teamNum === 1) match._roleMsg1 = msg;
    else match._roleMsg2 = msg;
  }

  await interaction.deferUpdate().catch(() => {});

  // Check if all players on both teams have completed selections
  _checkAllRolesComplete(match);
}

// ── Operator Button handler ───────────────────────────────────
async function _handleOperatorButton(interaction) {
  // customId: queue_op_{matchId}_{team}_{operatorName_with_underscores}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);
  const teamNum = parseInt(parts[3], 10);
  // Operator name is everything after the 4th underscore, with underscores replaced back to spaces
  const operatorKey = parts.slice(4).join('_');
  const operator = operatorKey.replace(/_/g, ' ');
  const discordId = interaction.user.id;

  const match = getMatch(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true, _autoDeleteMs: 10_000 });

  const player = match.players.get(discordId);
  if (!player) return interaction.reply({ content: 'You are not in this match.', ephemeral: true, _autoDeleteMs: 10_000 });
  if (player.team !== teamNum) return interaction.reply({ content: 'This is not your team panel.', ephemeral: true, _autoDeleteMs: 10_000 });

  const result = recordOperatorChoice(matchId, discordId, operator);
  if (!result.success) {
    return interaction.reply({ content: result.error, ephemeral: true, _autoDeleteMs: 10_000 });
  }

  // Refresh the team's role select message
  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (textChannel) {
    const msg = await _postRoleSelectMessage(match, teamNum, textChannel);
    if (teamNum === 1) match._roleMsg1 = msg;
    else match._roleMsg2 = msg;
  }

  await interaction.deferUpdate().catch(() => {});

  _checkAllRolesComplete(match);
}

/**
 * Check if all players have completed role + operator selection.
 * If so, skip the timer and proceed to play phase.
 */
function _checkAllRolesComplete(match) {
  const allPlayers = [...match.players.values()];
  const allDone = allPlayers.every(p => p.weaponRoles.length >= 2 && p.operator);
  if (allDone) {
    if (match.timer) { clearTimeout(match.timer); match.timer = null; }
    // Disable role select messages and proceed
    (async () => {
      for (const msg of [match._roleMsg1, match._roleMsg2]) {
        if (msg) try { await msg.edit({ components: [] }); } catch { /* */ }
      }
      delete match._roleMsg1;
      delete match._roleMsg2;
      await startPlayPhase(match);
    })().catch(err => {
      console.error(`[QueueService] Auto-proceed to play phase failed for match #${match.id}:`, err.message);
    });
  }
}

// ── Report Result Button handler ──────────────────────────────
async function _handleReportButton(interaction) {
  // customId: queue_report_{matchId}_{winningTeam}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);
  const winningTeam = parseInt(parts[3], 10);
  const captainId = interaction.user.id;

  const result = recordVote(matchId, captainId, winningTeam);
  if (!result.success) {
    return interaction.reply({ content: result.error, ephemeral: true, _autoDeleteMs: 10_000 });
  }

  const match = getMatch(matchId);
  if (!match) return;

  const textChannel = _client?.channels?.cache?.get(match.textChannelId);

  if (!result.allVoted) {
    // First captain voted — notify
    if (textChannel) {
      await textChannel.send({
        content: `<@${captainId}> reported **Team ${winningTeam}** as the winner. Waiting for the other captain to confirm...`,
      });
    }
    return interaction.deferUpdate().catch(() => {});
  }

  // Both voted
  if (result.agreed) {
    // Captains agree — resolve
    if (textChannel) {
      await textChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('Match Result Confirmed')
            .setColor(0x2ecc71)
            .setDescription(`Both captains agree: **Team ${result.winningTeam}** wins!`)
        ],
      });
    }

    // Disable match message buttons
    if (match._matchMsg) {
      try { await match._matchMsg.edit({ components: [] }); } catch { /* */ }
    }

    await interaction.deferUpdate().catch(() => {});
    await resolveMatch(_client, match, result.winningTeam);
  } else {
    // Dispute — captains disagree
    const staffPings = [
      process.env.ADMIN_ROLE_ID,
      process.env.OWNER_ROLE_ID,
    ].filter(Boolean).map(id => `<@&${id}>`).join(' ');

    const disputeEmbed = new EmbedBuilder()
      .setTitle('Result Disputed')
      .setColor(0xe74c3c)
      .setDescription([
        'Captains disagree on the result.',
        `Captain 1 (<@${match.captains.team1}>) says: **Team ${match.captain1Vote}** won`,
        `Captain 2 (<@${match.captains.team2}>) says: **Team ${match.captain2Vote}** won`,
        '',
        `${staffPings} — Please resolve this dispute.`,
      ].join('\n'));

    const resolveRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_admin_resolve_${match.id}_1`)
        .setLabel('Team 1 Wins (Admin)')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`queue_admin_resolve_${match.id}_2`)
        .setLabel('Team 2 Wins (Admin)')
        .setStyle(ButtonStyle.Danger),
    );

    if (textChannel) {
      await textChannel.send({ embeds: [disputeEmbed], components: [resolveRow] });
    }
    await interaction.deferUpdate().catch(() => {});
  }
}

// ── Admin Resolve (Dispute) Button handler ────────────────────
async function _handleAdminResolveButton(interaction) {
  // customId: queue_admin_resolve_{matchId}_{winningTeam}
  if (!_isStaffMember(interaction.member)) {
    return interaction.reply({ content: 'Only staff can resolve disputes.', ephemeral: true, _autoDeleteMs: 10_000 });
  }

  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[3], 10);
  const winningTeam = parseInt(parts[4], 10);

  const match = getMatch(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true, _autoDeleteMs: 10_000 });
  if (match.phase === 'RESOLVED' || match.phase === 'CANCELLED') {
    return interaction.reply({ content: 'Match already resolved.', ephemeral: true, _autoDeleteMs: 10_000 });
  }

  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (textChannel) {
    await textChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Dispute Resolved by Staff')
          .setColor(0x2ecc71)
          .setDescription(`<@${interaction.user.id}> resolved the dispute: **Team ${winningTeam}** wins.`),
      ],
    });
  }

  // Disable the dispute resolve buttons
  try { await interaction.update({ components: [] }); } catch { /* */ }

  // Disable match message buttons too
  if (match._matchMsg) {
    try { await match._matchMsg.edit({ components: [] }); } catch { /* */ }
  }

  await resolveMatch(_client, match, winningTeam);
}

// ── Sub Button handler ────────────────────────────────────────
async function _handleSubButton(interaction) {
  if (!_isStaffMember(interaction.member)) {
    return interaction.reply({ content: 'Only staff can sub players.', ephemeral: true, _autoDeleteMs: 10_000 });
  }

  // customId: queue_sub_fresh_{matchId} or queue_sub_mid_{matchId}
  const isFresh = interaction.customId.startsWith('queue_sub_fresh_');
  // Use 'fresh' or 'midseries' (no underscore) in customIds to avoid split issues
  const subTypeKey = isFresh ? 'fresh' : 'midseries';
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[parts.length - 1], 10);

  const match = getMatch(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true, _autoDeleteMs: 10_000 });

  // Show buttons for each player in the match to select who to sub out
  const rows = [];
  let currentRow = new ActionRowBuilder();
  let btnCount = 0;

  for (const [discordId] of match.players) {
    const user = userRepo.findByDiscordId(discordId);
    const name = user?.display_name || discordId.slice(0, 15);
    const player = match.players.get(discordId);
    const teamLabel = player.team === 1 ? 'T1' : player.team === 2 ? 'T2' : '?';

    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_subselect_${matchId}_${subTypeKey}_${discordId}`)
        .setLabel(`[${teamLabel}] ${name}`)
        .setStyle(ButtonStyle.Primary),
    );
    btnCount++;

    if (btnCount % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }
  if (currentRow.components.length > 0) rows.push(currentRow);

  return interaction.reply({
    content: `Select the player to sub out (**${isFresh ? 'Fresh' : 'Mid-Series'}**):`,
    components: rows,
    ephemeral: true,
  });
}

// ── Sub Select Button handler (staff picks who to sub) ────────
async function _handleSubSelectButton(interaction) {
  if (!_isStaffMember(interaction.member)) {
    return interaction.reply({ content: 'Only staff can sub players.', ephemeral: true, _autoDeleteMs: 10_000 });
  }

  // customId: queue_subselect_{matchId}_{subTypeKey}_{discordId}
  // subTypeKey is 'fresh' or 'midseries' (no underscore)
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);
  const subTypeKey = parts[3]; // 'fresh' or 'midseries'
  const subType = subTypeKey === 'midseries' ? 'mid_series' : 'fresh';
  const targetDiscordId = parts[4];

  const match = getMatch(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true, _autoDeleteMs: 10_000 });

  const player = match.players.get(targetDiscordId);
  if (!player) return interaction.reply({ content: 'Player not in match.', ephemeral: true, _autoDeleteMs: 10_000 });

  // Find replacement from queue — closest XP
  const replacement = findClosestXpReplacement(player.xp);
  if (!replacement) {
    return interaction.update({
      content: 'No replacement available in the queue.',
      components: [],
    });
  }

  const result = subPlayerOut(matchId, targetDiscordId, replacement.discordId, subType);
  if (!result.success) {
    // Re-queue the replacement we just popped
    waitingQueue.push(replacement);
    return interaction.update({ content: `Sub failed: ${result.error}`, components: [] });
  }

  const textChannel = _client?.channels?.cache?.get(match.textChannelId);

  // Grant channel access to the replacement
  if (textChannel) {
    try {
      await textChannel.permissionOverwrites.create(replacement.discordId, {
        ViewChannel: true, SendMessages: true,
      });
    } catch { /* */ }
  }
  const voiceChannel = _client?.channels?.cache?.get(match.voiceChannelId);
  if (voiceChannel) {
    try {
      await voiceChannel.permissionOverwrites.create(replacement.discordId, {
        ViewChannel: true, Connect: true, Speak: true,
      });
    } catch { /* */ }
  }

  if (textChannel) {
    const subLabel = subType === 'fresh' ? 'Fresh Sub' : 'Mid-Series Sub';
    await textChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Player Substitution (${subLabel})`)
          .setColor(0xe67e22)
          .setDescription([
            `<@${targetDiscordId}> has been subbed out.`,
            `<@${replacement.discordId}> has been subbed in (${replacement.xp.toLocaleString()} XP).`,
          ].join('\n')),
      ],
    });
  }

  return interaction.update({ content: `Subbed <@${targetDiscordId}> out for <@${replacement.discordId}>.`, components: [] });
}

// ── DQ Button handler ─────────────────────────────────────────
async function _handleDqButton(interaction) {
  if (!_isStaffMember(interaction.member)) {
    return interaction.reply({ content: 'Only staff can DQ players.', ephemeral: true, _autoDeleteMs: 10_000 });
  }

  // customId: queue_dq_{matchId}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);

  const match = getMatch(matchId);
  if (!match) return interaction.reply({ content: 'Match not found.', ephemeral: true, _autoDeleteMs: 10_000 });

  // Show buttons for each player
  const rows = [];
  let currentRow = new ActionRowBuilder();
  let btnCount = 0;

  for (const [discordId] of match.players) {
    const user = userRepo.findByDiscordId(discordId);
    const name = user?.display_name || discordId.slice(0, 15);
    const player = match.players.get(discordId);
    const teamLabel = player.team === 1 ? 'T1' : player.team === 2 ? 'T2' : '?';

    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`queue_dqselect_${matchId}_${discordId}`)
        .setLabel(`[${teamLabel}] ${name}`)
        .setStyle(ButtonStyle.Danger),
    );
    btnCount++;

    if (btnCount % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }
  if (currentRow.components.length > 0) rows.push(currentRow);

  return interaction.reply({
    content: `Select the player to DQ (**-${QUEUE_CONFIG.DQ_PENALTY} XP penalty**):`,
    components: rows,
    ephemeral: true,
  });
}

// ── DQ Select Button handler ──────────────────────────────────
async function _handleDqSelectButton(interaction) {
  if (!_isStaffMember(interaction.member)) {
    return interaction.reply({ content: 'Only staff can DQ players.', ephemeral: true, _autoDeleteMs: 10_000 });
  }

  // customId: queue_dqselect_{matchId}_{discordId}
  const parts = interaction.customId.split('_');
  const matchId = parseInt(parts[2], 10);
  const targetDiscordId = parts[3];

  const match = getMatch(matchId);
  if (!match) return interaction.update({ content: 'Match not found.', components: [] });

  const player = match.players.get(targetDiscordId);
  if (!player) return interaction.update({ content: 'Player not in match.', components: [] });

  // Apply DQ penalty
  try {
    const user = userRepo.findByDiscordId(targetDiscordId);
    if (user) {
      userRepo.addXp(user.id, -QUEUE_CONFIG.DQ_PENALTY);

      if (neatqueueService.isConfigured()) {
        neatqueueService.addPoints(targetDiscordId, -QUEUE_CONFIG.DQ_PENALTY).catch(err => {
          console.error(`[QueueService] NeatQueue DQ penalty sync failed for ${targetDiscordId}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.error(`[QueueService] Failed to apply DQ penalty to ${targetDiscordId}:`, err.message);
  }

  const textChannel = _client?.channels?.cache?.get(match.textChannelId);
  if (textChannel) {
    await textChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Player Disqualified')
          .setColor(0xe74c3c)
          .setDescription([
            `<@${targetDiscordId}> has been **disqualified** by <@${interaction.user.id}>.`,
            `Penalty: **-${QUEUE_CONFIG.DQ_PENALTY} XP**`,
          ].join('\n')),
      ],
    });
  }

  return interaction.update({
    content: `DQ'd <@${targetDiscordId}> with -${QUEUE_CONFIG.DQ_PENALTY} XP penalty.`,
    components: [],
  });
}

// ═══════════════════════════════════════════════════════════════════

module.exports = {
  // Queue management
  joinQueue,
  leaveQueue,
  getQueueSize,
  getQueuePlayers,
  isInQueue,
  isInActiveMatch,

  // Match lifecycle
  createMatch,
  handleNoShows,
  findClosestXpReplacement,
  startCaptainVote,
  recordCaptainVote,
  finalizeCaptainVote,
  startCaptainPick,
  recordCaptainPick,
  autoPickForCaptain,
  startRoleSelect,
  recordRoleChoice,
  recordOperatorChoice,
  autoAssignRoles,
  startPlayPhase,
  recordVote,
  resolveMatch,
  cancelMatch,

  // Sub management
  subPlayerOut,

  // Lookup
  getMatch,
  getMatchByChannel,

  // Interaction router
  handleQueueInteraction,
};
