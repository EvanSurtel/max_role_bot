// Sub-tier (I / II / III) computation.
//
// Tiers Bronze through Sentinel are divided into 3 equal sub-tiers
// within their XP band. Obsidian and Top 10 are SINGLE tiers — no
// sub-ranks. Top 10 is position-based; Obsidian is a flat threshold
// reached at 4500 XP and held until the user enters the Top 10.
//
// Discord role IDs come from env vars. Operator sets these in .env:
//
//   BRONZE_I_ROLE_ID, BRONZE_II_ROLE_ID, BRONZE_III_ROLE_ID,
//   SILVER_I_ROLE_ID, SILVER_II_ROLE_ID, SILVER_III_ROLE_ID,
//   GOLD_I_ROLE_ID, GOLD_II_ROLE_ID, GOLD_III_ROLE_ID,
//   PLATINUM_I_ROLE_ID, PLATINUM_II_ROLE_ID, PLATINUM_III_ROLE_ID,
//   DIAMOND_I_ROLE_ID, DIAMOND_II_ROLE_ID, DIAMOND_III_ROLE_ID,
//   SENTINEL_I_ROLE_ID, SENTINEL_II_ROLE_ID, SENTINEL_III_ROLE_ID,
//   OBSIDIAN_ROLE_ID,
//   TOP_10_ROLE_ID
//
// Missing env vars are silently skipped (the tier just won't have a
// role assigned for users in that band).

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

/**
 * Build the env var name that holds the Discord role ID for a given
 * tier + sub-tier combo. Matches the operator's `.env` naming:
 *   BRONZE_I_ROLE_ID, OBSIDIAN_ROLE_ID, TOP_10_ROLE_ID, etc.
 */
function envVarFor(tierKey, subTier) {
  if (tierKey === 'crowned') return 'TOP_10_ROLE_ID';
  const base = tierKey.toUpperCase();
  if (subTier == null) return `${base}_ROLE_ID`; // Obsidian
  const roman = ROMAN[subTier - 1];
  return `${base}_${roman}_ROLE_ID`;
}

function computeSubTier(xp, isInTopN = false) {
  if (isInTopN) {
    return {
      tierKey: 'crowned',
      subTier: null,
      roleName: ENGLISH_TIER_NAMES.crowned,
      englishName: ENGLISH_TIER_NAMES.crowned,
      envVar: envVarFor('crowned', null),
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
      envVar: envVarFor(tier.key, null),
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
    envVar: envVarFor(tier.key, subTier),
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

/**
 * Every env var name (across all tiers + sub-tiers) that the operator
 * might have configured. Used by rankRoleSync to enumerate stale role
 * IDs to strip from a member when their sub-tier changes.
 */
function allSubTierEnvVarNames() {
  const vars = [];
  for (const tier of RANK_TIERS) {
    if (tier.topN || FLAT_TIER_KEYS.has(tier.key)) {
      vars.push(envVarFor(tier.key, null));
      continue;
    }
    for (let i = 1; i <= 3; i++) vars.push(envVarFor(tier.key, i));
  }
  return vars;
}

/**
 * Resolve a sub-tier result to a Discord role ID via the env var.
 * Returns null if the env var isn't set.
 */
function roleIdForSubTier(subTierResult) {
  return process.env[subTierResult.envVar] || null;
}

module.exports = {
  computeSubTier,
  formatSubTierLocalized,
  allSubTierRoleNames,
  allSubTierEnvVarNames,
  roleIdForSubTier,
  envVarFor,
  ENGLISH_TIER_NAMES,
};
