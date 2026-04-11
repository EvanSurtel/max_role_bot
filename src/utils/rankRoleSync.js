// Rank role assignment.
//
// NeatQueue is the source of truth for XP. Our local users.xp_points
// is a stale cache because NeatQueue queue matches (the 5v5 ranked
// queue our bot doesn't touch) award XP directly on the NeatQueue
// side, never touching our DB. So rank roles MUST read from
// NeatQueue's stored leaderboard, not our local column.
//
// Flow on any XP-relevant event:
//   1. Fetch NeatQueue's full channel leaderboard (one API call)
//   2. Look up each affected user by Discord ID in that leaderboard
//   3. Derive their XP-based tier (Bronze → Obsidian) from the points
//      NeatQueue reports for them
//   4. If they sit in the top N of that leaderboard, upgrade them to
//      the position-based tier (Crowned)
//   5. Grant the target rank role and strip every other rank role
//
// If NeatQueue is unreachable or not configured, we fall back to
// local users.xp_points so the bot still works in a degraded mode
// instead of crashing. But NeatQueue is the canonical answer whenever
// it's available.
//
// Triggered from:
//   - matchService.resolveMatch (every match participant, batched)
//   - leaderboardPanel admin XP adjust (single user)
//   - seasonPanel season end (every accepted-TOS user)
//   - onboarding registration (new user)
//
// Role IDs: BRONZE_ROLE_ID .. CROWNED_ROLE_ID env vars. Missing
// env vars are silently skipped.

const { RANK_TIERS } = require('../config/constants');
const userRepo = require('../database/repositories/userRepo');
const neatqueueService = require('../services/neatqueueService');
const db = require('../database/db');

function _envVarNameFor(tierKey) {
  return `${tierKey.toUpperCase()}_ROLE_ID`;
}

function _roleIdFor(tierKey) {
  return process.env[_envVarNameFor(tierKey)] || null;
}

function _allConfiguredRankRoleIds() {
  return RANK_TIERS.map(t => _roleIdFor(t.key)).filter(Boolean);
}

/**
 * Resolve the XP-based tier for a given XP amount. Walks RANK_TIERS
 * in order and returns the highest tier whose minXp floor the user
 * has crossed. Position-based tiers (e.g. Crowned with topN) are
 * skipped here — those are decided separately in syncRank().
 */
function _tierForXp(xp) {
  let match = RANK_TIERS[0];
  for (const tier of RANK_TIERS) {
    if (tier.topN) continue;
    if (typeof tier.minXp === 'number' && tier.minXp <= xp) {
      match = tier;
    }
  }
  return match;
}

function _positionBasedTier() {
  return RANK_TIERS.find(t => t.topN) || null;
}

/**
 * Normalize whatever shape NeatQueue returns from the leaderboard
 * endpoint into a flat array of `{ userId, points }` entries sorted
 * by descending points (top of the leaderboard first).
 *
 * The API response shape isn't documented in our codebase, so we
 * accept a few common shapes: a bare array, `{ leaderboard: [...] }`,
 * `{ data: [...] }`, or `{ players: [...] }`. Inside each entry the
 * user ID field is often `user_id` / `userId` / `id`, and the points
 * field is often `points` / `score` / `stats.points`. We probe them
 * all so we're resilient to small API changes.
 */
function _normalizeLeaderboard(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw)
    ? raw
    : (raw.leaderboard || raw.data || raw.players || raw.entries || []);
  if (!Array.isArray(arr)) return [];

  const normalized = arr.map(entry => {
    const userId = String(
      entry.user_id || entry.userId || entry.id || entry.discord_id || entry.discordId || ''
    );
    const points = Number(
      entry.points ?? entry.score ?? entry.stats?.points ?? entry.xp ?? 0
    );
    return { userId, points };
  }).filter(e => e.userId);

  // Sort descending by points — NeatQueue probably already does this
  // but we re-sort to guarantee the top-N lookup is correct.
  normalized.sort((a, b) => b.points - a.points);
  return normalized;
}

/**
 * Fetch and normalize the NeatQueue leaderboard. Returns null if
 * NeatQueue isn't configured or the request failed — callers should
 * treat null as "fall back to local xp_points".
 */
async function _fetchLeaderboard() {
  if (!neatqueueService.isConfigured()) return null;
  try {
    const raw = await neatqueueService.getChannelLeaderboard();
    if (!raw) return null;
    return _normalizeLeaderboard(raw);
  } catch (err) {
    console.warn('[RankSync] NeatQueue leaderboard fetch failed:', err.message);
    return null;
  }
}

