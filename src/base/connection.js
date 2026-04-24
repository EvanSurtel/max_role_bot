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

/**
 * One-shot sanity check: confirm the configured RPC actually reports
 * the chain ID we expect. Guards against the silent-miswire case
 * where BASE_NETWORK=mainnet but BASE_RPC_URL points at a testnet
 * endpoint (ethers' per-call network hint would let the mismatched
 * RPC answer without complaint, and every subsequent on-chain call
 * goes to the wrong network).
 *
 * Called from src/index.js boot after migrations have run. Throws
 * if the chain ID reported by the RPC disagrees with what our env
 * config expects, causing the bot to fail loudly at startup instead
 * of silently misrouting match-start UserOps.
 */
async function verifyChainId() {
  const expected = getChainId();
  const p = getProvider();
  const net = await p.getNetwork();
  const actual = Number(net.chainId);
  if (actual !== expected) {
    throw new Error(
      `BASE_NETWORK mismatch: BASE_NETWORK=${getNetwork()} expects chainId ${expected} ` +
      `but the RPC at BASE_RPC_URL reports chainId ${actual}. ` +
      `Check BASE_RPC_URL and BASE_NETWORK env vars.`,
    );
  }
  console.log(`[Base] Chain ID verified: ${actual} (${getChainName()})`);
}

module.exports = {
  getProvider,
  getConnection: getProvider,
  getNetwork,
  getChainId,
  getChainName,
  getCdpNetworkId,
  getExplorerUrl,
  verifyChainId,
};
