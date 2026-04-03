const { Connection, clusterApiUrl } = require('@solana/web3.js');

/** @type {Connection | null} */
let connection = null;

/**
 * Get the Solana RPC endpoint based on SOLANA_NETWORK env var.
 * Defaults to devnet if not set.
 */
function getEndpoint() {
  const network = (process.env.SOLANA_NETWORK || 'devnet').toLowerCase();
  // Allow custom RPC URL (e.g. Helius, QuickNode)
  if (process.env.SOLANA_RPC_URL) {
    return process.env.SOLANA_RPC_URL;
  }
  if (network === 'mainnet-beta' || network === 'mainnet') {
    return clusterApiUrl('mainnet-beta');
  }
  if (network === 'devnet') {
    return clusterApiUrl('devnet');
  }
  throw new Error(`Unknown SOLANA_NETWORK: "${network}". Use "devnet" or "mainnet".`);
}

/**
 * Get or create the Solana Connection singleton.
 * @returns {Connection}
 */
function getConnection() {
  if (!connection) {
    const endpoint = getEndpoint();
    connection = new Connection(endpoint, 'confirmed');
    console.log(`[Solana] Connected to ${endpoint}`);
  }
  return connection;
}

module.exports = { getConnection };
