// Per-user Wert lifetime deposit total (USD).
//
// Wert's LKYC flow is capped at $1,000 lifetime per user — past that
// point Wert itself forces full document KYC. We track the cumulative
// here so the deposit panel can (a) warn the user as they approach the
// cap, and (b) suppress Wert and prefer Transak once they're over it
// (the UX ends up the same — Transak does full KYC once — but the
// user isn't ambushed by a Wert KYC screen mid-flow).

const db = require('../db');

const LKYC_CAP_USD = 1000;
const WARNING_THRESHOLD_USD = 800; // warn when user is 80% of the way

function getLifetimeUsd(userId) {
  try {
    const row = db.prepare('SELECT wert_lifetime_usd FROM users WHERE id = ?').get(userId);
    return parseFloat(row?.wert_lifetime_usd || '0') || 0;
  } catch {
    return 0;
  }
}

/**
 * Add an amount (USD) to the user's Wert lifetime total. Idempotency
 * is the caller's responsibility — this is meant to be invoked from
 * the Changelly webhook handler after the payment_events dedupe check.
 */
function addLifetime(userId, amountUsd) {
  const current = getLifetimeUsd(userId);
  const next = current + (parseFloat(amountUsd) || 0);
  db.prepare('UPDATE users SET wert_lifetime_usd = ? WHERE id = ?').run(String(next), userId);
  return next;
}

function getRemainingCap(userId) {
  return Math.max(0, LKYC_CAP_USD - getLifetimeUsd(userId));
}

function isOverCap(userId) {
  return getLifetimeUsd(userId) >= LKYC_CAP_USD;
}

function shouldWarn(userId) {
  const total = getLifetimeUsd(userId);
  return total >= WARNING_THRESHOLD_USD && total < LKYC_CAP_USD;
}

module.exports = {
  getLifetimeUsd,
  addLifetime,
  getRemainingCap,
  isOverCap,
  shouldWarn,
  LKYC_CAP_USD,
  WARNING_THRESHOLD_USD,
};
