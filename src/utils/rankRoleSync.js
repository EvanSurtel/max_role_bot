// Rank role assignment.
//
// XP source of truth: local users.xp_points. Tier is derived from
// RANK_TIERS in constants.js. Each numeric tier (Bronze .. Sentinel)
// is split into 3 sub-tiers (I, II, III) by computeSubTier — the
// granted Discord role matches the sub-tier exactly. Obsidian and
// Top 10 are flat (no sub-tier).
//
// Triggered from:
//   - matchService.resolveMatch (every match participant, batched)
//   - leaderboardPanel admin XP adjust (single user)
//   - seasonPanel season end (every accepted-TOS user)
//   - onboarding registration (new user)
//
// Role IDs come from .env vars (see src/utils/subTier.js for the full
// naming list — BRONZE_I_ROLE_ID, OBSIDIAN_ROLE_ID, TOP_10_ROLE_ID,
// etc.). Missing env vars / unknown role IDs are silently skipped.

const { RANK_TIERS } = require('../config/constants');
const userRepo = require('../database/repositories/userRepo');
const db = require('../database/db');
const { langFor } = require('../locales/i18n');
const { getLocale } = require('../locales');
const {
  computeSubTier,
  allSubTierEnvVarNames,
  roleIdForSubTier,
} = require('./subTier');

function _positionBasedTier() {
  return RANK_TIERS.find(t => t.topN) || null;
}

/**
 * Every configured rank-role ID across every sub-tier env var.
 * Filters out unset / blank vars.
 */
function _allConfiguredRankRoleIds() {
  return allSubTierEnvVarNames()
    .map(v => process.env[v])
    .filter(Boolean);
}

/**
 * Sync a single user's rank role from local users.xp_points.
 */
async function syncRank(client, userId) {
  try {
    const user = userRepo.findById(userId);
    if (!user || !user.accepted_tos) return;

    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return;

    const member = await guild.members.fetch(user.discord_id).catch(() => null);
    if (!member) return;

    const crowned = _positionBasedTier();
    const topN = crowned?.topN || 10;
    const obsidianMinXp = RANK_TIERS.find(t => t.key === 'obsidian')?.minXp || 4500;

    const userPoints = user.xp_points || 0;

    // Crowned = top N by xp_points among users at or above the
    // Obsidian threshold. Ties broken by lower id (earlier row) via
    // SQLite's stable-but-undefined default ordering — good enough
    // given that identical xp_points values are rare at 4500+.
    let inTopN = false;
    try {
      if (userPoints >= obsidianMinXp) {
        const obsidianUsers = db.prepare(
          'SELECT id FROM users WHERE accepted_tos = 1 AND xp_points >= ? ORDER BY xp_points DESC LIMIT ?'
        ).all(obsidianMinXp, topN);
        inTopN = obsidianUsers.some(r => r.id === userId);
      }
    } catch { /* ignore */ }

    const target = computeSubTier(userPoints, inTopN);
    const targetRoleId = roleIdForSubTier(target);

    // Every configured rank-role ID across every sub-tier. Used to
    // strip stale roles after promotion/demotion (Bronze II → III,
    // or Bronze III → Silver I, etc.).
    const allRankRoleIds = new Set(_allConfiguredRankRoleIds());

    // Detect the member's CURRENT rank role BEFORE we mutate so we
    // can decide whether this sync was a TIER change (Bronze →
    // Silver, DM) vs sub-tier change within same tier (Bronze II →
    // III, silent role swap).
    let oldRoleId = null;
    for (const r of member.roles.cache.values()) {
      if (allRankRoleIds.has(r.id)) { oldRoleId = r.id; break; }
    }
    const oldTierKey = oldRoleId ? _tierKeyFromRoleId(oldRoleId) : null;

    // Strip any rank-tier role the member is carrying that isn't the
    // target. Robust to a member somehow ending up with multiple.
    for (const r of [...member.roles.cache.values()]) {
      if (allRankRoleIds.has(r.id) && r.id !== targetRoleId) {
        await member.roles.remove(r.id).catch(err => {
          console.warn(`[RankSync] Could not remove role ${r.id} from ${user.discord_id}: ${err.message}`);
        });
      }
    }

    // Grant the target role if it's configured and not already held.
    let roleGranted = false;
    if (targetRoleId) {
      if (!member.roles.cache.has(targetRoleId)) {
        await member.roles.add(targetRoleId).then(() => { roleGranted = true; }).catch(err => {
          console.warn(`[RankSync] Could not add role ${targetRoleId} to ${user.discord_id}: ${err.message}`);
        });
      }
    } else {
      console.log(`[RankSync] ${target.envVar} not set — skipping grant for ${user.discord_id}.`);
    }

    // DM the user only on TIER promotion/demotion (Bronze → Silver),
    // not on sub-tier movement within the same tier (Bronze II →
    // Bronze III). Avoids DM spam for every match-resolve sub-tier
    // bump. First-time role grant (oldTierKey == null) skipped.
    if (roleGranted && oldTierKey && oldTierKey !== target.tierKey) {
      _notifyRankChange(member, oldTierKey, target.tierKey).catch(err => {
        console.warn(`[RankSync] DM to ${user.discord_id} failed: ${err.message}`);
      });
    }
  } catch (err) {
    console.error(`[RankSync] Error syncing rank for user ${userId}: ${err.message}`);
  }
}

