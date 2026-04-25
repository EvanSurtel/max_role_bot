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
//     non-US     → Wert primary (LKYC up to $1k, typed-only), Transak
//                   secondary (full ID required). UK is included in
//                   this default now — prior code special-cased UK to
//                   Transak-only based on outdated Wert coverage docs;
//                   Wert does route UK through their LKYC flow today.
//
//   Off-ramp
//     All        → Transak primary (Changelly),
//                   Bitrefill always shown as no-KYC gift-card route
//     CDP Offramp is feature-flagged off until Coinbase approves it.

const cdpTrial = require('./cdpTrialService');
const wertKyc = require('../database/repositories/wertKycRepo');

// SIMPLIFIED ONRAMP ROUTING (post Coinbase approval, 2026-04-24)
//
// Each user gets ONE deposit option, picked by their country. No more
// "pick between Wert / Transak / Coinbase" confusion — just one button
// labelled with the actual payment methods.
//
//   US  → Coinbase Onramp GUEST checkout (no Coinbase account, no KYC)
//         Methods: Apple Pay, Google Pay, debit card
//         (Per Coinbase docs: no credit cards on US guest checkout.)
//
//   GB  → Coinbase Onramp ACCOUNT-based (sign into Coinbase, KYC)
//         Methods: Apple Pay, Google Pay, debit/credit card, PayPal,
//         Faster Payments. UK can't use Wert (Changelly /offers
//         doesn't quote Wert for GB) and Transak requires KYC anyway,
//         so Coinbase is the cleanest path.
//
//   *   → Wert via Changelly. Methods: card, Apple Pay, Google Pay.
//         No ID under $1,000 lifetime; ID over that. (Pending Changelly
//         enabling Wert on our partner account — until then, /offers
//         won't return Wert and the user gets a clear "not available"
//         error. Email out to Changelly support 2026-04-24.)
const COINBASE_GUEST_COUNTRIES = new Set(['US']);
const COINBASE_ACCOUNT_COUNTRIES = new Set(['GB']);

// Transak is global. We still gate on Changelly having an offer for
// the country + amount at order time.

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
 * @param {number} [args.userId] - Internal user id; if provided, the
 *                                  Wert option's label/description
 *                                  reflect the user's lifetime LKYC cap.
 * @returns {ProviderOption[]}
 */
