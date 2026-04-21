// Changelly Fiat API — RSA-SHA256 signed requests for on/off-ramp orders.
const crypto = require('crypto');

const DEFAULT_API_URL = 'https://fiat-api.changelly.com/v1';

function getApiKey() {
  return process.env.CHANGELLY_FIAT_API_KEY || '';
}

function getApiSecret() {
  return process.env.CHANGELLY_FIAT_API_SECRET || '';
}

function getApiUrl() {
  return process.env.CHANGELLY_FIAT_API_URL || DEFAULT_API_URL;
}

function isConfigured() {
  return Boolean(getApiKey()) && Boolean(getApiSecret());
}

// Cached parsed key object — parsing is non-trivial and the key
// never changes at runtime, so we do it once and reuse.
let _cachedPrivateKey = null;
let _cachedSecretSource = null;

/**
 * Decode whatever format Changelly gave you into a usable Node
 * KeyObject. Accepts all of:
 *
 *   1. Raw PEM with -----BEGIN (RSA )?PRIVATE KEY----- markers,
 *      literal newlines in the env var
 *   2. Raw PEM with \n escape sequences (common when pasted into
 *      .env without newlines)
 *   3. Single-line base64-encoded PEM (most common prod format)
 *   4. Already-decoded PKCS#1 or PKCS#8 — Node autodetects both
 *
 * This saves you from having to run openssl conversions — paste
 * whatever Changelly sent and we figure it out.
 */
function _parsePrivateKey(raw) {
  if (!raw) throw new Error('CHANGELLY_FIAT_API_SECRET is empty');

  // Normalize: if it doesn't look like PEM, try base64-decode first.
  let pem = raw.trim();
  if (!pem.includes('-----BEGIN')) {
    try {
      const decoded = Buffer.from(pem, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN')) {
        pem = decoded;
      }
    } catch { /* fall through */ }
  }

  // Some .env editors swap actual newlines for literal `\n` — undo that.
  if (pem.includes('\\n') && !pem.includes('\n-----END')) {
    pem = pem.replace(/\\n/g, '\n');
  }

  if (!pem.includes('-----BEGIN')) {
    throw new Error('CHANGELLY_FIAT_API_SECRET does not look like a PEM key (no -----BEGIN marker after base64 decode). Check the value you pasted.');
  }

  // Node's createPrivateKey auto-detects PKCS#1 (BEGIN RSA PRIVATE KEY)
  // vs PKCS#8 (BEGIN PRIVATE KEY) when format='pem' and no type is set.
  return crypto.createPrivateKey({ key: pem, format: 'pem' });
}

/**
 * Create RSA-SHA256 signature of the full URL + request body.
 * Changelly requires: sign(fullUrl + JSON.stringify(body || {}))
 */
function _sign(fullUrl, body) {
  const secret = getApiSecret();
  if (secret !== _cachedSecretSource) {
    _cachedPrivateKey = _parsePrivateKey(secret);
    _cachedSecretSource = secret;
  }

  const message = body || {};
  const payload = fullUrl + JSON.stringify(message);

  return crypto
    .sign('sha256', Buffer.from(payload), _cachedPrivateKey)
    .toString('base64');
}

/**
 * Internal HTTP helper. Sets auth headers and handles errors.
 */
