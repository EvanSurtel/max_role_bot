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

// Countries where we surface CDP Onramp / Offramp in the real wallet
// channel. Per Rishabh Jain (CDP team) on 2026-04-21, CDP guest
// checkout is US-only today despite the public FAQ claiming US/UK/CA.
// We keep CA in these sets anyway for the operator's own demo
// recording (CA-based) — Coinbase's widget will either route the CA
// session via the public-FAQ path or surface a region error; either
// way the buttons are visible for the video. Drop CA back out of
// these sets once the trial upgrade is approved and we want the prod
// router to reflect Rishabh's guidance strictly.
// Demo channel bypasses these gates entirely via the `demo` flag.
const CDP_GUEST_ONRAMP_COUNTRIES = new Set(['US', 'CA']);
const CDP_GUEST_OFFRAMP_COUNTRIES = new Set(['US', 'CA']);

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
 * @param {boolean} [args.demo=false] - If true, include CDP onramp
 *   even when CDP_ONRAMP_ENABLED=false. Callers pass this from the
 *   Coinbase review demo channel so reviewers always see CDP, no
 *   matter what feature flags the operator has set.
 * @returns {ProviderOption[]}
 */
function getOnrampOptions({ country, amountUsd, userId, demo = false }) {
  const c = (country || '').toUpperCase();
  const options = [];

  // CDP guest checkout — only where Coinbase actually routes to guest
  // flow today (US as of 2026-04-21), and only while the trial counter
  // has room left. Trial mode caps each transaction at $5 — if the
  // user requested more, we hide CDP entirely rather than silently
  // clamping.
  //
  // Fee messaging during trial: Coinbase waives their card fee on
  // trial-sized transactions, so we show "no fees" for ≤$5 deposits.
  // Post-approval, CDP_ZERO_FEE_USDC flips the copy to 0% globally.
  //
  // CDP onramp visibility — same pattern as getOfframpOptions:
  //   - Demo channel: always show (credentials must be configured).
  //   - Real wallet channel, country in CDP_GUEST_ONRAMP_COUNTRIES
  //     (US / CA today): show regardless of CDP_ONRAMP_ENABLED flag
  //     and trial-counter state. A CA reviewer / operator recording
  //     the demo video shouldn't need to flip env vars to see the
  //     Coinbase button.
  //   - Other countries: still honor the canUseOnramp() gate which
  //     checks both CDP_ONRAMP_ENABLED and the trial counter.
  const cdpAllowed = demo
    ? (process.env.CDP_API_KEY_ID && process.env.CDP_PROJECT_ID) // credentials present
    : (CDP_GUEST_ONRAMP_COUNTRIES.has(c) || cdpTrial.canUseOnramp());
  if (cdpAllowed) {
    const perTxMax = cdpTrial.getMaxPerTxUsd();
    const fitsInTrialCap = amountUsd == null || amountUsd <= perTxMax;
    if (fitsInTrialCap) {
      // Guest checkout (no Coinbase account required) is US-only per
      // Coinbase. Users in any other country must sign into an
      // existing Coinbase account to complete the purchase. We always
      // highlight "No fees" since trial-mode + the zero-fee USDC
      // promotion waives Coinbase's card fee.
      const isUs = c === 'US';
      options.push({
        provider: 'cdp_onramp',
        label: 'Coinbase Onramp',
        description: isUs
          ? 'No fees. **Guest checkout** — no Coinbase account needed. Pay with Apple Pay, Google Pay, or credit / debit card. Powered by Coinbase.'
          : 'No fees. **Coinbase account required.** Pay with Apple Pay, Google Pay, or credit / debit card linked to your Coinbase account.',
        feePctEstimate: 0,
        kycRequired: isUs ? 'none' : 'coinbase_account',
        primary: true,
      });
    }
  }

  // Wert — card payments with LKYC (typed-only up to $1,000 lifetime).
  // Available globally including UK. Once the user has crossed the cap,
  // we suppress Wert entirely and let Transak take the slot — otherwise
  // the user would hit Wert's own KYC gate mid-flow after clicking our
  // "no ID needed" button.
  {
    const wertBlocked = userId != null && wertKyc.isOverCap(userId);
    if (!wertBlocked) {
      let wertDesc = 'No ID upload needed under $1,000 lifetime. 4% + $1 fee. Powered by Wert.';
      if (userId != null) {
        const remaining = wertKyc.getRemainingCap(userId);
        if (wertKyc.shouldWarn(userId)) {
          wertDesc = `No ID upload needed (you have about $${remaining.toFixed(0)} left before Wert asks for ID). 4% + $1 fee.`;
        }
        if (amountUsd != null && remaining > 0 && amountUsd > remaining) {
          wertDesc = `Heads up: this deposit exceeds your remaining $${remaining.toFixed(0)} Wert no-ID limit — Wert may ask for ID. Consider the Transak option instead.`;
        }
      }
      // Default Wert description includes fee + attribution ("paid to
      // Wert") unless we've already swapped it for a KYC-cap warning.
      if (wertDesc === 'No ID upload needed under $1,000 lifetime. 4% + $1 fee. Powered by Wert.') {
        wertDesc = 'No ID upload needed under $1,000 lifetime. Fee: 4% (min $1) — paid to Wert, not Rank $.';
      }
      options.push({
        provider: 'wert',
        label: 'Pay with Card (Wert)',
        description: wertDesc,
        feePctEstimate: 0.04,
        kycRequired: 'lkyc',
        primary: options.length === 0,
      });
    }
  }

  // Transak — global card / bank with full document KYC. Always shown
  // as the secondary option; becomes the Wert-replacement once the user
  // is over the $1k LKYC cap.
  options.push({
    provider: 'transak',
    label: 'Pay with Card (Transak — ID required)',
    description: 'ID verification required. Fee: 3.29% + $0.99 — paid to Transak, not Rank $.',
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
 * @param {boolean} [args.demo=false] - If true, include CDP offramp
 *   even when CDP_OFFRAMP_ENABLED=false. Used by the Coinbase review
 *   demo channel so reviewers can exercise the offramp flow before
 *   we flip the feature flag globally.
 * @returns {ProviderOption[]}
 */
function getOfframpOptions({ country, amountUsdc, demo = false }) {
  const c = (country || '').toUpperCase();
  const options = [];

  // CDP offramp visibility:
  //   - Demo channel: always show (CDP credentials must be present).
  //   - Real wallet channel, country in CDP_GUEST_OFFRAMP_COUNTRIES
  //     (US / CA today): show regardless of CDP_OFFRAMP_ENABLED flag
  //     so the operator can record the full cash-out flow without
  //     flipping env vars. Other countries still honor the flag as
  //     a global kill switch.
  const cdpAllowed = demo
    ? (process.env.CDP_API_KEY_ID && process.env.CDP_PROJECT_ID)
    : (CDP_GUEST_OFFRAMP_COUNTRIES.has(c) || cdpTrial.canUseOfframp());
  if (cdpAllowed) {
    options.push({
      provider: 'cdp_offramp',
      label: 'Coinbase Offramp',
      description: 'Cash out USDC to your bank or PayPal through Coinbase. Requires a Coinbase account with a linked payout method.',
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
    description: 'ID verification required once. Fee: ~1–2% depending on local payout rail — paid to Transak, not Rank $.',
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
    description: 'Amazon, Steam, Apple, Uber, 1,000+ brands. Effective fee 0–3% depending on brand — the gift-card markup is Bitrefill\'s, not Rank $.',
    feePctEstimate: 0.015,
    kycRequired: 'none',
    primary: false,
  });

  return options;
}

module.exports = { getOnrampOptions, getOfframpOptions };
