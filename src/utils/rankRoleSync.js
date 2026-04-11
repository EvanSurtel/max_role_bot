// Rank role assignment.
//
// The ranks panel is just a display. This module is what actually
// gives players their rank role on Discord based on their current
// season XP (or leaderboard position, for Crowned).
//
// Sync is triggered after any event that can change a user's rank:
//   - Match resolution (matchService.resolveMatch)
//   - Admin XP adjustment (leaderboardPanel handleAdminModal)
//   - Season reset (seasonPanel handleSeasonModal)
//   - New user onboarding (onboarding.handleRegistrationModal)
//
// Role IDs are looked up from env vars named after the RANK_TIERS
// keys: BRONZE_ROLE_ID, SILVER_ROLE_ID, ..., CROWNED_ROLE_ID. If a
// specific tier's env var isn't set, that rank just doesn't get
// assigned — the bot logs a note and moves on instead of crashing.

const { RANK_TIERS } = require('../config/constants');
const userRepo = require('../database/repositories/userRepo');
const db = require('../database/db');

function _envVarNameFor(tierKey) {
  // 'bronze' → 'BRONZE_ROLE_ID'
  return `${tierKey.toUpperCase()}_ROLE_ID`;
}

function _roleIdFor(tierKey) {
  return process.env[_envVarNameFor(tierKey)] || null;
}

/**
 * Every configured rank role ID, used when we want to strip any
 * stale rank roles before granting the new one. Missing env vars
 * are silently filtered out.
 */
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

/**
 * Return the position-based tier (Crowned) if one is defined, else
 * null. There's only one in RANK_TIERS today but the lookup stays
 * generic.
 */
function _positionBasedTier() {
  return RANK_TIERS.find(t => t.topN) || null;
}

/**
 * Is this user inside the top-N on the CURRENT season XP leaderboard?
 * Uses users.xp_points directly since that's the running season total
 * (reset to 500 on season end via seasonPanel).
 */
function _isUserInTopN(userId, n) {
  try {
    const rows = db.prepare(
      'SELECT id FROM users WHERE accepted_tos = 1 ORDER BY xp_points DESC LIMIT ?'
    ).all(n);
    return rows.some(r => r.id === userId);
  } catch (err) {
    console.error('[RankSync] top-N lookup failed:', err.message);
    return false;
  }
}

/**
 * Sync a single user's rank role. Picks the correct tier based on
 * their XP (or leaderboard position for Crowned), adds that tier's
 * role, and removes every other rank role the user might currently
 * hold so exactly one rank role remains.
 *
 * Silent on errors — missing env vars, unfetchable members, and
 * missing role permissions are all logged but never thrown. Rank
 * sync is a cosmetic layer; a failure here should not block the
 * underlying match resolve / adjust.
 */
async function syncRank(client, userId) {
  try {
    const user = userRepo.findById(userId);
    if (!user || !user.accepted_tos) return;

    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return;

    const member = await guild.members.fetch(user.discord_id).catch(() => null);
    if (!member) return;

    // Decide the target tier: Crowned if in top N, else the XP tier.
    const crowned = _positionBasedTier();
    let targetTier = _tierForXp(user.xp_points || 0);
    if (crowned && crowned.topN && _isUserInTopN(userId, crowned.topN)) {
      targetTier = crowned;
    }

    const targetRoleId = _roleIdFor(targetTier.key);
    const allRankRoleIds = _allConfiguredRankRoleIds();

    // Remove any other rank roles the member still holds
    for (const roleId of allRankRoleIds) {
      if (roleId === targetRoleId) continue;
      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId).catch(err => {
          console.warn(`[RankSync] Could not remove role ${roleId} from ${user.discord_id}: ${err.message}`);
        });
      }
    }

    // Grant the target role if the env var is set and the member
    // doesn't already have it
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
 * Sync ranks for a set of users in sequence. Used after match
 * resolution (the match participants) and after season reset
 * (everyone who accepted TOS). Errors in one user don't stop the
 * loop.
 */
async function syncRanks(client, userIds) {
  for (const id of userIds) {
    await syncRank(client, id);
  }
}

/**
 * Re-sync every user who has accepted TOS. Used on season reset
 * where the XP reset pushes everyone back to the Bronze baseline
 * (or wherever 500 XP lands in RANK_TIERS).
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
