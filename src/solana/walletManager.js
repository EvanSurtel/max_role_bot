const { Keypair, PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
const { encrypt, decrypt, generateSalt } = require('../utils/crypto');
const { getConnection } = require('./connection');
const { USDC_MINT_MAINNET, USDC_MINT_DEVNET } = require('../config/constants');

/**
 * Get the USDC mint public key based on network config.
 * Defaults to mainnet-beta — match the default in connection.js.
 * @returns {PublicKey}
 */
function getUsdcMint() {
  const network = (process.env.SOLANA_NETWORK || 'mainnet-beta').toLowerCase();
  const mint = (network === 'mainnet-beta' || network === 'mainnet')
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

// Known Solana addresses that pass `isOnCurve` but are NOT valid
// withdrawal destinations. Sending USDC to any of these is an
// irreversible loss of funds. This list is explicit because
// `PublicKey.isOnCurve` returns true for all of them.
const BLOCKED_WITHDRAW_DESTINATIONS = new Set([
  '11111111111111111111111111111111',              // System Program
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',    // SPL Token program
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',    // Associated Token program
  'ComputeBudget111111111111111111111111111111',    // Compute Budget program
  // The USDC mint itself — if a user pastes the mint address
  // thinking it's a wallet, their USDC goes to an unrecoverable
  // address.
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',    // USDC mainnet mint
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',    // USDC devnet mint
  // Wrapped SOL mint — another common foot-gun paste target
  'So11111111111111111111111111111111111111112',
]);

/**
 * Validate a Solana public key address as a SAFE withdrawal destination.
 *
 * Three checks:
 *   1. Parses as a valid base58 public key.
 *   2. Point is on the ed25519 curve (so SPL transfers can actually
 *      reach an account owned by this pubkey — PDAs and curve-off
 *      addresses can't receive token transfers the normal way).
 *   3. Not on the explicit blocklist of system/mint/program addresses
 *      that would permanently lose the user's funds.
 *
 * ALSO blocks the bot's own escrow wallet address so a user can't
 * accidentally (or maliciously) send their withdraw into the escrow —
 * that flow has no matching credit path on the escrow side and would
 * corrupt accounting.
 *
 * @param {string} address - Address to validate.
 * @returns {boolean}
 */
function isAddressValid(address) {
  try {
    new PublicKey(address);
    if (!PublicKey.isOnCurve(address)) return false;
    if (BLOCKED_WITHDRAW_DESTINATIONS.has(address)) return false;
    // Block the bot's own escrow address. Look it up fresh each call
    // so an env var swap takes effect without a restart. If the env
    // var is unset or malformed, we skip this check rather than
    // throwing (the Solana connection layer will fail loudly on the
    // actual submit anyway).
    try {
      const escrowSecret = process.env.ESCROW_WALLET_SECRET;
      if (escrowSecret) {
        const { Keypair } = require('@solana/web3.js');
        const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(escrowSecret)));
        if (kp.publicKey.toBase58() === address) return false;
      }
    } catch { /* env var missing or malformed — skip escrow check */ }
    return true;
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
