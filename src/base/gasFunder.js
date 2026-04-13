// Gas funder — automatically sends ETH to user wallets that need gas.
//
// Every on-chain action (approve, withdrawal, etc.) requires the user's
// wallet to have a small ETH balance on Base for gas (~$0.01-0.05 per tx).
// This module checks the user's ETH balance before any action and sends
// a small top-up from the gas funder wallet if they're below threshold.
//
// The gas funder wallet is an operational wallet that ONLY holds ETH.
// It does NOT hold user USDC. The private key is in GAS_FUNDER_PRIVATE_KEY.

const { ethers } = require('ethers');
const { getProvider } = require('./connection');
const walletManager = require('./walletManager');
const walletRepo = require('../database/repositories/walletRepo');

// If a user has less than this, send them a top-up
const MIN_ETH_WEI = ethers.parseEther('0.00005'); // ~$0.12 at $2500/ETH

// Amount to send when topping up — enough for ~200 Base transactions
const TOPUP_AMOUNT_WEI = ethers.parseEther('0.0005'); // ~$1.25

function _getGasFunderSigner() {
  const key = process.env.GAS_FUNDER_PRIVATE_KEY;
  if (!key) return null;
  return new ethers.Wallet(key, getProvider());
}

/**
 * Check if a user's wallet has enough ETH for gas. If not, send a
 * small top-up from the gas funder wallet. Returns true if the user
 * now has enough gas (either they already had it or the top-up worked).
 *
 * Silent on errors — returns false if the top-up fails so the caller
 * can show a user-friendly message instead of crashing.
 */
async function ensureGas(userId) {
  try {
    const wallet = walletRepo.findByUserId(userId);
    if (!wallet) return false;

    const ethBal = BigInt(await walletManager.getEthBalance(wallet.solana_address));
    if (ethBal >= MIN_ETH_WEI) return true; // already has enough

    const funder = _getGasFunderSigner();
    if (!funder) {
      console.warn('[GasFunder] GAS_FUNDER_PRIVATE_KEY not set — cannot top up');
      return false;
    }

    // Check funder has enough to send
    const funderBal = await getProvider().getBalance(funder.address);
    if (funderBal < TOPUP_AMOUNT_WEI + ethers.parseEther('0.0001')) {
      console.error('[GasFunder] Gas funder wallet is low on ETH!');
      return false;
    }

    const tx = await funder.sendTransaction({
      to: wallet.solana_address, // legacy column name, stores Base address
      value: TOPUP_AMOUNT_WEI,
    });
    await tx.wait();

    console.log(`[GasFunder] Sent ${ethers.formatEther(TOPUP_AMOUNT_WEI)} ETH to user ${userId} (${wallet.solana_address}). TX: ${tx.hash}`);

    // Log to transaction feed
    try {
      const { postTransaction } = require('../utils/transactionFeed');
      const userRepo = require('../database/repositories/userRepo');
      const user = userRepo.findById(userId);
      postTransaction({
        type: 'gas_contribution',
        username: user?.server_username,
        discordId: user?.discord_id,
        amount: ethers.formatEther(TOPUP_AMOUNT_WEI),
        currency: 'ETH',
        fromAddress: funder.address,
        toAddress: wallet.solana_address,
        signature: tx.hash,
        memo: `Auto gas top-up for user ${userId}`,
      });
    } catch { /* non-fatal */ }

    return true;
  } catch (err) {
    console.error(`[GasFunder] Failed to top up user ${userId}:`, err.message);
    return false;
  }
}

/**
 * Get the gas funder's address and ETH balance (for the admin panel).
 */
async function getFunderStatus() {
  const funder = _getGasFunderSigner();
  if (!funder) return { address: null, balance: '0' };
  const balance = await getProvider().getBalance(funder.address);
  return {
    address: funder.address,
    balance: ethers.formatEther(balance),
  };
}

module.exports = { ensureGas, getFunderStatus, MIN_ETH_WEI, TOPUP_AMOUNT_WEI };
