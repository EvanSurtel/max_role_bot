// In-memory queue state and player/match factories.
//
// The WAITING QUEUE itself is still transient (lightweight, no money
// at stake for queued-but-not-matched players). Active QUEUE MATCHES,
// however, are persisted to the `queue_matches` table — see
// src/database/repositories/queueMatchRepo. On bot startup, the
// recovery function below loads active rows and rehydrates the
// activeMatches Map so in-progress lobbies survive restarts.

const QUEUE_CONFIG = require('../config/queueConfig');

// ─── Shared mutable state ────────────────────────────────────────
const waitingQueue = [];           // Array<{ discordId, joinedAt, xp }>
const activeMatches = new Map();   // matchCategoryId → QueueMatch
let _matchIdCounter = 0;
let _client = null;                // Discord client ref, set once at first interaction

// ─── Factories ───────────────────────────────────────────────────

// Create a blank QueueMatch object with default fields.
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

// Create a blank player object for a queue participant.
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

// ─── Queue management ────────────────────────────────────────────

/**
 * Add a player to the waiting queue.
 * @param {string} discordId — Discord user ID.
 * @param {number} xp — Player's current XP.
 * @returns {number} New queue size.
 */
function joinQueue(discordId, xp) {
  if (isInQueue(discordId)) return waitingQueue.length;
  waitingQueue.push({ discordId, joinedAt: Date.now(), xp });
  return waitingQueue.length;
}

/**
 * Remove a player from the waiting queue.
 * @param {string} discordId — Discord user ID.
 * @returns {boolean} True if the player was removed.
 */
function leaveQueue(discordId) {
  const idx = waitingQueue.findIndex(p => p.discordId === discordId);
  if (idx === -1) return false;
  waitingQueue.splice(idx, 1);
  return true;
}

/**
 * Get the current waiting queue size.
 * @returns {number} Number of players in queue.
 */
function getQueueSize() {
  return waitingQueue.length;
}

/**
 * Get a shallow copy of the waiting queue.
 * @returns {Array<{ discordId: string, joinedAt: number, xp: number }>}
 */
function getQueuePlayers() {
  return [...waitingQueue];
}

/**
 * Check if a player is in the waiting queue.
 * @param {string} discordId — Discord user ID.
 * @returns {boolean}
 */
function isInQueue(discordId) {
  return waitingQueue.some(p => p.discordId === discordId);
}

/**
 * Check if a player is in an active (non-resolved/cancelled) match.
 * @param {string} discordId — Discord user ID.
 * @returns {number|null} The match ID, or null.
 */
function isInActiveMatch(discordId) {
  for (const [, match] of activeMatches) {
    if (match.phase === 'RESOLVED' || match.phase === 'CANCELLED') continue;
    if (match.players.has(discordId)) return match.id;
  }
  return null;
}

// ─── Match lookup ────────────────────────────────────────────────

/**
 * Get a match by its auto-increment ID.
 * @param {number} matchId — Match ID.
 * @returns {object|null} The QueueMatch object, or null.
 */
function getMatch(matchId) {
  for (const [, match] of activeMatches) {
    if (match.id === matchId) return match;
  }
  return null;
}

/**
 * Get a match by one of its channel IDs (text or voice).
 * @param {string} channelId — Discord channel ID.
 * @returns {object|null} The QueueMatch object, or null.
 */
function getMatchByChannel(channelId) {
  for (const [, match] of activeMatches) {
    if (match.textChannelId === channelId || match.voiceChannelId === channelId) {
      return match;
    }
  }
  return null;
}

/**
 * Store or retrieve the Discord client reference.
 * @param {import('discord.js').Client} [client] — If provided, sets the client.
 * @returns {import('discord.js').Client|null} The stored client.
 */
function setClient(client) {
  if (client) _client = client;
  return _client;
}

/**
 * Increment and return the next match ID.
 * @returns {number} The new match ID.
 */
function nextMatchId() {
  _matchIdCounter += 1;
  return _matchIdCounter;
}

