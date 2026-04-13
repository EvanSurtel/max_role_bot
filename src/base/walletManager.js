// Base wallet management.
//
// Generates Ethereum keypairs (which work on Base since Base is EVM),
// encrypts private keys with AES-256-GCM + per-user salt (same
// scheme the Solana version used), and provides balance queries for
// USDC (ERC-20) and ETH (gas).

const { ethers } = require('ethers');
const { encrypt, decrypt, generateSalt } = require('../utils/crypto');
const { getProvider } = require('./connection');

// Native USDC on Base — NOT USDbC (the old bridged version).
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;

// Minimal ERC-20 ABI — just the functions we actually call.
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

/**
 * Generate a new Ethereum wallet (works on Base).
 * Returns the public address + encrypted private key components.
 */
function generateWallet() {
  const wallet = ethers.Wallet.createRandom();
  const salt = generateSalt();
  const { encrypted, iv, tag } = encrypt(wallet.privateKey, salt);

  return {
    address: wallet.address,
    encryptedPrivateKey: encrypted,
    iv,
    tag,
    salt,
  };
}

/**
 * Reconstruct a signing Wallet from the encrypted private key.
 * Connects it to the Base provider so it can send transactions.
 */
function getWalletFromEncrypted(encryptedPrivateKey, iv, tag, salt) {
  const privateKey = decrypt(encryptedPrivateKey, iv, tag, salt);
  const provider = getProvider();
  return new ethers.Wallet(privateKey, provider);
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
 * Get the ETH balance of an address on Base (for gas).
 * Returns a string in wei.
 */
async function getEthBalance(address) {
  const provider = getProvider();
  const balance = await provider.getBalance(address);
  return balance.toString();
}

/**
 * Validate a Base/Ethereum address.
 * Checks format + blocks known dangerous addresses.
 */
function isAddressValid(address) {
  try {
    if (!ethers.isAddress(address)) return false;

    // Block known contracts / dead addresses
    const BLOCKED = new Set([
      '0x0000000000000000000000000000000000000000',                // zero address
      USDC_CONTRACT.toLowerCase(),                                  // USDC contract itself
      '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA'.toLowerCase(), // USDbC (legacy bridged)
    ]);

    // Also block the escrow/hot wallet address
    try {
      const hotWalletKey = process.env.BOT_HOT_WALLET_PRIVATE_KEY;
      if (hotWalletKey) {
        const hotWallet = new ethers.Wallet(hotWalletKey);
        BLOCKED.add(hotWallet.address.toLowerCase());
      }
    } catch { /* env not set — skip */ }

    if (BLOCKED.has(address.toLowerCase())) return false;

    return true;
  } catch {
    return false;
  }
}

module.exports = {
  generateWallet,
  getWalletFromEncrypted,
  // Backward-compat alias — old code calls getKeypairFromEncrypted
  getKeypairFromEncrypted: getWalletFromEncrypted,
  getUsdcBalance,
  getEthBalance,
  // Backward-compat alias — old code calls getSolBalance
  getSolBalance: getEthBalance,
  isAddressValid,
  USDC_CONTRACT,
  USDC_DECIMALS,
  ERC20_ABI,
};
