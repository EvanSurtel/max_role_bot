// Rank role assignment.
//
// XP source of truth: local users.xp_points. Tier is derived directly
// from RANK_TIERS in constants.js. Crowned is position-based — the top
// N users by xp_points DESC, restricted to those who have crossed the
// Obsidian threshold.
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
const db = require('../database/db');
const { langFor } = require('../locales/i18n');
const { getLocale } = require('../locales');

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

    let targetTier = _tierForXp(userPoints);
    if (crowned && inTopN) {
      targetTier = crowned;
    }

    const targetRoleId = _roleIdFor(targetTier.key);
    const allRankRoleIds = _allConfiguredRankRoleIds();

    // Detect the member's CURRENT rank tier BEFORE we mutate roles —
    // we need this to decide if the sync results in a promotion or
    // demotion (for the post-sync DM). Members only ever carry ONE
    // rank role at a time (all others get stripped below), so the
    // first match wins.
    let oldTierKey = null;
    for (const tier of RANK_TIERS) {
      const roleId = _roleIdFor(tier.key);
      if (roleId && member.roles.cache.has(roleId)) {
        oldTierKey = tier.key;
        break;
      }
    }

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
    let roleGranted = false;
    if (targetRoleId && !member.roles.cache.has(targetRoleId)) {
      await member.roles.add(targetRoleId).then(() => { roleGranted = true; }).catch(err => {
        console.warn(`[RankSync] Could not add role ${targetRoleId} to ${user.discord_id}: ${err.message}`);
      });
    } else if (!targetRoleId) {
      console.log(`[RankSync] ${_envVarNameFor(targetTier.key)} not set — skipping grant for ${user.discord_id}`);
    }

    // DM the user on rank change. Only fires when the member had a
    // PREVIOUS rank role (so first-time onboarding doesn't spam a DM
    // saying "you promoted to Bronze") and the tier key actually
    // changed. Uses buildRankCard for identical output to /rank.
    if (roleGranted && oldTierKey && oldTierKey !== targetTier.key) {
      _notifyRankChange(member, oldTierKey, targetTier.key).catch(err => {
        console.warn(`[RankSync] DM to ${user.discord_id} failed: ${err.message}`);
      });
    }
  } catch (err) {
    console.error(`[RankSync] Error syncing rank for user ${userId}: ${err.message}`);
  }
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