async function _request(method, path, body = null) {
  if (!isConfigured()) {
    console.warn('[Changelly] API key/secret not configured, skipping request');
    return null;
  }

  const url = `${getApiUrl()}${path}`;

  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': getApiKey(),
    'X-Api-Signature': _sign(url, body),
  };

  const options = { method, headers };
  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(url, options);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[Changelly] API error ${res.status} for ${method} ${path}: ${text}`);
      return null;
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    console.error(`[Changelly] Request failed for ${method} ${path}:`, err.message);
    return null;
  }
}

/**
 * Create a fiat-to-crypto order and return the redirect URL.
 *
 * Changelly's /orders endpoint requires `providerCode` (moonpay, banxa,
 * transak, or wert) — it won't pick one for you. We call /offers first
 * to see which providers are currently available for this country +
 * currency pair. If `preferredProviderCode` is passed, we pick that
 * provider's offer specifically; otherwise we fall back to the first
 * success offer (best rate). The resulting redirect URL goes straight
 * to the provider's hosted page; the user doesn't sign into Changelly.
 *
 * @param {Object} options
 * @param {string} options.userId       - Discord user ID
 * @param {string} options.walletAddress - Base wallet address to receive USDC
 * @param {number|string} options.amountUsd - Amount in USD
 * @param {string} options.countryCode  - ISO 3166-1 alpha-2 country code
 * @param {string} [options.stateCode]  - ISO 3166-2 US state code (required if country=US)
 * @param {string} [options.preferredProviderCode] - Pin to a specific provider (wert|transak|moonpay|banxa)
 * @returns {Promise<{orderId: string, redirectUrl: string, providerCode: string}|null>}
 */
async function createOrder({ userId, walletAddress, amountUsd, countryCode, stateCode, preferredProviderCode }) {
  const offers = await getOffers(amountUsd, countryCode);
  const offerList = Array.isArray(offers) ? offers : (offers?.data || offers?.offers || []);
  if (!offerList || offerList.length === 0) {
    console.error(`[Changelly] No offers available for ${amountUsd} USD → USDC in ${countryCode}`);
    return null;
  }

  // Filter to success offers only — error offers carry errorType + no
  // rate/fee. Picking one and passing its providerCode to /orders is how
  // the "could not generate payment link" path fires.
  const successOffers = offerList.filter(o => !o.errorType && (o.providerCode || o.provider?.code || o.provider_code));
  if (successOffers.length === 0) {
    const errs = offerList.filter(o => o.errorType).map(o => `${o.providerCode}:${o.errorType}`).join(', ');
    console.error(`[Changelly] No usable offers for ${amountUsd} USD → USDC in ${countryCode}. Provider errors: ${errs || 'none'}`);
    return null;
  }

  // If caller pinned a provider, try it first. If unavailable in this
  // country / amount combo, fall through to first success offer so the
  // user gets *some* working path rather than a hard fail.
  const _codeOf = o => (o.providerCode || o.provider?.code || o.provider_code);
  let offer;
  if (preferredProviderCode) {
    offer = successOffers.find(o => _codeOf(o) === preferredProviderCode);
    if (!offer) {
      console.warn(`[Changelly] Preferred provider ${preferredProviderCode} not available for ${countryCode}; falling back to first success offer.`);
    }
  }
  if (!offer) offer = successOffers[0];
  const providerCode = _codeOf(offer);

  const webhookHost = process.env.WEBHOOK_HOST || '';

  const body = {
    // Millisecond + random suffix so two clicks in the same millisecond
    // still mint distinct order ids (Changelly treats externalOrderId
    // as unique; a collision would either create a duplicate order or
    // 409 the second request).
    externalOrderId: `rank-${userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    externalUserId: userId,
    providerCode,
    currencyFrom: 'USD',
    currencyTo: 'USDC',
    amountFrom: String(amountUsd),
    country: countryCode,
    walletAddress,
    paymentMethod: 'card',
  };

  // `state` is required by Changelly when country=US (the
  // ChangellyErrorType.State enum exists specifically for offers
  // rejected due to missing state). Omitting it for non-US countries.
  if (countryCode === 'US' && stateCode) {
    body.state = stateCode;
  }

  if (webhookHost) {
    body.returnSuccessUrl = `${webhookHost}/deposit-success`;
    body.returnFailedUrl = `${webhookHost}/deposit-failed`;
  }

  const data = await _request('POST', '/orders', body);
  if (!data) return null;

  console.log(`[Changelly] Order created for user ${userId} via ${providerCode}: orderId=${data.orderId || data.id || 'unknown'}`);

  const redirectUrl = data.redirectUrl || data.paymentUrl || data.redirect_url;
  if (!_isTrustedProviderUrl(redirectUrl)) {
    console.error(`[Changelly] Untrusted redirectUrl in order response: ${redirectUrl}`);
    return null;
  }

  return {
    orderId: data.orderId || data.id,
    redirectUrl,
    providerCode,
  };
}

// Trusted domain allowlist for provider redirect URLs. Changelly returns
// a `redirectUrl` from each underlying provider's checkout page — if
// Changelly's response is tampered with (MITM, compromised endpoint)
// we refuse to render a Discord link button pointing at an attacker
// domain. `url.hostname.endsWith(domain)` covers subdomains like
// `widget.wert.io` / `global.transak.com`.
const TRUSTED_PROVIDER_REDIRECT_DOMAINS = [
  'changelly.com',
  'wert.io',
  'transak.com',
  'moonpay.com',
  'banxa.com',
];
function _isTrustedProviderUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return TRUSTED_PROVIDER_REDIRECT_DOMAINS.some(d =>
    parsed.hostname === d || parsed.hostname.endsWith('.' + d),
  );
}

