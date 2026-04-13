// Base (Coinbase L2) RPC connection singleton.
//
// Base is an Ethereum L2 — uses the same EVM, same address format,
// same tooling (ethers.js). The only difference from Ethereum mainnet
// is the chain ID (8453) and the RPC endpoint.

const { ethers } = require('ethers');

const BASE_CHAIN_ID = 8453;

/** @type {ethers.JsonRpcProvider | null} */
let provider = null;

function getEndpoint() {
  if (process.env.BASE_RPC_URL) {
    return process.env.BASE_RPC_URL;
  }
  // Public Base RPC — works for dev/testing but rate-limited.
  // Use Alchemy or QuickNode for production.
  return 'https://mainnet.base.org';
}

/**
 * Get or create the Base JSON-RPC provider singleton.
 * @returns {ethers.JsonRpcProvider}
 */
function getProvider() {
  if (!provider) {
    const endpoint = getEndpoint();
    provider = new ethers.JsonRpcProvider(endpoint, {
      name: 'base',
      chainId: BASE_CHAIN_ID,
    });
    console.log(`[Base] Connected to ${endpoint} (chain ${BASE_CHAIN_ID})`);
    if (!process.env.BASE_RPC_URL) {
      console.warn('[Base] Using public RPC — set BASE_RPC_URL to Alchemy/QuickNode for production.');
    }
  }
  return provider;
}

module.exports = {
  getProvider,
  // Backward-compat alias — old code calls getConnection
  getConnection: getProvider,
  BASE_CHAIN_ID,
};