/**
 * Startup recovery. Loads active queue_matches rows, cancels any
 * mid-flight matches, and seeds _matchIdCounter to MAX(id) so new
 * matches never collide with persisted ones.
 *
 * Why cancel instead of resume: each phase (captain vote, captain
 * pick, role select, play) keeps its own in-memory state — the
 * setTimeout handle, Discord message refs for the current UI,
 * pending captain-pick operators, etc. None of that survives a
 * restart. Rehydrating the row but leaving `timer: null` stranded
 * the match — 10 players waiting for a phase advance that never
 * fires. Better to cancel cleanly and tell the queue channel to
 * re-queue than to leave ghosts in activeMatches.
 *
 * Queue matches are XP-only with no money at stake and XP is only
 * written on RESOLVED, so cancelling here is a no-op for user
 * balances.
 *
 * Called from src/index.js after Discord client is ready (via
 * setClient). Must be called BEFORE any queue interactions are
 * accepted so stale Discord channels get cleaned up before users
 * can interact with them.
 */
function recoverFromDb() {
  try {
    const queueMatchRepo = require('../database/repositories/queueMatchRepo');
    const maxId = queueMatchRepo.findMaxId();
    if (maxId > _matchIdCounter) _matchIdCounter = maxId;

    const rows = queueMatchRepo.findActive();
    if (rows.length === 0) {
      console.log('[QueueRecovery] No active queue matches to recover');
      return { cancelled: 0 };
    }

    const { _cleanupMatchChannels } = require('./helpers');
    let cancelled = 0;

    for (const match of rows) {
      try {
        queueMatchRepo.markCancelled(match.id);
        cancelled++;
        console.warn(
          `[QueueRecovery] Cancelled mid-flight match #${match.id} ` +
          `(phase=${match.phase}) — players must re-queue.`,
        );

        // Best-effort Discord channel cleanup. Fire-and-forget so a
        // single failure doesn't block recovery of other rows.
        if (match.categoryId && _client) {
          _cleanupMatchChannels(_client, match).catch((err) => {
            console.error(
              `[QueueRecovery] Channel cleanup failed for match #${match.id}: ${err.message}`,
            );
          });
        }
      } catch (err) {
        console.error(
          `[QueueRecovery] Failed to cancel match #${match.id}: ${err.message}`,
        );
      }
    }

    console.log(`[QueueRecovery] Cancelled ${cancelled} mid-flight queue match(es)`);
    return { cancelled };
  } catch (err) {
    console.error('[QueueRecovery] Failed to recover from DB:', err.message);
    return { cancelled: 0, error: err.message };
  }
}

/**
 * Convenience: persist a match's current state. Delegates to
 * queueMatchRepo.save — provided here so queue phase files can do
 * `state.save(match)` without importing the repo directly.
 */
function save(match) {
  try {
    const queueMatchRepo = require('../database/repositories/queueMatchRepo');
    queueMatchRepo.save(match);
  } catch (err) {
    console.error(`[QueueState] save failed for match #${match?.id}:`, err.message);
  }
}

function markResolved(matchId) {
  try {
    require('../database/repositories/queueMatchRepo').markResolved(matchId);
  } catch (err) {
    console.error(`[QueueState] markResolved failed for #${matchId}:`, err.message);
  }
}

function markCancelled(matchId) {
  try {
    require('../database/repositories/queueMatchRepo').markCancelled(matchId);
  } catch (err) {
    console.error(`[QueueState] markCancelled failed for #${matchId}:`, err.message);
  }
}

module.exports = {
  // Raw state (import for direct mutation where needed)
  waitingQueue,
  activeMatches,

  // Factories
  _newQueueMatch,
  _newPlayer,

  // Queue management
  joinQueue,
  leaveQueue,
  getQueueSize,
  getQueuePlayers,
  isInQueue,
  isInActiveMatch,

  // Match lookup
  getMatch,
  getMatchByChannel,
  getActiveMatchCount: () => {
    let count = 0;
    for (const match of activeMatches.values()) {
      if (match.phase !== 'RESOLVED' && match.phase !== 'CANCELLED') count++;
    }
    return count;
  },

  // Client & ID
  setClient,
  nextMatchId,

  // Persistence
  save,
  markResolved,
  markCancelled,
  recoverFromDb,
};
