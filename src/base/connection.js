// Base RPC connection singleton.
//
// BASE_NETWORK env var controls mainnet vs testnet across the entire
// bot. Set to 'sepolia' for testing, 'mainnet' for production.
// Every module that needs chain-specific config imports from here.

const { ethers } = require('ethers');

function getNetwork() {
  return (process.env.BASE_NETWORK || 'mainnet').toLowerCase();
}

function getChainId() {
  return getNetwork() === 'sepolia' ? 84532 : 8453;
}

function getChainName() {
  return getNetwork() === 'sepolia' ? 'base-sepolia' : 'base';
}

// CDP network ID for wallet creation
function getCdpNetworkId() {
  return getNetwork() === 'sepolia' ? 'base-sepolia' : 'base-mainnet';
}

function getDefaultRpcUrl() {
  return getNetwork() === 'sepolia'
    ? 'https://sepolia.base.org'
    : 'https://mainnet.base.org';
}

function getExplorerUrl() {
  return getNetwork() === 'sepolia'
    ? 'https://sepolia.basescan.org'
    : 'https://basescan.org';
}

/** @type {ethers.JsonRpcProvider | ethers.FallbackProvider | null} */
let provider = null;

function getProvider() {
  if (!provider) {
    const chainId = getChainId();
    const network = { name: getChainName(), chainId };
    const primaryUrl = process.env.BASE_RPC_URL;
    const fallbackUrl = process.env.BASE_RPC_URL_FALLBACK;

    const netLabel = getNetwork() === 'sepolia'
      ? `🧪 TESTNET (Base Sepolia, chain ${chainId})`
      : `🔴 MAINNET (chain ${chainId})`;

    if (primaryUrl && fallbackUrl) {
      // Both URLs available — use FallbackProvider for automatic failover
      const primaryProvider = new ethers.JsonRpcProvider(primaryUrl, network);
      const fallbackProvider = new ethers.JsonRpcProvider(fallbackUrl, network);
      provider = new ethers.FallbackProvider([
        { provider: primaryProvider, priority: 1, stallTimeout: 2000, weight: 2 },
        { provider: fallbackProvider, priority: 2, stallTimeout: 3000, weight: 1 },
      ], network, { quorum: 1 });
      console.log(`[Base] ${netLabel}. RPC: FallbackProvider (primary + fallback)`);
    } else {
      // Single provider mode
      const endpoint = primaryUrl || getDefaultRpcUrl();
      provider = new ethers.JsonRpcProvider(endpoint, network);
      console.log(`[Base] ${netLabel}. RPC: ${endpoint}`);
    }

    if (!primaryUrl) {
      console.warn('[Base] Using public RPC — set BASE_RPC_URL for production.');
    }
  }
  return provider;
}

module.exports = {
  getProvider,
  getConnection: getProvider,
  getNetwork,
  getChainId,
  getChainName,
  getCdpNetworkId,
  getExplorerUrl,
};
