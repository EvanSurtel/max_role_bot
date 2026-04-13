// Base wallet management — CDP Smart Accounts (ERC-4337).
//
// Every user gets a Smart Account created via the Coinbase Developer
// Platform (CDP) Smart Wallet API. Smart Accounts support gasless
// transactions through the Coinbase Paymaster — users never need ETH.
//
// The CDP SDK handles:
//   - Smart Account creation (counterfactual — deployed on first tx)
//   - Transaction signing (server-side signer key)
//   - UserOperation bundling (submitted via CDP Bundler)
//   - Gas sponsorship (Coinbase Paymaster auto-sponsors USDC transfers)
//
// The bot stores the CDP wallet ID (encrypted) in the DB. To sign a
// tx later, it re-loads the wallet from CDP using the stored ID.

const { Coinbase, Wallet } = require('@coinbase/coinbase-sdk');
const { ethers } = require('ethers');
const { encrypt, decrypt, generateSalt } = require('../utils/crypto');
const { getProvider, getCdpNetworkId } = require('./connection');

// Native USDC on Base — configurable for testnet.
// Mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (Circle native USDC)
// Testnet: set USDC_CONTRACT_ADDRESS in .env to your test token address
const USDC_CONTRACT = process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;

// Minimal ERC-20 ABI for balance/allowance queries (read-only, no signing).
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

// CDP SDK singleton — initialized on first use.
let _cdpInitialized = false;

function _ensureCdpInit() {
  if (_cdpInitialized) return;
  const apiKeyName = process.env.CDP_API_KEY_NAME;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  if (!apiKeyName || !apiKeySecret) {
    throw new Error('CDP_API_KEY_NAME and CDP_API_KEY_SECRET must be set in .env');
  }
  Coinbase.configure({
    apiKeyName,
    privateKey: apiKeySecret,
  });
  _cdpInitialized = true;
}

/**
 * Create a new CDP Smart Account for a user on Base.
 *
 * Returns the Smart Account address + the wallet data (encrypted)
 * that the bot needs to re-load the wallet later for signing.
 *
 * The wallet data is a JSON string containing the CDP wallet ID
 * and any metadata the SDK needs to reconstruct the signer.
 */
async function generateWallet() {
  _ensureCdpInit();

  // Create a wallet on Base (mainnet or sepolia depending on BASE_NETWORK)
  const wallet = await Wallet.create({ networkId: getCdpNetworkId() });

  // The default address is the Smart Account address
  const defaultAddress = await wallet.getDefaultAddress();
  const address = defaultAddress.getId();

  // Export the wallet data so we can re-import it later.
  // This contains the wallet ID + seed — everything needed to sign.
  const walletData = wallet.export();
  const walletDataJson = JSON.stringify(walletData);

  // Encrypt the wallet data for storage
  const salt = generateSalt();
  const { encrypted, iv, tag } = encrypt(walletDataJson, salt);

  return {
    address,
    encryptedPrivateKey: encrypted,   // legacy column name — stores encrypted CDP wallet data
    iv,
    tag,
    salt,
  };
}

/**
 * Re-load a CDP wallet from encrypted wallet data.
 * Returns the CDP Wallet object ready for signing.
 */
async function getWalletFromEncrypted(encryptedData, iv, tag, salt) {
  _ensureCdpInit();
  const walletDataJson = decrypt(encryptedData, iv, tag, salt);
  const walletData = JSON.parse(walletDataJson);
  const wallet = await Wallet.import(walletData);
  return wallet;
}

/**
 * Get the USDC balance of an address on Base.
 * Returns a string in smallest units (6 decimals).
 */
async function getUsdcBalance(address) {
  const provider = getProvider();
  const usdc = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, provider);
  const balance = await usdc.balanceOf(address);
  return balance.toString();
}

/**
 * Get the ETH balance of an address on Base.
 * Returns a string in wei. (Smart Account users don't need ETH
 * because the Paymaster sponsors gas, but we keep this for the
 * admin escrow panel and health checks.)
 */
async function getEthBalance(address) {
  const provider = getProvider();
  const balance = await provider.getBalance(address);
  return balance.toString();
}

/**
 * Validate a Base/Ethereum address.
 */
function isAddressValid(address) {
  try {
    if (!ethers.isAddress(address)) return false;

    const BLOCKED = new Set([
      '0x0000000000000000000000000000000000000000',
      USDC_CONTRACT.toLowerCase(),
      '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA'.toLowerCase(), // USDbC legacy
    ]);

    // Block escrow contract
    try {
      const escrowAddr = process.env.ESCROW_CONTRACT_ADDRESS;
      if (escrowAddr) BLOCKED.add(escrowAddr.toLowerCase());
    } catch { /* */ }

    if (BLOCKED.has(address.toLowerCase())) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  generateWallet,
  getWalletFromEncrypted,
  // Backward-compat aliases
  getKeypairFromEncrypted: getWalletFromEncrypted,
  getUsdcBalance,
  getEthBalance,
  getSolBalance: getEthBalance,
  isAddressValid,
  USDC_CONTRACT,
  USDC_DECIMALS,
  ERC20_ABI,
};
