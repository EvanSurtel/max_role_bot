// Base transaction service — signs and submits ERC-20 USDC
// transfers and ETH (gas) transfers on Base.
//
// Every transfer function waits for the transaction to be mined
// and returns the confirmed receipt + hash. If the tx reverts or
// fails, it throws — callers are responsible for catching and
// handling (e.g., restoring the user's DB balance on failure).

const { ethers } = require('ethers');
const { getProvider } = require('./connection');
const { USDC_CONTRACT, ERC20_ABI } = require('./walletManager');

/**
 * Transfer USDC (ERC-20) from a signer wallet to a destination address.
 *
 * @param {ethers.Wallet} signer - Connected wallet that holds USDC + ETH for gas
 * @param {string} toAddress - Destination Base/Ethereum address
 * @param {string} amountSmallest - Amount in USDC smallest units (6 decimals)
 * @returns {Promise<{ hash: string, receipt: ethers.TransactionReceipt }>}
 */
async function transferUsdc(signer, toAddress, amountSmallest) {
  const usdc = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, signer);
  const tx = await usdc.transfer(toAddress, amountSmallest);
  const receipt = await tx.wait(); // wait for confirmation
  if (receipt.status !== 1) {
    throw new Error(`USDC transfer reverted: ${tx.hash}`);
  }
  console.log(`[Base] USDC transfer ${amountSmallest} → ${toAddress} confirmed: ${tx.hash}`);
  return { hash: tx.hash, signature: tx.hash, receipt };
}

/**
 * Transfer ETH (for gas subsidies — bot hot wallet → user wallet).
 *
 * @param {ethers.Wallet} signer - Connected wallet that holds ETH
 * @param {string} toAddress - Destination address
 * @param {string} amountWei - Amount in wei
 * @returns {Promise<{ hash: string, receipt: ethers.TransactionReceipt }>}
 */
async function transferEth(signer, toAddress, amountWei) {
  const tx = await signer.sendTransaction({
    to: toAddress,
    value: amountWei,
  });
  const receipt = await tx.wait();
  if (receipt.status !== 1) {
    throw new Error(`ETH transfer reverted: ${tx.hash}`);
  }
  console.log(`[Base] ETH transfer ${amountWei} wei → ${toAddress} confirmed: ${tx.hash}`);
  return { hash: tx.hash, signature: tx.hash, receipt };
}

/**
 * Get a connected signer for the bot's hot wallet (used for escrow
 * operations and gas subsidies). Reads from GAS_FUNDER_PRIVATE_KEY.
 *
 * @returns {ethers.Wallet}
 */
function getHotWalletSigner() {
  const key = process.env.GAS_FUNDER_PRIVATE_KEY;
  if (!key) throw new Error('GAS_FUNDER_PRIVATE_KEY not set');
  return new ethers.Wallet(key, getProvider());
}

module.exports = {
  transferUsdc,
  transferEth,
  // Backward-compat alias — old code calls transferSol
  transferSol: transferEth,
  getHotWalletSigner,
};
