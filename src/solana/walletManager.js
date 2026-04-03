const { Keypair, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const { encrypt, decrypt, generateSalt } = require('../utils/crypto');
const { getConnection } = require('./connection');
const { USDC_MINT_MAINNET, USDC_MINT_DEVNET } = require('../config/constants');

/**
 * Get the USDC mint public key based on network config.
 * @returns {PublicKey}
 */
function getUsdcMint() {
  const network = (process.env.SOLANA_NETWORK || 'devnet').toLowerCase();
  const mint = network === 'mainnet-beta' || network === 'mainnet'
    ? USDC_MINT_MAINNET
    : (process.env.USDC_MINT_ADDRESS || USDC_MINT_DEVNET);
  return new PublicKey(mint);
}

/**
 * Generate a new Solana wallet (keypair).
 * Encrypts the secret key for secure storage.
 * @returns {{ address: string, encryptedPrivateKey: string, iv: string, tag: string }}
 */
function generateWallet() {
  const keypair = Keypair.generate();
  const secretKeyBase64 = Buffer.from(keypair.secretKey).toString('base64');
  const salt = generateSalt();
  const { encrypted, iv, tag } = encrypt(secretKeyBase64, salt);

  return {
    address: keypair.publicKey.toBase58(),
    encryptedPrivateKey: encrypted,
    iv,
    tag,
    salt,
  };
}

/**
 * Decrypt an encrypted private key and return a Keypair.
 * @param {string} encryptedPrivateKey - Hex-encoded encrypted secret key.
 * @param {string} iv - Hex-encoded initialization vector.
 * @param {string} tag - Hex-encoded authentication tag.
 * @returns {Keypair}
 */
function getKeypairFromEncrypted(encryptedPrivateKey, iv, tag, salt) {
  const secretKeyBase64 = decrypt(encryptedPrivateKey, iv, tag, salt || undefined);
  const secretKey = Buffer.from(secretKeyBase64, 'base64');
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

/**
 * Get the USDC balance for a wallet address (in smallest units).
 * Returns '0' if the token account doesn't exist.
 * @param {string} address - Solana public key (base58).
 * @returns {Promise<string>} USDC balance in smallest units as a string.
 */
async function getUsdcBalance(address) {
  const connection = getConnection();
  const owner = new PublicKey(address);
  const usdcMint = getUsdcMint();

  try {
    const ata = await getAssociatedTokenAddress(usdcMint, owner);
    const account = await getAccount(connection, ata);
    return account.amount.toString();
  } catch (err) {
    // TokenAccountNotFoundError or AccountNotFoundError
    if (err.name === 'TokenAccountNotFoundError' || err.message?.includes('could not find account')) {
      return '0';
    }
    throw err;
  }
}

/**
 * Get the SOL balance for a wallet address (in lamports).
 * @param {string} address - Solana public key (base58).
 * @returns {Promise<string>} SOL balance in lamports as a string.
 */
async function getSolBalance(address) {
  const connection = getConnection();
  const pubkey = new PublicKey(address);
  const balance = await connection.getBalance(pubkey);
  return balance.toString();
}

/**
 * Validate a Solana public key address.
 * @param {string} address - Address to validate.
 * @returns {boolean}
 */
function isAddressValid(address) {
  try {
    new PublicKey(address);
    return PublicKey.isOnCurve(address);
  } catch {
    return false;
  }
}

module.exports = {
  getUsdcMint,
  generateWallet,
  getKeypairFromEncrypted,
  getUsdcBalance,
  getSolBalance,
  isAddressValid,
};
