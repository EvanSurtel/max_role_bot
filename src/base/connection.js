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

/** @type {ethers.JsonRpcProvider | null} */
let provider = null;

function getProvider() {
  if (!provider) {
    const endpoint = process.env.BASE_RPC_URL || getDefaultRpcUrl();
    const chainId = getChainId();
    provider = new ethers.JsonRpcProvider(endpoint, {
      name: getChainName(),
      chainId,
    });

    if (getNetwork() === 'sepolia') {
      console.log(`[Base] 🧪 TESTNET (Base Sepolia, chain ${chainId}). RPC: ${endpoint}`);
    } else {
      console.log(`[Base] 🔴 MAINNET (chain ${chainId}). RPC: ${endpoint}`);
    }

    if (!process.env.BASE_RPC_URL) {
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
