// CDP trial-mode transaction counter.
//
// Coinbase puts every new Onramp project in trial mode: a ~25-transaction
// total cap (shared across Onramp + Offramp). Once the trial fills, any
// further session-token request from our backend fails on their side.
//
// We increment the counter in the Coinbase webhook handler on
// `ONRAMP_ORDER_STATUS_COMPLETED` and check it BEFORE handing a user a
// CDP URL. If the counter has hit the cap, the payment router falls back
// to Wert-via-Changelly automatically — the user never sees a broken CDP
// link.
//
// When our full-access approval lands, flip CDP_TRIAL_MAX_TRANSACTIONS in
// .env to a very high number (or unset the feature flag entirely) —
// no code changes needed.

const db = require('../database/db');

function _getCounter() {
  try {
    const row = db.prepare("SELECT value FROM bot_settings WHERE key = 'cdp_trial_counter'").get();
    return row ? parseInt(row.value, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function _setCounter(value) {
  try {
    db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('cdp_trial_counter', ?)").run(String(value));
  } catch {
    // bot_settings didn't exist yet — create and retry
    db.prepare('CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)').run();
    db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('cdp_trial_counter', ?)").run(String(value));
  }
}

/**
 * Atomic increment — a single SQL statement so two concurrent webhooks
 * can't both read the same base value and each add 1 (losing an
 * increment). Returns the new count.
 */
function _incrementAtomic() {
  try {
    db.prepare(`
      INSERT INTO bot_settings (key, value) VALUES ('cdp_trial_counter', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
    `).run();
  } catch {
    // Fall back for older SQLite (<3.24 — unlikely but defensive)
    db.prepare('CREATE TABLE IF NOT EXISTS bot_settings (key TEXT PRIMARY KEY, value TEXT)').run();
    const before = _getCounter();
    _setCounter(before + 1);
  }
  return _getCounter();
}

function getMax() {
  return parseInt(process.env.CDP_TRIAL_MAX_TRANSACTIONS || '25', 10);
}

/**
 * Per-transaction USD cap in trial mode. Coinbase limits trial
 * projects to $5 per tx × 25 total. When full access is granted, bump
 * CDP_TRIAL_MAX_AMOUNT_USD to a high value (or remove to use default).
 */
function getMaxPerTxUsd() {
  return parseFloat(process.env.CDP_TRIAL_MAX_AMOUNT_USD || '5') || 5;
}

/**
 * Can we mint another CDP Onramp session right now?
 * False if the onramp feature flag is off, or the trial counter has
 * reached the configured max.
 */
function canUseOnramp() {
  if (process.env.CDP_ONRAMP_ENABLED !== 'true') return false;
  return _getCounter() < getMax();
}

/**
 * Can we use CDP for Offramp? Currently gated behind a separate flag
 * (Coinbase hasn't approved us for Offramp yet, and enabling it before
 * approval would burn the shared trial counter on cash-outs instead of
 * deposits).
 */
function canUseOfframp() {
  if (process.env.CDP_OFFRAMP_ENABLED !== 'true') return false;
  return _getCounter() < getMax();
}

/**
 * Increment the trial counter. Call this from the Coinbase webhook on
 * order-completed. Atomic at the SQL layer so concurrent webhooks can't
 * race. Returns the new count.
 */
function incrementTrialCounter() {
  const next = _incrementAtomic();
  if (next >= getMax()) {
    console.warn(`[CDP] Trial counter hit max (${next}/${getMax()}). All further traffic falls back to Wert.`);
  }
  return next;
}

/**
 * Force-exhaust the counter by setting it to max. Use when Coinbase's
 * API returns an error that indicates the trial cap was hit early
 * (undocumented shared limits, 403/429, "tier exceeded" messages) —
 * stops further CDP attempts for this project until counter is reset.
 */
function forceExhaust() {
  _setCounter(getMax());
  console.error('[CDP] Trial force-exhausted (API error indicated cap hit). Routing all traffic to Wert until reset.');
}

/**
 * Admin reset — zero the counter. Run via scripts/reset-cdp-trial.js
 * after Coinbase approves the full-access upgrade.
 */
function reset() {
  _setCounter(0);
  console.log('[CDP] Trial counter reset to 0.');
}

function getStatus() {
  const count = _getCounter();
  const max = getMax();
  return {
    count,
    max,
    remaining: Math.max(0, max - count),
    exhausted: count >= max,
    maxPerTxUsd: getMaxPerTxUsd(),
    onrampEnabled: process.env.CDP_ONRAMP_ENABLED === 'true',
    offrampEnabled: process.env.CDP_OFFRAMP_ENABLED === 'true',
  };
}

module.exports = {
  canUseOnramp,
  canUseOfframp,
  incrementTrialCounter,
  forceExhaust,
  reset,
  getStatus,
  getMax,
  getMaxPerTxUsd,
};