/**
 * Get available purchase offers with rates and fees.
 * @param {number|string} amountUsd  - Amount in USD
 * @param {string} countryCode       - ISO 3166-1 alpha-2 country code
 * @returns {Promise<Array|null>}
 */
async function getOffers(amountUsd, countryCode) {
  const params = new URLSearchParams({
    currencyFrom: 'USD',
    currencyTo: 'USDC',
    amountFrom: String(amountUsd),
    country: countryCode,
    paymentMethod: 'card',
  });

  return _request('GET', `/offers?${params.toString()}`);
}

/**
 * Validate that a wallet address is valid for Base USDC.
 * @param {string} address - Wallet address to validate
 * @returns {Promise<{result: boolean}|null>}
 */
async function validateAddress(address) {
  const body = {
    currency: 'USDC',
    walletAddress: address,
  };

  return _request('POST', '/validate-address', body);
}

/**
 * Get list of countries where Changelly on-ramp is available.
 * @returns {Promise<Array|null>}
 */
async function getAvailableCountries() {
  return _request('GET', '/available-countries');
}

/**
 * Create a sell (off-ramp) order — user sells USDC for fiat.
 * @param {Object} options
 * @param {string} options.userId       - Discord user ID
 * @param {string} options.walletAddress - Wallet address holding the USDC
 * @param {number|string} options.amountUsdc - Amount of USDC to sell
 * @param {string} options.countryCode  - ISO 3166-1 alpha-2 country code
 * @returns {Promise<{orderId: string, redirectUrl: string}|null>}
 */
async function createSellOrder({ userId, walletAddress, amountUsdc, countryCode, stateCode, preferredProviderCode }) {
  // Off-ramp uses the same /offers → /orders flow as on-ramp, just with
  // currencyFrom/To flipped. providerCode is still required.
  const offers = await _request('GET', `/offers?${new URLSearchParams({
    currencyFrom: 'USDC',
    currencyTo: 'USD',
    amountFrom: String(amountUsdc),
    country: countryCode,
    paymentMethod: 'card',
  }).toString()}`);
  const offerList = Array.isArray(offers) ? offers : (offers?.data || offers?.offers || []);
  if (!offerList || offerList.length === 0) {
    console.error(`[Changelly] No sell offers available for ${amountUsdc} USDC → USD in ${countryCode}`);
    return null;
  }

  const successOffers = offerList.filter(o => !o.errorType && (o.providerCode || o.provider?.code || o.provider_code));
  if (successOffers.length === 0) {
    const errs = offerList.filter(o => o.errorType).map(o => `${o.providerCode}:${o.errorType}`).join(', ');
    console.error(`[Changelly] No usable sell offers in ${countryCode}. Provider errors: ${errs || 'none'}`);
    return null;
  }
  const _codeOf = o => (o.providerCode || o.provider?.code || o.provider_code);
  let offer;
  if (preferredProviderCode) {
    offer = successOffers.find(o => _codeOf(o) === preferredProviderCode);
    if (!offer) {
      console.warn(`[Changelly] Preferred sell provider ${preferredProviderCode} not available in ${countryCode}; falling back to first success offer.`);
    }
  }
  if (!offer) offer = successOffers[0];
  const providerCode = _codeOf(offer);

  const webhookHost = process.env.WEBHOOK_HOST || '';

  const body = {
    externalOrderId: `rank-sell-${userId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    externalUserId: userId,
    providerCode,
    currencyFrom: 'USDC',
    currencyTo: 'USD',
    amountFrom: String(amountUsdc),
    country: countryCode,
    walletAddress,
    paymentMethod: 'card',
    metadata: { blockchain: 'base' },
  };

  if (countryCode === 'US' && stateCode) {
    body.state = stateCode;
  }

  if (webhookHost) {
    body.returnSuccessUrl = `${webhookHost}/cashout-success`;
    body.returnFailedUrl = `${webhookHost}/cashout-failed`;
  }

  const data = await _request('POST', '/orders', body);
  if (!data) return null;

  console.log(`[Changelly] Sell order created for user ${userId} via ${providerCode}: orderId=${data.orderId || data.id || 'unknown'}`);

  const redirectUrl = data.redirectUrl || data.paymentUrl || data.redirect_url;
  if (!_isTrustedProviderUrl(redirectUrl)) {
    console.error(`[Changelly] Untrusted sell-order redirectUrl: ${redirectUrl}`);
    return null;
  }

  return {
    orderId: data.orderId || data.id,
    redirectUrl,
    providerCode,
  };
}

module.exports = {
  isConfigured,
  createOrder,
  createSellOrder,
  getOffers,
  validateAddress,
  getAvailableCountries,
};
