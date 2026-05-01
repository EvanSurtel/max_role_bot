// Sub-tier (I / II / III) computation.
//
// Tiers Bronze through Sentinel are divided into 3 equal sub-tiers
// within their XP band. Obsidian and Top 10 are SINGLE tiers — no
// sub-ranks. Top 10 is position-based; Obsidian is a flat threshold
// reached at 4500 XP and held until the user enters the Top 10.
//
// Discord role naming convention (operator creates these manually):
//
//   Bronze I, Bronze II, Bronze III,
//   Silver I, Silver II, Silver III,
//   Gold I, Gold II, Gold III,
//   Platinum I, Platinum II, Platinum III,
//   Diamond I, Diamond II, Diamond III,
//   Sentinel I, Sentinel II, Sentinel III,
//   Obsidian,
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
// Tiers that are NOT split into I/II/III sub-ranks. Each is a single
// ceiling tier with one Discord role name (no roman numeral suffix).
const FLAT_TIER_KEYS = new Set(['obsidian', 'crowned']);

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

  // Obsidian: flat tier, no sub-rank. Anyone past 4500 XP who isn't
  // in the Top 10 is just "Obsidian".
  if (FLAT_TIER_KEYS.has(tier.key)) {
    return {
      tierKey: tier.key,
      subTier: null,
      roleName: ENGLISH_TIER_NAMES[tier.key],
      englishName: ENGLISH_TIER_NAMES[tier.key],
    };
  }

  // Numeric tiers (Bronze through Sentinel): split the 750-XP band
  // into 3 equal 250-XP sub-tiers.
  const tierIdx = RANK_TIERS.indexOf(tier);
  const next = RANK_TIERS[tierIdx + 1];
  const bandWidth = next && typeof next.minXp === 'number' && next.minXp < 999999
    ? next.minXp - tier.minXp
    : 750;
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
  const localizedBase = langTRanks?.[subTierResult.tierKey]?.name
    || ENGLISH_TIER_NAMES[subTierResult.tierKey]
    || subTierResult.tierKey;
  // Flat tiers (Obsidian, Top 10) don't have a roman-numeral suffix.
  if (subTierResult.subTier == null) return localizedBase;
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
    const base = ENGLISH_TIER_NAMES[tier.key] || tier.key;
    if (tier.topN || FLAT_TIER_KEYS.has(tier.key)) {
      names.push(base);
      continue;
    }
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
