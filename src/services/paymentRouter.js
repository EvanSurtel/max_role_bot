// Payment provider router.
//
// Given a user's country + amount, returns the ordered list of provider
// options we should show on the deposit / withdraw panel. This is the
// single source of truth for:
//
//   - Which provider is primary vs. fallback per country
//   - When CDP is available (US-only until full-access approval lands,
//     and only while the trial counter hasn't hit the cap)
//   - What fee / KYC summary to show the user
//
// Panels call getOnrampOptions() / getOfframpOptions() and render one
// button per returned option. Each option carries the providerCode that
// deposit.js / cashOut.js hand to the respective service (coinbaseOnramp,
// changelly+preferredProviderCode, or bitrefill).
//
// Day 1 routing per the product plan:
//
//   On-ramp
//     US         → CDP guest (0% fee, Apple Pay / card) primary,
//                   Wert fallback if CDP trial exhausted
//     UK         → Transak primary (Wert doesn't cover UK)
//     EU/CA/AU   → Wert primary (LKYC up to $1k), Transak secondary
//     elsewhere  → Wert primary, Transak secondary
//
//   Off-ramp
//     All        → Transak primary (Changelly),
//                   Bitrefill always shown as no-KYC gift-card route
//     CDP Offramp is feature-flagged off until Coinbase approves it.

const cdpTrial = require('./cdpTrialService');

// Countries where CDP Onramp guest checkout is actually live. Per
// Rishabh Jain (CDP team) on 2026-04-21, this is US-only today despite
// the public FAQ claiming US/UK/CA. Update this set when they expand.
const CDP_GUEST_ONRAMP_COUNTRIES = new Set(['US']);

// Wert's coverage map — everywhere EXCEPT UK per their docs.
const WERT_UNSUPPORTED = new Set(['GB']);

// Transak is global (including UK). We still gate on Changelly having
// an offer for the country + amount at order time.

/**
 * @typedef {Object} ProviderOption
 * @property {'cdp_onramp'|'wert'|'transak'|'bitrefill'|'cdp_offramp'} provider
 * @property {string} label                - Button label shown to user
 * @property {string} description          - Short fee / KYC summary
 * @property {number} feePctEstimate       - 0–1 decimal (e.g. 0.04 for 4%)
 * @property {'none'|'lkyc'|'full'|'coinbase_account'} kycRequired
 * @property {boolean} primary             - Whether to highlight this option
 */

/**
 * What on-ramp providers should we show this user, in order?
 * @param {Object} args
 * @param {string} args.country - ISO 3166-1 alpha-2 (US, CA, GB, DE, ...)
 * @param {number} args.amountUsd
 * @returns {ProviderOption[]}
 */
function getOnrampOptions({ country, amountUsd }) {
  const c = (country || '').toUpperCase();
  const options = [];

  // CDP guest checkout — only where Coinbase actually routes to guest
  // flow today (US on 2026-04-21), and only while the trial counter
  // has room left.
  if (CDP_GUEST_ONRAMP_COUNTRIES.has(c) && cdpTrial.canUseOnramp()) {
    options.push({
      provider: 'cdp_onramp',
      label: 'Apple Pay / Debit Card',
      description: process.env.CDP_ZERO_FEE_USDC === 'true'
        ? 'Fastest option. 0% fee. No Coinbase account needed. Powered by Coinbase.'
        : 'Fastest option. ~2.5% fee. No Coinbase account needed. Powered by Coinbase.',
      feePctEstimate: process.env.CDP_ZERO_FEE_USDC === 'true' ? 0 : 0.025,
      kycRequired: 'none',
      primary: true,
    });
  }

  // Wert — card payments with LKYC (typed-only up to $1,000 lifetime).
  // Available everywhere EXCEPT UK.
  if (!WERT_UNSUPPORTED.has(c)) {
    options.push({
      provider: 'wert',
      label: 'Pay with Card (Wert)',
      description: 'No ID upload needed under $1,000 lifetime. 4% + $1 fee. Powered by Wert.',
      feePctEstimate: 0.04,
      kycRequired: 'lkyc',
      primary: options.length === 0,  // primary if CDP didn't claim it
    });
  }

  // Transak — global card / bank with full document KYC. Primary in UK
  // (where Wert is unavailable), secondary elsewhere.
  options.push({
    provider: 'transak',
    label: c === 'GB' ? 'Pay with Card (Transak)' : 'Pay with Card (Transak — ID required, lower fees)',
    description: c === 'GB'
      ? 'ID verification required. 3.29% + $0.99 card fee, 0.49% + £1 Faster Payments.'
      : 'ID verification required, cheaper than Wert. 3.29% + $0.99 card fee.',
    feePctEstimate: 0.0329,
    kycRequired: 'full',
    primary: options.length === 0,  // primary if neither CDP nor Wert claimed it
  });

  return options;
}

/**
 * What off-ramp providers should we show this user, in order?
 * @param {Object} args
 * @param {string} args.country - ISO 3166-1 alpha-2
 * @param {number} args.amountUsdc - Amount of USDC being cashed out
 * @returns {ProviderOption[]}
 */
function getOfframpOptions({ country, amountUsdc }) {
  const options = [];

  // CDP offramp — gated behind approval flag. Disabled on Day 1 to
  // preserve trial counter for Onramp US deposits.
  if (cdpTrial.canUseOfframp()) {
    options.push({
      provider: 'cdp_offramp',
      label: 'Cash out to bank (Coinbase)',
      description: process.env.CDP_ZERO_FEE_USDC === 'true'
        ? '0% fee on USDC Base. Requires a Coinbase account with a linked bank.'
        : '~0.5% fee. Requires a Coinbase account with a linked bank.',
      feePctEstimate: process.env.CDP_ZERO_FEE_USDC === 'true' ? 0 : 0.005,
      kycRequired: 'coinbase_account',
      primary: true,
    });
  }

  // Transak via Changelly — primary cash-to-bank route for most users
  // on Day 1. Fees vary by local rail (SEPA / Faster Payments / ACH).
  options.push({
    provider: 'transak',
    label: 'Cash out to bank (Transak)',
    description: 'ID verification required once. ~1–2% fee depending on local payout rail.',
    feePctEstimate: 0.015,
    kycRequired: 'full',
    primary: options.length === 0,
  });

  // Bitrefill — always available, no KYC up to ~$500 per guest order.
  // Not bank cash-out; spends USDC directly on gift cards for mainstream
  // retailers (Amazon, Steam, Apple, Uber, ~1,000 brands). Global.
  options.push({
    provider: 'bitrefill',
    label: 'Spend on Gift Cards (no ID)',
    description: 'Amazon, Steam, Apple, Uber, and 1,000+ brands. 0–3% effective fee.',
    feePctEstimate: 0.015,
    kycRequired: 'none',
    primary: false,
  });

  return options;
}

module.exports = { getOnrampOptions, getOfframpOptions };
