// Bitrefill — no-KYC offramp via gift cards.
//
// We use the affiliate link path (not the Business API) because it's
// infrastructure-free: generate a URL, hand it to the user, they spend
// their USDC-on-Base directly on Bitrefill for gift cards (Amazon,
// Steam, Apple, Uber, Starbucks, ~1,000 brands). No KYC up to ~$500 per
// guest order. We earn a small affiliate commission on completed orders.
//
// Bitrefill is always shown as an offramp option — it's the one path
// that works in every country regardless of Changelly/Coinbase rollout.
//
// BITREFILL_AFFILIATE_CODE must be set in .env (sign up at
// bitrefill.com/affiliate). If absent, the link still works but without
// the affiliate attribution.

function isConfigured() {
  return Boolean(process.env.BITREFILL_AFFILIATE_CODE);
}

/**
 * Build a deep-link to Bitrefill with USDC-on-Base pre-selected as the
 * payment method. The `refcode` pins the transaction to a specific user
 * in our DB so we can reconcile commissions later.
 *
 * @param {string} userRankId — identifier to pin Bitrefill traffic back to
 *                              a specific user in our system (Discord ID
 *                              is fine).
 * @returns {string} Bitrefill URL.
 */
function buildAffiliateLink(userRankId) {
  const code = process.env.BITREFILL_AFFILIATE_CODE || '';
  const params = new URLSearchParams({
    paymentMethod: 'usdc_base',
    utm_source: 'rankgaming',
  });
  if (code) params.set('utm_campaign', code);
  if (userRankId) params.set('refcode', String(userRankId));
  return `https://www.bitrefill.com/?${params.toString()}`;
}

module.exports = { buildAffiliateLink, isConfigured };
