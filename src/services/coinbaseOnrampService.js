// Coinbase Onramp / Offramp session token issuer.
//
// Coinbase requires "Secure Initialization" for new Onramp projects:
// instead of putting the wallet address + assets in the URL (where
// anyone could tamper with them or scrape the project ID for phishing),
// the bot mints a short-lived session token server-side that locks
// those parameters. The user is then redirected to a clean URL that
// only carries the token.
//
// Auth uses CDP's standard JWT — `generateJwt` from @coinbase/cdp-sdk/auth
// signs an ES256 JWT with our CDP_API_KEY_ID + CDP_API_KEY_SECRET that
// Coinbase's Onramp API accepts as `Authorization: Bearer <jwt>`.
//
// Tokens expire in ~5 minutes and are single-use, so we always mint a
// fresh one per click.

const { generateJwt } = require('@coinbase/cdp-sdk/auth');

const ONRAMP_API_HOST = 'api.developer.coinbase.com';
const ONRAMP_TOKEN_PATH = '/onramp/v1/token';

function isConfigured() {
  return Boolean(process.env.CDP_API_KEY_ID) && Boolean(process.env.CDP_API_KEY_SECRET);
}

/**
 * Mint an Onramp/Offramp session token for a specific wallet.
 *
 * @param {object} opts
 * @param {string} opts.walletAddress - Destination address (Onramp)
 *   or source address (Offramp) on the chain.
 * @param {string[]} [opts.assets=['USDC']] - Allowed assets.
 * @param {string[]} [opts.blockchains=['base']] - Allowed networks.
 * @returns {Promise<string>} The session token to put in the URL.
 * @throws if CDP is not configured or Coinbase rejects the request.
 */
async function createSessionToken({ walletAddress, assets = ['USDC'], blockchains = ['base'] }) {
  if (!isConfigured()) {
    throw new Error('CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set');
  }

  const jwt = await generateJwt({
    apiKeyId: process.env.CDP_API_KEY_ID,
    apiKeySecret: process.env.CDP_API_KEY_SECRET,
    requestMethod: 'POST',
    requestHost: ONRAMP_API_HOST,
    requestPath: ONRAMP_TOKEN_PATH,
  });

  const res = await fetch(`https://${ONRAMP_API_HOST}${ONRAMP_TOKEN_PATH}`, {
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
    const body = await res.text().catch(() => '');
    throw new Error(`Onramp token request failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  if (!data.token) {
    throw new Error(`Onramp token response missing 'token' field: ${JSON.stringify(data)}`);
  }
  return data.token;
}

module.exports = { createSessionToken, isConfigured };
