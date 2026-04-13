const { getSolBalance } = require('../base/walletManager');
const { MIN_SOL_FOR_GAS, LAMPORTS_PER_SOL } = require('../config/constants');

/**
 * Check if a wallet has enough SOL for gas fees.
 * @param {string} address - Solana address (base58).
 * @returns {Promise<{ ok: boolean, balance: string, required: string }>}
 */
async function checkSolForGas(address) {
  const balance = BigInt(await getSolBalance(address));
  const required = BigInt(MIN_SOL_FOR_GAS);
  const ok = balance >= required;
  return {
    ok,
    balance: (Number(balance) / LAMPORTS_PER_SOL).toFixed(4),
    required: (Number(required) / LAMPORTS_PER_SOL).toFixed(4),
  };
}

/**
 * Returns an error message if SOL is insufficient, or null if ok.
 */
async function requireSolForGas(address) {
  const { ok, balance, required } = await checkSolForGas(address);
  if (!ok) {
    return `You need at least ${required} SOL for transaction fees. Your SOL balance: ${balance} SOL`;
  }
  return null;
}

module.exports = { checkSolForGas, requireSolForGas };
