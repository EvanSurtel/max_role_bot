const xrpl = require('xrpl');
const { encrypt, decrypt } = require('../utils/crypto');
const { getClient } = require('./client');

/**
 * Generate a new XRP wallet.
 * Encrypts the seed for secure storage.
 * @returns {{ address: string, encryptedSeed: string, iv: string, tag: string }}
 */
function generateWallet() {
  const wallet = xrpl.Wallet.generate();
  const { encrypted, iv, tag } = encrypt(wallet.seed);

  return {
    address: wallet.address,
    encryptedSeed: encrypted,
    iv,
    tag,
  };
}

/**
 * Decrypt an encrypted wallet seed.
 * @param {string} encryptedSeed - Hex-encoded encrypted seed.
 * @param {string} iv - Hex-encoded initialization vector.
 * @param {string} tag - Hex-encoded authentication tag.
 * @returns {string} The plaintext seed.
 */
function decryptSeed(encryptedSeed, iv, tag) {
  return decrypt(encryptedSeed, iv, tag);
}

/**
 * Get the XRP balance for an address in drops.
 * Returns '0' for unfunded (AccountNotFound) accounts.
 * @param {string} address - XRP classic address.
 * @returns {Promise<string>} Balance in drops as a string.
 */
async function getBalance(address) {
  const client = getClient();

  try {
    const response = await client.request({
      command: 'account_info',
      account: address,
      ledger_index: 'validated',
    });

    return response.result.account_data.Balance;
  } catch (err) {
    // actNotFound is the error code for unfunded accounts
    if (err.data && err.data.error === 'actNotFound') {
      return '0';
    }
    throw err;
  }
}

/**
 * Decrypt a seed and return a full xrpl.Wallet instance.
 * @param {string} encryptedSeed - Hex-encoded encrypted seed.
 * @param {string} iv - Hex-encoded initialization vector.
 * @param {string} tag - Hex-encoded authentication tag.
 * @returns {xrpl.Wallet}
 */
function getWalletFromSeed(encryptedSeed, iv, tag) {
  const seed = decryptSeed(encryptedSeed, iv, tag);
  return xrpl.Wallet.fromSeed(seed);
}

/**
 * Validate an XRP classic address format.
 * @param {string} address - Address to validate.
 * @returns {boolean}
 */
function isAddressValid(address) {
  return xrpl.isValidClassicAddress(address);
}

module.exports = {
  generateWallet,
  decryptSeed,
  getBalance,
  getWalletFromSeed,
  isAddressValid,
};
