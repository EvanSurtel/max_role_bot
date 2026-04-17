// Queue service — in-memory state machine for 5v5 ranked queue matches.
//
// All state is transient (resets on bot restart). This is fine because
// queue matches are short-lived — a match that hasn't resolved before
// a restart was probably abandoned and the players can re-queue.
//
// Phase flow:
//   WAITING_VOICE → CAPTAIN_VOTE → CAPTAIN_PICK → ROLE_SELECT → PLAYING → VOTING → RESOLVED
//                                                                                 → CANCELLED

const { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const QUEUE_CONFIG = require('../config/queueConfig');
const userRepo = require('../database/repositories/userRepo');
const neatqueueService = require('./neatqueueService');
const { getCurrentSeason } = require('../panels/leaderboardPanel');

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
    await startCaptainVote(match);
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
        await startCaptainVote(match);
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
 * Begin captain voting. Each player votes for who they want as captain.
 * Top 2 vote-getters become captains. Stub — full implementation in Stage 2.
 */
async function startCaptainVote(match) {
  match.phase = 'CAPTAIN_VOTE';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  console.log(`[QueueService] Match #${match.id} entering CAPTAIN_VOTE phase`);
  // Stage 2: post captain vote embed with buttons, set CAPTAIN_VOTE_TIMEOUT timer
}

/**
 * Record a captain vote. Returns { success, error }.
 */
function recordCaptainVote(matchId, voterId, votedForId) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'CAPTAIN_VOTE') return { success: false, error: 'Not in captain vote phase' };
  if (!match.players.has(voterId)) return { success: false, error: 'Not a player in this match' };
  if (!match.players.has(votedForId)) return { success: false, error: 'Voted player not in this match' };

  match.captainVotes.set(voterId, votedForId);
  return { success: true };
}

/**
 * Tally votes and assign captains. Stub — full implementation in Stage 2.
 */
function finalizeCaptainVote(match) {
  // Stage 2: tally captainVotes, pick top 2, break ties by XP,
  // assign captains, proceed to startCaptainPick
  console.log(`[QueueService] Match #${match.id} finalizing captain vote`);
}

// ═══════════════════════════════════════════════════════════════════
// Captain pick phase (stub — Stage 2)
// ═══════════════════════════════════════════════════════════════════

/**
 * Begin pick phase. Random first pick; captains alternate picking players.
 * Stub — full implementation in Stage 2.
 */
async function startCaptainPick(match) {
  match.phase = 'CAPTAIN_PICK';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  console.log(`[QueueService] Match #${match.id} entering CAPTAIN_PICK phase`);
  // Stage 2: determine pick order, post pick embed with buttons
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
 * Begin role selection. Players choose weapon roles and operators.
 * Stub — full implementation in Stage 2.
 */
async function startRoleSelect(match) {
  match.phase = 'ROLE_SELECT';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  console.log(`[QueueService] Match #${match.id} entering ROLE_SELECT phase`);
  // Stage 2: post role select embed with buttons, set ROLE_SELECT_TIMEOUT timer
}

/**
 * Record a weapon role choice. Returns { success, error }.
 */
function recordRoleChoice(matchId, discordId, role) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'ROLE_SELECT') return { success: false, error: 'Not in role select phase' };

  const player = match.players.get(discordId);
  if (!player) return { success: false, error: 'Not a player in this match' };

  const roleConfig = QUEUE_CONFIG.WEAPON_ROLES[role];
  if (!roleConfig) return { success: false, error: 'Invalid weapon role' };

  const teamRoles = player.team === 1 ? match.team1Roles : match.team2Roles;
  const currentCount = teamRoles.get(role) || 0;
  if (currentCount >= roleConfig.max) return { success: false, error: `${roleConfig.label} is full (max ${roleConfig.max})` };

  // Remove previous role if any
  for (const prevRole of player.weaponRoles) {
    const prevCount = teamRoles.get(prevRole) || 0;
    if (prevCount > 0) teamRoles.set(prevRole, prevCount - 1);
  }

  player.weaponRoles = [role];
  teamRoles.set(role, (teamRoles.get(role) || 0) + 1);

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
 * to fill unassigned players into the first available role.
 */
function autoAssignRoles(match) {
  for (const teamNum of [1, 2]) {
    const teamRoles = teamNum === 1 ? match.team1Roles : match.team2Roles;
    const teamPlayers = [...match.players.values()].filter(p => p.team === teamNum);
    const unassigned = teamPlayers.filter(p => p.weaponRoles.length === 0);

    for (const player of unassigned) {
      for (const role of QUEUE_CONFIG.AUTO_ROLE_PRIORITY) {
        const config = QUEUE_CONFIG.WEAPON_ROLES[role];
        const current = teamRoles.get(role) || 0;
        if (current < config.max) {
          player.weaponRoles = [role];
          teamRoles.set(role, current + 1);
          console.log(`[QueueService] Auto-assigned ${player.discordId} to ${role} in match #${match.id}`);
          break;
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Play + voting phases (stub — Stage 2)
// ═══════════════════════════════════════════════════════════════════

/**
 * Display match info and start the play timer.
 * Stub — full implementation in Stage 2.
 */
async function startPlayPhase(match) {
  match.phase = 'PLAYING';
  if (match.timer) { clearTimeout(match.timer); match.timer = null; }
  console.log(`[QueueService] Match #${match.id} entering PLAYING phase`);
  // Stage 2: post match summary embed (teams, roles, operators, maps),
  // set PLAY_TIMEOUT timer
}

/**
 * Record a captain's vote for the winning team. Returns { success, allVoted }.
 */
function recordVote(matchId, captainDiscordId, winningTeam) {
  const match = getMatch(matchId);
  if (!match) return { success: false, error: 'Match not found' };
  if (match.phase !== 'VOTING') return { success: false, error: 'Not in voting phase' };

  if (captainDiscordId === match.captains.team1) {
    match.captain1Vote = winningTeam;
  } else if (captainDiscordId === match.captains.team2) {
    match.captain2Vote = winningTeam;
  } else {
    return { success: false, error: 'Not a captain' };
  }

  const allVoted = match.captain1Vote !== null && match.captain2Vote !== null;
  return { success: true, allVoted };
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
};