/**
 * Reverse-map a Discord role ID back to its tier key by walking the
 * env vars. Used to detect tier changes for DM logic.
 */
function _tierKeyFromRoleId(roleId) {
  for (const envVarName of allSubTierEnvVarNames()) {
    if (process.env[envVarName] === roleId) {
      // Env var name format: TIERKEY[_ROMAN]_ROLE_ID. Extract the
      // tier key from the prefix.
      if (envVarName === 'TOP_10_ROLE_ID') return 'crowned';
      const m = envVarName.match(/^([A-Z]+)(?:_I{1,3})?_ROLE_ID$/);
      return m ? m[1].toLowerCase() : null;
    }
  }
  return null;
}

/**
 * Send a promotion/demotion DM with the same rank card output as
 * the /rank @user command. Silently swallows errors — users can
 * disable DMs and we don't want that to break the sync flow.
 */
async function _notifyRankChange(member, oldTierKey, newTierKey) {
  const oldIdx = RANK_TIERS.findIndex(t => t.key === oldTierKey);
  const newIdx = RANK_TIERS.findIndex(t => t.key === newTierKey);
  const isPromotion = newIdx > oldIdx;

  // Per-user language, same source the rest of the bot uses.
  const lang = langFor({ user: member.user, member });
  const tRanks = getLocale('ranks', lang);
  const newName = (tRanks[newTierKey] && tRanks[newTierKey].name) || newTierKey;
  const oldName = (tRanks[oldTierKey] && tRanks[oldTierKey].name) || oldTierKey;

  const header = isPromotion
    ? `🎉 **Rank up!** You promoted from **${oldName}** to **${newName}**.`
    : `📉 **Rank change** — you moved from **${oldName}** to **${newName}**.`;

  // buildRankCard is the same helper the /rank command uses, so the
  // DM output is identical to what a user sees when they run /rank.
  // Require lazily to avoid a circular dep at module load time.
  const { buildRankCard } = require('../commands/rank');
  const card = await buildRankCard(member.user, lang);
  if (card.kind !== 'card') return; // render failed — skip DM

  await member.send({
    content: `${header}\n${card.content}`,
    embeds: card.embeds,
    files: card.files,
    allowedMentions: { users: [] },
  });
}

/**
 * Sync ranks for multiple users.
 */
async function syncRanks(client, userIds) {
  for (const id of userIds) {
    await syncRank(client, id);
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
