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

/**
 * Create RSA-SHA256 signature of the full URL + request body.
 * Changelly requires: sign(fullUrl + JSON.stringify(body || {}))
 */
function _sign(fullUrl, body) {
  const privateKeyObject = crypto.createPrivateKey({
    key: getApiSecret(),
    type: 'pkcs1',
    format: 'pem',
    encoding: 'base64',
  });

  const message = body || {};
  const payload = fullUrl + JSON.stringify(message);

  return crypto
    .sign('sha256', Buffer.from(payload), privateKeyObject)
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
 * @param {Object} options
 * @param {string} options.userId       - Discord user ID
 * @param {string} options.walletAddress - Base wallet address to receive USDC
 * @param {number|string} options.amountUsd - Amount in USD
 * @param {string} options.countryCode  - ISO 3166-1 alpha-2 country code
 * @returns {Promise<{orderId: string, redirectUrl: string}|null>}
 */
async function createOrder({ userId, walletAddress, amountUsd, countryCode }) {
  // Build webhook URL from server's public IP and port
  const webhookPort = process.env.WEBHOOK_PORT || '3001';
  const webhookHost = process.env.WEBHOOK_HOST || ''; // e.g., http://40.233.115.208:3001

  const body = {
    externalOrderId: `rank-${userId}-${Date.now()}`,
    externalUserId: userId,
    currencyFrom: 'USD',
    currencyTo: 'USDC',
    amountFrom: String(amountUsd),
    country: countryCode,
    walletAddress,
    walletExtraId: '',
    paymentMethod: 'card',
    metadata: { blockchain: 'base' },
  };

  // Add webhook URL if configured
  if (webhookHost) {
    body.callbackUrl = `${webhookHost}/api/changelly/webhook`;
  }

  const data = await _request('POST', '/orders', body);
  if (!data) return null;

  console.log(`[Changelly] Order created for user ${userId}: orderId=${data.orderId || data.id || 'unknown'}`);

  return {
    orderId: data.orderId || data.id,
    redirectUrl: data.redirectUrl || data.paymentUrl || data.redirect_url,
  };
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
async function createSellOrder({ userId, walletAddress, amountUsdc, countryCode }) {
  const webhookHost = process.env.WEBHOOK_HOST || '';

  const body = {
    externalOrderId: `rank-sell-${userId}-${Date.now()}`,
    externalUserId: userId,
    currencyFrom: 'USDC',
    currencyTo: 'USD',
    amountFrom: String(amountUsdc),
    country: countryCode,
    walletAddress,
    paymentMethod: 'card',
    metadata: { blockchain: 'base' },
  };

  if (webhookHost) {
    body.callbackUrl = `${webhookHost}/api/changelly/webhook`;
  }

  const data = await _request('POST', '/orders', body);
  if (!data) return null;

  console.log(`[Changelly] Sell order created for user ${userId}: orderId=${data.orderId || data.id || 'unknown'}`);

  return {
    orderId: data.orderId || data.id,
    redirectUrl: data.redirectUrl || data.paymentUrl || data.redirect_url,
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
