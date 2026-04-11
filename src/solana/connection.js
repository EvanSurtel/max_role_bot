const { Connection, clusterApiUrl } = require('@solana/web3.js');

/** @type {Connection | null} */
let connection = null;

/**
 * Return the normalized network name. Defaults to mainnet-beta —
 * this bot runs on real money, so the SAFE fallback is to stay
 * on mainnet instead of silently reverting to devnet on a missing
 * env var. Explicitly set SOLANA_NETWORK=devnet if you want the
 * test cluster.
 */
function getNetwork() {
  const raw = (process.env.SOLANA_NETWORK || 'mainnet-beta').toLowerCase();
  if (raw === 'mainnet' || raw === 'mainnet-beta') return 'mainnet-beta';
  if (raw === 'devnet') return 'devnet';
  if (raw === 'testnet') return 'testnet';
  throw new Error(`Unknown SOLANA_NETWORK: "${raw}". Use "mainnet-beta" or "devnet".`);
}

function getEndpoint() {
  // Explicit URL always wins — production deploys should point at
  // Helius / QuickNode / Triton rather than the public mainnet-beta
  // RPC (which is heavily rate-limited and unreliable for a bot
  // that polls for deposits and submits on-chain transactions).
  if (process.env.SOLANA_RPC_URL) {
    return process.env.SOLANA_RPC_URL;
  }
  return clusterApiUrl(getNetwork());
}

/**
 * Get or create the Solana Connection singleton.
 * @returns {Connection}
 */
function getConnection() {
  if (!connection) {
    const network = getNetwork();
    const endpoint = getEndpoint();
    connection = new Connection(endpoint, 'confirmed');
    if (network === 'mainnet-beta') {
      console.log(`[Solana] 🔴 MAINNET — real money mode. RPC: ${endpoint}`);
    } else {
      console.log(`[Solana] 🧪 ${network.toUpperCase()} — test cluster. RPC: ${endpoint}`);
    }
    if (network === 'mainnet-beta' && !process.env.SOLANA_RPC_URL) {
      console.warn('[Solana] ⚠️  Using the PUBLIC mainnet-beta RPC. This is rate-limited and unreliable for a production bot.');
      console.warn('[Solana]    Set SOLANA_RPC_URL to a paid endpoint (Helius / QuickNode / Triton) for reliable deposit polling.');
    }
  }
  return connection;
}

module.exports = { getConnection, getNetwork };
