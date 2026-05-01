// Sub-tier (I / II / III) computation.
//
// Each numeric XP tier (Bronze .. Obsidian) is divided into 3 equal
// sub-tiers within its XP band. Top 10 (position-based) is NOT split
// — it's a single ceiling tier above Obsidian III.
//
// Discord role naming convention (operator creates these manually):
//
//   Bronze I, Bronze II, Bronze III,
//   Silver I, Silver II, Silver III,
//   Gold I, Gold II, Gold III,
//   Platinum I, Platinum II, Platinum III,
//   Diamond I, Diamond II, Diamond III,
//   Sentinel I, Sentinel II, Sentinel III,
//   Obsidian I, Obsidian II, Obsidian III,
//   Top 10
//
// rankRoleSync.js looks the role up by name on the guild, so role
// IDs don't need to live in env vars.

const { RANK_TIERS } = require('../config/constants');

const ROMAN = ['I', 'II', 'III'];

// English tier names used to construct the Discord role name. The
// per-locale display name (e.g. Spanish "Bronce") is for UI text but
// the ROLE NAME is always English to match what the operator typed
// in Server Settings.
const ENGLISH_TIER_NAMES = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  platinum: 'Platinum',
  diamond: 'Diamond',
  sentinel: 'Sentinel',
  obsidian: 'Obsidian',
  crowned: 'Top 10',
};

/**
 * Walk RANK_TIERS in order to find the highest numeric tier whose
 * minXp the user has crossed. Mirrors _tierForXp in rankRoleSync.js
 * but exposed for shared use.
 */
function _baseTierForXp(xp) {
  let match = RANK_TIERS[0];
  for (const tier of RANK_TIERS) {
    if (tier.topN) continue;
    if (typeof tier.minXp === 'number' && tier.minXp <= xp) match = tier;
  }
  return match;
}

/**
 * Compute the sub-tier for a given XP + Top-10 status.
 *
 * @param {number} xp
 * @param {boolean} isInTopN  true if the user is in the top-N
 *   leaderboard at or above the Obsidian threshold (caller resolves
 *   this against the live DB)
 * @returns {{
 *   tierKey: string,         // e.g. 'bronze'
 *   subTier: 1|2|3|null,     // null only for Top 10
 *   roleName: string,        // exact Discord role name to look up
 *   englishName: string,     // 'Bronze II' / 'Top 10' — used for DMs and admin logs
 * }}
 */
function computeSubTier(xp, isInTopN = false) {
  if (isInTopN) {
    return {
      tierKey: 'crowned',
      subTier: null,
      roleName: ENGLISH_TIER_NAMES.crowned,
      englishName: ENGLISH_TIER_NAMES.crowned,
    };
  }

  const tier = _baseTierForXp(xp);
  const tierIdx = RANK_TIERS.indexOf(tier);
  const next = RANK_TIERS[tierIdx + 1];

  // Width of this tier's XP band. For tiers below Obsidian, that's
  // (next.minXp - tier.minXp). For Obsidian (the last numeric tier
  // before Top 10), use the same band width as the previous tier so
  // sub-divisions stay consistent — Obsidian I is 4500-4749, II is
  // 4750-4999, III is 5000+ (no upper bound).
  let bandWidth;
  if (next && typeof next.minXp === 'number' && next.minXp < 999999) {
    bandWidth = next.minXp - tier.minXp;
  } else {
    // Obsidian or whatever final numeric tier exists: borrow the
    // previous tier's band width.
    const prev = RANK_TIERS[tierIdx - 1];
    bandWidth = prev ? (tier.minXp - prev.minXp) : 750;
  }
  const subWidth = bandWidth / 3;

  let subTier;
  const xpInTier = xp - tier.minXp;
  if (xpInTier < subWidth) subTier = 1;
  else if (xpInTier < subWidth * 2) subTier = 2;
  else subTier = 3;

  const baseName = ENGLISH_TIER_NAMES[tier.key] || tier.key;
  const roman = ROMAN[subTier - 1];
  return {
    tierKey: tier.key,
    subTier,
    roleName: `${baseName} ${roman}`,
    englishName: `${baseName} ${roman}`,
  };
}

/**
 * Format the sub-tier name in the user's locale. Falls back to the
 * English name if the locale doesn't have a translated tier name.
 */
function formatSubTierLocalized(subTierResult, langTRanks) {
  if (subTierResult.tierKey === 'crowned') {
    const name = langTRanks?.crowned?.name || 'Top 10';
    return name;
  }
  const localizedBase = langTRanks?.[subTierResult.tierKey]?.name
    || ENGLISH_TIER_NAMES[subTierResult.tierKey]
    || subTierResult.tierKey;
  const roman = ROMAN[subTierResult.subTier - 1];
  return `${localizedBase} ${roman}`;
}

/**
 * Every possible sub-tier role name in tier order — used by
 * rankRoleSync.js to strip a member's stale sub-tier roles when
 * promoting / demoting. Top 10 is the only single-name entry.
 */
function allSubTierRoleNames() {
  const names = [];
  for (const tier of RANK_TIERS) {
    if (tier.topN) {
      names.push(ENGLISH_TIER_NAMES.crowned);
      continue;
    }
    const base = ENGLISH_TIER_NAMES[tier.key] || tier.key;
    for (const r of ROMAN) names.push(`${base} ${r}`);
  }
  return names;
}

module.exports = {
  computeSubTier,
  formatSubTierLocalized,
  allSubTierRoleNames,
  ENGLISH_TIER_NAMES,
};