/**
 * Look up a user's points + top-N position in the normalized
 * leaderboard. Returns `{ points, inTopN }` when found, or null
 * when the user isn't on the leaderboard at all (which for a new
 * user means "fall back to local xp_points").
 */
function _lookupInLeaderboard(leaderboard, discordId, topN) {
  if (!leaderboard) return null;
  const idStr = String(discordId);
  const idx = leaderboard.findIndex(e => e.userId === idStr);
  if (idx === -1) return null;
  return {
    points: leaderboard[idx].points,
    inTopN: idx < topN,
  };
}

/**
 * Sync a single user's rank role. Uses NeatQueue as the source of
 * truth for both the point total and the top-N check, falling back
 * to local xp_points if NeatQueue is unavailable.
 *
 * The `leaderboard` parameter is optional — if callers are syncing
 * a batch (e.g., all match participants) they should fetch the
 * leaderboard ONCE and pass it in to avoid N API calls. Single-user
 * callers (onboarding, admin adjust) can omit it and we'll fetch.
 */
async function syncRank(client, userId, leaderboard = undefined) {
  try {
    const user = userRepo.findById(userId);
    if (!user || !user.accepted_tos) return;

    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return;

    const member = await guild.members.fetch(user.discord_id).catch(() => null);
    if (!member) return;

    // Fetch leaderboard if not supplied (single-user path)
    const lb = leaderboard === undefined ? await _fetchLeaderboard() : leaderboard;

    const crowned = _positionBasedTier();
    const topN = crowned?.topN || 10;

    // Prefer NeatQueue's stored value; fall back to local xp_points.
    let userPoints = null;
    let inTopN = false;

    if (lb) {
      const hit = _lookupInLeaderboard(lb, user.discord_id, topN);
      if (hit) {
        userPoints = hit.points;
        inTopN = hit.inTopN;
      }
    }

    if (userPoints === null) {
      userPoints = user.xp_points || 0;
      // Fallback top-N check against local xp_points when NeatQueue
      // couldn't tell us. Uses a direct SQL query for the top N.
      try {
        const rows = db.prepare(
          'SELECT id FROM users WHERE accepted_tos = 1 ORDER BY xp_points DESC LIMIT ?'
        ).all(topN);
        inTopN = rows.some(r => r.id === userId);
      } catch { /* ignore */ }
    }

    // Pick the target tier
    let targetTier = _tierForXp(userPoints);
    if (crowned && inTopN) {
      targetTier = crowned;
    }

    const targetRoleId = _roleIdFor(targetTier.key);
    const allRankRoleIds = _allConfiguredRankRoleIds();

    // Strip any other rank roles the member is carrying
    for (const roleId of allRankRoleIds) {
      if (roleId === targetRoleId) continue;
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId).catch(err => {
          console.warn(`[RankSync] Could not remove role ${roleId} from ${user.discord_id}: ${err.message}`);
        });
      }
    }

    // Grant the target role if it's configured and not already held
    if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
      await member.roles.add(targetRoleId).catch(err => {
        console.warn(`[RankSync] Could not add role ${targetRoleId} to ${user.discord_id}: ${err.message}`);
      });
    } else if (!targetRoleId) {
      console.log(`[RankSync] ${_envVarNameFor(targetTier.key)} not set — skipping grant for ${user.discord_id}`);
    }
  } catch (err) {
    console.error(`[RankSync] Error syncing rank for user ${userId}: ${err.message}`);
  }
}

/**
 * Sync ranks for multiple users. Fetches the NeatQueue leaderboard
 * ONCE and passes it down to each per-user sync call.
 */
async function syncRanks(client, userIds) {
  const leaderboard = await _fetchLeaderboard();
  for (const id of userIds) {
    await syncRank(client, id, leaderboard);
  }
}

/**
 * Re-sync every user who has accepted TOS. Used on season reset
 * where everyone drops back to the 500-XP baseline.
 */
async function syncAllRanks(client) {
  try {
    const rows = db.prepare('SELECT id FROM users WHERE accepted_tos = 1').all();
    const ids = rows.map(r => r.id);
    console.log(`[RankSync] Syncing ranks for ${ids.length} users`);
    await syncRanks(client, ids);
  } catch (err) {
    console.error('[RankSync] syncAllRanks failed:', err.message);
  }
}

module.exports = { syncRank, syncRanks, syncAllRanks };
