const { XP_MATCH, XP_WAGER, USDC_PER_UNIT } = require('../config/constants');

/**
 * Calculate XP for an XP match based on ELO-style team average difference.
 *
 * @param {number} winnerAvgXp - Winning team's average XP
 * @param {number} loserAvgXp - Losing team's average XP
 * @returns {{ winXp: number, loseXp: number }}
 */
function calculateXpMatchRewards(winnerAvgXp, loserAvgXp) {
  const xpDiff = winnerAvgXp - loserAvgXp;
  // Positive = favorite won, Negative = underdog won
  const clampedDiff = Math.max(-XP_MATCH.ELO_CAP, Math.min(XP_MATCH.ELO_CAP, xpDiff));
  // ratio: -1 (full underdog win) to +1 (full favorite win), 0 = even
  const ratio = clampedDiff / XP_MATCH.ELO_CAP;

  let winXp, loseXp;

  if (ratio >= 0) {
    // Favorite won — less reward, less penalty
    winXp = Math.round(XP_MATCH.BASE_WIN - ratio * (XP_MATCH.BASE_WIN - XP_MATCH.MIN_WIN));
    loseXp = Math.round(XP_MATCH.BASE_LOSS - ratio * (XP_MATCH.BASE_LOSS - XP_MATCH.MIN_LOSS));
  } else {
    // Underdog won — more reward, more penalty
    const absRatio = Math.abs(ratio);
    winXp = Math.round(XP_MATCH.BASE_WIN + absRatio * (XP_MATCH.MAX_WIN - XP_MATCH.BASE_WIN));
    loseXp = Math.round(XP_MATCH.BASE_LOSS + absRatio * (XP_MATCH.MAX_LOSS - XP_MATCH.BASE_LOSS));
  }

  return { winXp, loseXp };
}

/**
 * Calculate XP for a wager match based on wager amount.
 * Linear scale from MIN_WAGER ($0.50) → MIN_XP (100) to MAX_WAGER ($100) → MAX_XP (1000).
 *
 * @param {string|number} entryAmountUsdc - Entry amount in USDC smallest units
 * @returns {{ winXp: number, loseXp: number }}
 */
function calculateWagerXpRewards(entryAmountUsdc) {
  const entryUsd = Number(entryAmountUsdc) / USDC_PER_UNIT;
  const clamped = Math.max(XP_WAGER.MIN_WAGER, Math.min(XP_WAGER.MAX_WAGER, entryUsd));

  const ratio = (clamped - XP_WAGER.MIN_WAGER) / (XP_WAGER.MAX_WAGER - XP_WAGER.MIN_WAGER);
  const winXp = Math.round(XP_WAGER.MIN_XP + ratio * (XP_WAGER.MAX_XP - XP_WAGER.MIN_XP));

  return { winXp, loseXp: XP_WAGER.LOSS_XP };
}

module.exports = { calculateXpMatchRewards, calculateWagerXpRewards };