function getOnrampOptions({ country, amountUsd, userId }) {
  const c = (country || '').toUpperCase();
  const options = [];

  // US — single option. Coinbase Onramp GUEST checkout: no account,
  // no KYC, no fees, supported methods are Apple Pay, Google Pay,
  // debit card (per Coinbase guest-checkout policy — credit cards are
  // not eligible for US guest checkout).
  if (COINBASE_GUEST_COUNTRIES.has(c)) {
    options.push({
      provider: 'cdp_onramp',
      label: 'Deposit with Apple Pay, Google Pay, or Debit Card',
      description: 'Guest checkout. Funds arrive in your wallet in a few minutes.',
      feePctEstimate: 0,
      kycRequired: 'none',
      primary: true,
    });
    return options;
  }

  // UK — single option. Coinbase Onramp account-based (Wert isn't
  // available for GB via Changelly; Transak would also require KYC).
  // Per Coinbase docs: UK methods include Apple Pay, Google Pay,
  // debit/credit card, PayPal, Faster Payments.
  if (COINBASE_ACCOUNT_COUNTRIES.has(c)) {
    options.push({
      provider: 'cdp_onramp',
      label: 'Deposit with Apple Pay, Google Pay, Card, or PayPal',
      description: 'No fees. Sign in to a free Coinbase account and verify your identity once (you\'ll need this same account to cash out to your bank later anyway).',
      feePctEstimate: 0,
      kycRequired: 'coinbase_account',
      primary: true,
    });
    return options;
  }

  // Everywhere else — TWO options:
  //   PRIMARY (green button): Wert via Changelly. Quick, no account,
  //                           4% + $1 fee. No ID under $1,000 lifetime.
  //                           Most users will pick this — they're
  //                           lazy and don't want KYC.
  //   SECONDARY (gray button): Coinbase Onramp account-based. No fees
  //                            but requires Coinbase account + ID.
  //                            Same KYC the user will need anyway to
  //                            cash out to bank, so doing it now is
  //                            a one-time setup that saves the fee.
  // GUEST CHECKOUT (Wert) — currently disabled while we wait for
  // Changelly to enable Wert on our partner account (email out
  // 2026-04-24). Until that comes back, we hide the Wert option
  // entirely and surface only the Coinbase account-based path. We
  // tell the user explicitly that the no-account guest checkout is
  // coming soon, so they know there's a faster path on the way and
  // don't think we're forcing them through KYC permanently.
  //
  // To re-enable once Changelly turns Wert on:
  //   1. Confirm via the GET /v1/offers probe that Wert is in the
  //      response for our account.
  //   2. Restore the wert push block (preserved in git history).
  //   3. Drop the "coming soon" line from the Coinbase description
  //      below.
  const wertComingSoon = true;

  const wertBlocked = userId != null && wertKyc.isOverCap(userId);
  if (!wertComingSoon && !wertBlocked) {
    // Wert fee structure: max($1, 4%). Below $25, $1 flat. Above $25,
    // 4%. Spelled out explicitly — "4% above" was too vague.
    let wertDesc = 'Guest checkout. $1 fee on deposits up to $25, 4% fee on deposits above $25.';
    if (userId != null) {
      const remaining = wertKyc.getRemainingCap(userId);
      if (wertKyc.shouldWarn(userId)) {
        wertDesc = `Guest checkout. $1 fee on deposits up to $25, 4% fee on deposits above $25. About $${remaining.toFixed(0)} left before ID is required.`;
      }
      if (amountUsd != null && remaining > 0 && amountUsd > remaining) {
        wertDesc = `Guest checkout. **Heads up:** this deposit would push you past your $${remaining.toFixed(0)} no-ID limit — ID may be required. $1 fee on deposits up to $25, 4% fee above $25.`;
      }
    }
    options.push({
      provider: 'wert',
      label: 'Deposit with Card, Apple Pay, or Google Pay — small fee',
      description: wertDesc,
      feePctEstimate: 0.04,
      kycRequired: 'lkyc',
      primary: true,
    });
  }

  // Coinbase account-based option for non-US/UK regions. While Wert is
  // "coming soon" this is the ONLY option we surface; once Wert is
  // enabled this becomes the secondary "save the fee" path.
  options.push({
    provider: 'cdp_onramp',
    label: 'Deposit with Card, Apple Pay, or Google Pay — no fees (sign in and ID required)',
    description: wertComingSoon
      ? 'Sign in to a free Coinbase account and verify your identity once (you\'ll need this same account to cash out to your bank later anyway).\n\n_Guest checkout with no account is coming soon._'
      : 'Sign in to a free Coinbase account and verify your identity once (you\'ll need this same account to cash out to your bank later anyway).',
    feePctEstimate: 0,
    kycRequired: 'coinbase_account',
    primary: true, // primary while Wert is unavailable
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

  // SIMPLIFIED OFFRAMP ROUTING (post-Coinbase-approval, 2026-04-24)
  //
  // Every cash-out route requires KYC anyway (bank/card/PayPal payouts
  // are KYC-gated by every operator in the space). Coinbase is the
  // most-trusted name in the space and works globally where Coinbase
  // operates. So we route everyone here for the primary cash-out, plus
  // offer Bitrefill as the no-KYC gift-card alternative for users who
  // don't want to link a bank account.
  //
  // No more Transak / Changelly cash-out — that path required the same
  // KYC and added another vendor + fee tier to explain to users.

  // Coinbase Offramp — sign in to Coinbase, cash out to bank, card, or
  // PayPal. Globally available wherever Coinbase operates.
  options.push({
    provider: 'cdp_offramp',
    label: 'Cash out to Bank, Card, or PayPal',
    description: 'Sign in to your Coinbase account (free to create — ID verification required) to cash out USDC to your bank, card, or PayPal. Funds arrive in minutes.',
    feePctEstimate: process.env.CDP_ZERO_FEE_USDC === 'true' ? 0 : 0.005,
    kycRequired: 'coinbase_account',
    primary: true,
  });

  // Bitrefill — spend USDC directly on gift cards. No ID needed up to
  // ~$500 per guest order. For users who want to skip the bank/KYC
  // step entirely.
  options.push({
    provider: 'bitrefill',
    label: 'Spend on Gift Cards (no ID)',
    description: 'Amazon, Steam, Apple, Uber, 1,000+ brands. No ID needed for guest orders up to ~$500. Effective fee 0–3% depending on brand — the gift-card markup is Bitrefill\'s, not Rank $.',
    feePctEstimate: 0.015,
    kycRequired: 'none',
    primary: false,
  });

  return options;
}

module.exports = { getOnrampOptions, getOfframpOptions };
