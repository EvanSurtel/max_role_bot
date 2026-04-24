// Base wallet management — CDP Smart Accounts (@coinbase/cdp-sdk).
//
// Every user gets a CDP Smart Account (ERC-4337) with a CDP server
// account as the owner. This gives us:
//   - Gasless transactions via Paymaster (Base Sepolia = free, mainnet = CDP Paymaster)
//   - Batched calls (multiple ERC-20 ops in one UserOp)
//   - Server-side key management (bot never touches private keys)
//
// Architecture:
//   CDP EOA (owner) ---owns---> Smart Account (ERC-4337)
//   The owner signs UserOps; the Smart Account is the on-chain address.
//
// The bot stores:
//   - address           = Smart Account address (the on-chain wallet users see)
//   - account_ref       = owner account name (for getOrCreateAccount lookup)
//   - smart_account_ref = Smart Account name (for getOrCreateSmartAccount lookup)
//   - iv, tag, salt     = empty (CDP manages keys)
//
// Sending transactions:
//   - Primary: cdp.evm.sendUserOperation() via Smart Account (gasless)
//   - Fallback: cdp.evm.sendTransaction() via owner EOA (needs ETH for gas)

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
 * Create a new CDP Smart Account for a user on Base.
 *
 * Creates a CDP server account (EOA) as the owner, then creates a
 * Smart Account owned by that EOA. The Smart Account address is what
 * the user sees and receives deposits to.
 *
 * Returns:
 *   address         = Smart Account address (on-chain wallet)
 *   accountRef      = owner EOA account name
 *   smartAccountRef = Smart Account name (for lookup)
 *   iv, tag, salt   = empty (CDP manages keys)
 *
 * Reconstruct a Smart Account object from stored DB data.
 *
 * This retrieves the owner EOA by name, then retrieves or creates the
 * Smart Account. Needed for signing UserOps on behalf of existing users.
 *
 * @param {string} ownerAccountName — The owner EOA account name (from account_ref column)
 * @param {string} [smartAccountName] — The Smart Account name (from smart_account_ref column)
 * @returns {{ owner, smartAccount }} — The CDP account objects
 */
async function getSmartAccountFromRef(ownerAccountName, smartAccountName) {
  const cdp = getCdpClient();
  const owner = await cdp.evm.getOrCreateAccount({ name: ownerAccountName });

  if (smartAccountName) {
    const smartAccount = await cdp.evm.getOrCreateSmartAccount({
      name: smartAccountName,
      owner,
    });
    return { owner, smartAccount };
  }

  // Fallback: if no smart account name stored, this is a legacy EOA-only wallet.
  // Return null for smartAccount — callers should use sendTransaction fallback.
  return { owner, smartAccount: null };
}

/**
 * Legacy function — previously reconstructed a CDP wallet from encrypted data.
 *
 * With the new @coinbase/cdp-sdk, signing is done via Smart Account
 * UserOps or EOA sendTransaction. This function returns null for
 * backward compatibility.
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
  getWalletFromEncrypted,
  getSmartAccountFromRef,
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
