// Rank role assignment.
//
// XP source of truth: local users.xp_points. Tier is derived from
// RANK_TIERS in constants.js. Each numeric tier (Bronze .. Obsidian)
// is split into 3 sub-tiers (I, II, III) by computeSubTier — the
// granted Discord role matches the sub-tier exactly. Top 10 is
// position-based, no sub-tier.
//
// Triggered from:
//   - matchService.resolveMatch (every match participant, batched)
//   - leaderboardPanel admin XP adjust (single user)
//   - seasonPanel season end (every accepted-TOS user)
//   - onboarding registration (new user)
//
// Role lookup is BY NAME on the guild, not by env var. Operator
// creates 22 Discord roles named exactly:
//   Bronze I, Bronze II, Bronze III, Silver I .. Obsidian III, Top 10
// (See src/utils/subTier.js allSubTierRoleNames for the canonical
// list.) Missing roles are silently skipped — bot logs a warning so
// operator can see if any are misnamed.

const { RANK_TIERS } = require('../config/constants');
const userRepo = require('../database/repositories/userRepo');
const db = require('../database/db');
const { langFor } = require('../locales/i18n');
const { getLocale } = require('../locales');
const { computeSubTier, allSubTierRoleNames, formatSubTierLocalized } = require('./subTier');

function _positionBasedTier() {
  return RANK_TIERS.find(t => t.topN) || null;
}

/**
 * Resolve a Discord role by exact name on the guild. Returns null
 * if no role with that name exists.
 */
function _findRoleByName(guild, name) {
  return guild.roles.cache.find(r => r.name === name) || null;
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
    const targetRole = _findRoleByName(guild, target.roleName);

    // Build the set of every possible sub-tier role NAME on this
    // server so we can strip stale ones after promotion/demotion
    // (Bronze II → Bronze III, or Bronze III → Silver I).
    const allRoleNames = new Set(allSubTierRoleNames());

    // Detect the member's CURRENT sub-tier role BEFORE we mutate, so
    // we can decide if this sync was a promotion or demotion (for
    // the post-sync DM) and whether the TIER changed (Bronze → Silver
    // — DM) vs just sub-tier changed within same tier (Bronze II →
    // Bronze III — silent, no DM, just role swap).
    let oldRoleName = null;
    for (const r of member.roles.cache.values()) {
      if (allRoleNames.has(r.name)) { oldRoleName = r.name; break; }
    }
    const oldTierKey = oldRoleName ? _tierKeyFromRoleName(oldRoleName) : null;

    // Strip any rank-tier role the member is carrying that isn't the
    // target. Robust to a member somehow ending up with multiple
    // sub-tier roles at once.
    for (const r of [...member.roles.cache.values()]) {
      if (allRoleNames.has(r.name) && r.id !== targetRole?.id) {
        await member.roles.remove(r.id).catch(err => {
          console.warn(`[RankSync] Could not remove role '${r.name}' from ${user.discord_id}: ${err.message}`);
        });
      }
    }

    // Grant the target role if it exists on the guild and isn't held.
    let roleGranted = false;
    if (targetRole) {
      if (!member.roles.cache.has(targetRole.id)) {
        await member.roles.add(targetRole.id).then(() => { roleGranted = true; }).catch(err => {
          console.warn(`[RankSync] Could not add role '${targetRole.name}' to ${user.discord_id}: ${err.message}`);
        });
      }
    } else {
      console.log(`[RankSync] No Discord role named '${target.roleName}' on the guild — skipping grant for ${user.discord_id}. Operator needs to create the role with that exact name.`);
    }

    // DM the user only on TIER promotion/demotion (Bronze → Silver),
    // not on sub-tier movement within the same tier (Bronze II →
    // Bronze III). Avoids DMing 3x more often than before. First-time
    // role grant (oldTierKey == null) skipped — onboarding handles
    // welcoming.
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
 * Reverse-map a sub-tier role name (e.g. 'Bronze II', 'Obsidian',
 * 'Top 10') back to its RANK_TIERS key. Used to detect tier changes
 * for DM logic. Handles flat tiers (Obsidian, Top 10) that have no
 * roman-numeral suffix.
 */
function _tierKeyFromRoleName(roleName) {
  if (roleName === 'Top 10') return 'crowned';
  if (roleName === 'Obsidian') return 'obsidian';
  // Strip the trailing roman numeral.
  const base = roleName.replace(/\s+(I{1,3})$/, '').toLowerCase();
  const tier = RANK_TIERS.find(t => t.key === base);
  return tier ? tier.key : null;
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
