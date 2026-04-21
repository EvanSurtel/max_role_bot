// Coinbase Onramp / Offramp session issuer.
//
// Two different CDP endpoints in use:
//
//   1. Onramp (deposit, preferred): POST /platform/v2/onramp/sessions
//      Returns a one-click-buy URL. For users without an active Coinbase
//      account session in supported countries (US, UK, Canada), the URL
//      lands DIRECTLY on guest checkout (Apple Pay / debit card) — no
//      sign-in page. Quote is returned alongside the URL.
//
//   2. Offramp (cash-out): POST /onramp/v1/token
//      Returns a bare sessionToken for the hosted sell widget. No
//      one-click equivalent exists on Coinbase's side for offramp —
//      Coinbase requires a Coinbase account with linked bank details
//      for fiat withdrawal (guest checkout isn't supported for offramp).
//
// Both paths use the same CDP JWT auth via @coinbase/cdp-sdk/auth.

const { generateJwt } = require('@coinbase/cdp-sdk/auth');

const SESSIONS_HOST = 'api.cdp.coinbase.com';
const SESSIONS_PATH = '/platform/v2/onramp/sessions';

const LEGACY_HOST = 'api.developer.coinbase.com';
const LEGACY_TOKEN_PATH = '/onramp/v1/token';

/**
 * Thrown when Coinbase returns a response that signals the trial cap
 * was hit (403/429, or a body mentioning limit/tier/quota/trial/
 * exceeded). Callers should catch this and silently fall back to a
 * different provider (Wert) instead of showing a hard error — the
 * trial counter is also force-exhausted as a side effect so the
 * payment router stops offering CDP for subsequent requests.
 */
class TrialExhaustedError extends Error {
  constructor(detail) {
    super(detail ? `CDP trial limit reached: ${detail}` : 'CDP trial limit reached');
    this.name = 'TrialExhaustedError';
  }
}

function isConfigured() {
  return Boolean(process.env.CDP_API_KEY_ID) && Boolean(process.env.CDP_API_KEY_SECRET);
}

/**
 * Is this HTTP response from Coinbase's Onramp API likely a trial-cap
 * signal? Coinbase doesn't expose a single error code for this; they
 * return 403 or 429 with messages like "Project tier exceeded" or
 * "monthly limit reached". We match heuristically.
 */
function _looksLikeTrialCap(status, bodyText) {
  if (status === 403 || status === 429) return true;
  const msg = String(bodyText || '').toLowerCase();
  return (
    msg.includes('limit') ||
    msg.includes('tier') ||
    msg.includes('quota') ||
    msg.includes('trial') ||
    msg.includes('exceeded')
  );
}

async function _signJwt({ host, path }) {
  return generateJwt({
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
    requestMethod: 'POST',
    requestHost: host,
    requestPath: path,
  });
}

/**
 * Create a one-click Onramp session. Returns a ready-to-use URL that
 * Coinbase routes to guest checkout (no sign-in) when the viewer has
 * no active Coinbase account cookie.
 *
 * @param {object} opts
 * @param {string} opts.walletAddress - Destination wallet (on Base).
 * @param {string} [opts.purchaseCurrency='USDC']
 * @param {string} [opts.destinationNetwork='base']
 * @param {string|number} opts.paymentAmount - Fiat amount, e.g. "50".
 * @param {string} opts.paymentCurrency - ISO fiat code (USD / CAD / GBP).
 * @param {string} [opts.paymentMethod='CARD'] - CARD | APPLE_PAY | ACH | PAYPAL.
 * @param {string} opts.country - ISO 3166-1 alpha-2 (US / CA / GB).
 * @param {string} [opts.subdivision] - US state code (required when country=US).
 * @param {string} opts.partnerUserRef - Unique user id (<=49 chars).
 * @returns {Promise<{ onrampUrl: string, quote?: object }>}
 */
async function createOneClickBuySession({
  walletAddress,
  purchaseCurrency = 'USDC',
  destinationNetwork = 'base',
  paymentAmount,
  paymentCurrency,
  paymentMethod,     // optional — omitting lets Coinbase surface guest-compatible methods (e.g. Apple Pay) instead of pinning to one
  country,
  subdivision,
  partnerUserRef,
}) {
  if (!isConfigured()) {
    throw new Error('CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set');
  }

  // Close the TOCTOU window between picker render and session mint —
  // if the counter flipped to exhausted while the user was deciding,
  // bail now so deposit.js takes the silent Wert fallback instead of
  // handing out a session Coinbase will reject.
  try {
    const cdpTrial = require('./cdpTrialService');
    if (!cdpTrial.canUseOnramp()) {
      throw new TrialExhaustedError('trial cap reached between picker render and session mint');
    }
  } catch (e) {
    if (e instanceof TrialExhaustedError) throw e;
    // cdpTrial unavailable — fall through, let Coinbase enforce.
  }

  if (partnerUserRef && String(partnerUserRef).length > 49) {
    console.warn(`[CDP] partnerUserRef length ${String(partnerUserRef).length} > 49; truncating. Value: ${String(partnerUserRef).slice(0, 49)}`);
  }

  const jwt = await _signJwt({ host: SESSIONS_HOST, path: SESSIONS_PATH });

  const body = {
    destinationAddress: walletAddress,
    purchaseCurrency,
    destinationNetwork,
    paymentAmount: String(paymentAmount),
    paymentCurrency,
    country,
    partnerUserRef,
  };
  if (paymentMethod) body.paymentMethod = paymentMethod;
  if (subdivision) body.subdivision = subdivision;

  const res = await fetch(`https://${SESSIONS_HOST}${SESSIONS_PATH}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (_looksLikeTrialCap(res.status, errText)) {
      // Force-exhaust the local counter so the router stops handing
      // out CDP options until an admin resets it.
      try { require('./cdpTrialService').forceExhaust(); } catch { /* circular-safe */ }
      throw new TrialExhaustedError(`${res.status} ${errText}`.slice(0, 200));
    }
    throw new Error(`Onramp session request failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const onrampUrl = data?.session?.onrampUrl;
  if (!onrampUrl) {
    throw new Error(`Onramp session response missing session.onrampUrl: ${JSON.stringify(data)}`);
  }
  return { onrampUrl, quote: data.quote };
}

/**
 * Mint a bare sessionToken for the hosted Offramp widget. Use when a
 * one-click flow isn't available (e.g. cash-out).
 *
 * @param {object} opts
 * @param {string} opts.walletAddress
 * @param {string[]} [opts.assets=['USDC']]
 * @param {string[]} [opts.blockchains=['base']]
 * @returns {Promise<string>}
 */
async function createSessionToken({ walletAddress, assets = ['USDC'], blockchains = ['base'] }) {
  if (!isConfigured()) {
    throw new Error('CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set');
  }

  const jwt = await _signJwt({ host: LEGACY_HOST, path: LEGACY_TOKEN_PATH });

  const res = await fetch(`https://${LEGACY_HOST}${LEGACY_TOKEN_PATH}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      addresses: [{ address: walletAddress, blockchains }],
      assets,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Session token request failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  if (!data.token) {
    throw new Error(`Session token response missing 'token': ${JSON.stringify(data)}`);
  }
  return data.token;
}

module.exports = { createOneClickBuySession, createSessionToken, isConfigured, TrialExhaustedError };
