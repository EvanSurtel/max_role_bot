// Gas balance check for Base (ETH).
// Legacy name "solCheck" kept for import compatibility.

const { getEthBalance } = require('../base/walletManager');
const { ethers } = require('ethers');

// Minimum ETH needed for one ERC-20 transfer on Base (~$0.05)
const MIN_ETH_WEI = 50_000_000_000_000n; // 0.00005 ETH

/**
 * Check if a wallet has enough ETH on Base for gas fees.
 * @param {string} address - Base/Ethereum address.
 * @returns {Promise<{ ok: boolean, balance: string, required: string }>}
 */
async function checkSolForGas(address) {
  const balance = BigInt(await getEthBalance(address));
  const ok = balance >= MIN_ETH_WEI;
  return {
    ok,
    balance: ethers.formatEther(balance),
    required: ethers.formatEther(MIN_ETH_WEI),
  };
}

/**
 * Returns an error message if ETH is insufficient, or null if ok.
 */
async function requireSolForGas(address) {
  const { ok, balance, required } = await checkSolForGas(address);
  if (!ok) {
    return `You need at least ${required} ETH on Base for transaction fees. Your ETH balance: ${balance} ETH`;
  }
  return null;
}

module.exports = { checkSolForGas, requireSolForGas };
