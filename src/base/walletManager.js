// Base wallet management — CDP Server Accounts (@coinbase/cdp-sdk).
//
// Every user gets a CDP EVM account created via the new CdpClient SDK.
// CDP manages private keys server-side — the bot never touches raw keys.
//
// The new CDP SDK handles:
//   - Account creation (cdp.evm.getOrCreateAccount)
//   - Transaction signing (cdp.evm.sendTransaction)
//   - Gas sponsorship (configured at the CDP project level)
//
// The bot stores the CDP account name in the DB (in the account_ref
// column). No encryption is needed since CDP holds the keys —
// iv, tag, salt are stored as empty strings.

const { CdpClient } = require('@coinbase/cdp-sdk');
const { ethers } = require('ethers');
const { getProvider } = require('./connection');

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

// CdpClient singleton — lazy-initialized on first use.
// Auto-reads CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET from env.
let _cdpClient = null;

function getCdpClient() {
  if (_cdpClient) return _cdpClient;
  _cdpClient = new CdpClient();
  return _cdpClient;
}

/**
 * Create a new CDP EVM account for a user on Base.
 *
 * Returns the account address + the account name (accountRef).
 * Since CDP manages keys server-side, no encryption is needed —
 * iv, tag, salt are empty strings.
 *
 * @param {string} [userId] — Discord user ID (used to build a unique account name)
 */
async function generateWallet(userId) {
  const cdp = getCdpClient();
  const ownerName = `user-${userId || Date.now()}`;

  // Create the EOA owner account (holds the signer key)
  const owner = await cdp.evm.getOrCreateAccount({ name: ownerName });

  // Create the Smart Account (ERC-4337) — gasless via Paymaster.
  // getOrCreateSmartAccount is idempotent: same name+owner → same address.
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: `smart-${ownerName}`,
    owner,
  });

  return {
    address: smartAccount.address,
    accountRef: ownerName, // store owner account name for signing
    iv: '',
    tag: '',
    salt: '',
  };
}

/**
 * Legacy function — previously reconstructed a CDP wallet from encrypted data.
 *
 * With the new @coinbase/cdp-sdk, signing is done via cdp.evm.sendTransaction()
 * using just the address. Callers that need to sign should use getCdpClient()
 * directly. This function returns null for backward compatibility — callers
 * that still reference it should be migrated to use the CdpClient directly.
 */
async function getWalletFromEncrypted(/* encryptedData, iv, tag, salt */) {
  return null;
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
 * Returns a string in wei. (Users don't need ETH because CDP sponsors gas,
 * but we keep this for the admin escrow panel and health checks.)
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
  getCdpClient,
  // Backward-compat aliases (getSolBalance kept for any residual callers)
  getKeypairFromEncrypted: getWalletFromEncrypted,
  getUsdcBalance,
  getEthBalance,
  getSolBalance: getEthBalance, // deprecated — use getEthBalance directly
  isAddressValid,
  USDC_CONTRACT,
  USDC_DECIMALS,
  ERC20_ABI,
};
