// MoonPay URL signing + webhook signature verification.
//
// This is the low-level, stateless utility. The higher-level
// "create a deposit for this user, store the row, handle the
// webhook callback" logic lives in moonpayService.js.
//
// Signing algorithm (widget URLs):
//   1. Build the URL with query params using URLSearchParams
//   2. HMAC-SHA256 the query string (including the leading `?`)
//      with MOONPAY_SECRET_KEY
//   3. Base64 encode the HMAC digest
//   4. Append as `&signature=<base64>`
//
// Webhook verification:
//   MoonPay sends `Moonpay-Signature-V2` header shaped as
//   "t=<timestamp>,s=<hex signature>". The signature is
//   HMAC-SHA256(`${timestamp}.${rawBody}`, webhookSecret).
//   Compare constant-time to prevent timing oracles.

const crypto = require('crypto');

function _secret() {
  const s = process.env.MOONPAY_SECRET_KEY;
  if (!s) throw new Error('MOONPAY_SECRET_KEY not set in .env');
  return s;
}

function _apiKey() {
  const k = process.env.MOONPAY_API_KEY;
  if (!k) throw new Error('MOONPAY_API_KEY not set in .env');
  return k;
}

// Widget base URL depends on environment. Sandbox is where you
// develop and test — use pk_test_ keys + test cards. Production
// uses pk_live_ keys and real money.
function _widgetBase(type) {
  const env = (process.env.MOONPAY_ENV || 'sandbox').toLowerCase();
  const prefix = env === 'production' ? '' : '-sandbox';
  if (type === 'onramp') return `https://buy${prefix}.moonpay.com`;
  if (type === 'offramp') return `https://sell${prefix}.moonpay.com`;
  throw new Error(`Unknown MoonPay widget type: ${type}`);
}

/**
 * Apply the signature query param to a fully-constructed URL.
 * Takes the current `url.search` (query string with leading `?`)
 * and HMACs it with the secret key, then appends as `&signature=…`.
 */
function _signAndReturn(url) {
  const signature = crypto
    .createHmac('sha256', _secret())
    .update(url.search)
    .digest('base64');
  url.searchParams.append('signature', signature);
  return url.toString();
}

/**
 * Build a signed MoonPay on-ramp (buy) widget URL for a user.
 *
 * currencyCode: `usdc_sol` = USDC on Solana mainnet (MoonPay uses
 * chain-suffixed codes to disambiguate multi-chain assets).
 * In sandbox, MoonPay uses the devnet testnet faucet-style USDC
 * so the address is still a real Solana address but the token
 * arrives on devnet.
 */
function buildSignedOnRampUrl({ walletAddress, externalTransactionId, baseCurrencyAmount, redirectURL } = {}) {
  if (!walletAddress) throw new Error('walletAddress is required');
  const url = new URL(_widgetBase('onramp'));
  url.searchParams.append('apiKey', _apiKey());
  url.searchParams.append('currencyCode', 'usdc_sol');
  url.searchParams.append('walletAddress', walletAddress);
  url.searchParams.append('lockAmount', 'false'); // let the user pick the amount
  if (externalTransactionId) url.searchParams.append('externalTransactionId', externalTransactionId);
  if (baseCurrencyAmount) url.searchParams.append('baseCurrencyAmount', String(baseCurrencyAmount));
  if (redirectURL) url.searchParams.append('redirectURL', redirectURL);
  return _signAndReturn(url);
}

/**
 * Build a signed MoonPay off-ramp (sell) widget URL for a user.
 *
 * The user picks a quote currency amount (USD/EUR/etc.) on the
 * MoonPay hosted page. MoonPay then computes how much USDC they
 * need to receive, generates a deposit address, and the bot is
 * notified via webhook (`transaction_updated` → `waitingForDeposit`)
 * with the deposit address. At that point moonpayService
 * initiates the USDC transfer from the user's bot wallet to the
 * provided address.
 *
 * refundWalletAddress is where MoonPay sends the USDC back if
 * something goes wrong mid-flow. We set it to the same wallet the
 * user came from.
 */
function buildSignedOffRampUrl({ walletAddress, externalTransactionId, quoteCurrencyAmount, refundWalletAddress, redirectURL } = {}) {
  if (!walletAddress) throw new Error('walletAddress is required');
  const url = new URL(_widgetBase('offramp'));
  url.searchParams.append('apiKey', _apiKey());
  url.searchParams.append('baseCurrencyCode', 'usdc_sol');
  url.searchParams.append('refundWalletAddress', refundWalletAddress || walletAddress);
  if (externalTransactionId) url.searchParams.append('externalTransactionId', externalTransactionId);
  if (quoteCurrencyAmount) url.searchParams.append('quoteCurrencyAmount', String(quoteCurrencyAmount));
  if (redirectURL) url.searchParams.append('redirectURL', redirectURL);
  return _signAndReturn(url);
}

/**
 * Verify a MoonPay webhook `Moonpay-Signature-V2` header against
 * the raw request body. Returns true only if:
 *   1. MOONPAY_WEBHOOK_SECRET is configured
 *   2. Header parses into t=<timestamp>,s=<hex>
 *   3. HMAC-SHA256(`${t}.${rawBody}`, secret) === provided signature
 *      (constant-time comparison)
 *
 * Pass `rawBody` as a Buffer or string — whatever express gave you
 * from `express.raw({ type: 'application/json' })`.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const webhookSecret = process.env.MOONPAY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.warn('[MoonPay] MOONPAY_WEBHOOK_SECRET not set — refusing webhooks');
    return false;
  }

  // Parse "t=1234567890,s=abcdef0123" format
  const parts = {};
  for (const piece of signatureHeader.split(',')) {
    const [k, v] = piece.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const timestamp = parts.t;
  const providedSig = parts.s;
  if (!timestamp || !providedSig) return false;

  const payload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expectedHex = crypto
    .createHmac('sha256', webhookSecret)
    .update(payload)
    .digest('hex');

  try {
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    const providedBuf = Buffer.from(providedSig, 'hex');
    if (expectedBuf.length !== providedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

/**
 * Basic config check — enough to generate a signed URL. If this
 * returns true we can safely expose the on-ramp (deposit) button;
 * MoonPay webhooks are optional for on-ramp because the existing
 * deposit poller credits the user automatically when USDC arrives.
 */
function isConfigured() {
  return Boolean(process.env.MOONPAY_API_KEY && process.env.MOONPAY_SECRET_KEY);
}

/**
 * Full off-ramp readiness — also requires webhooks. Off-ramp CANNOT
 * work without webhooks because the bot needs MoonPay to tell it
 * where to send the user's USDC (MoonPay's sell-side deposit
 * address is generated per-transaction and only delivered via the
 * `waitingForDeposit` webhook). If MOONPAY_WEBHOOK_SECRET or
 * WEBHOOK_PUBLIC_URL aren't set, the off-ramp button is hidden
 * from the wallet panel so users can't start a flow that would
 * just strand.
 */
function isOfframpConfigured() {
  return (
    isConfigured() &&
    Boolean(process.env.MOONPAY_WEBHOOK_SECRET) &&
    Boolean(process.env.WEBHOOK_PUBLIC_URL)
  );
}

function getEnvLabel() {
  return (process.env.MOONPAY_ENV || 'sandbox').toLowerCase();
}

module.exports = {
  buildSignedOnRampUrl,
  buildSignedOffRampUrl,
  verifyWebhookSignature,
  isConfigured,
  isOfframpConfigured,
  getEnvLabel,
};
