const {
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  createTransferInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} = require('@solana/spl-token');
const { getConnection } = require('./connection');
const { getUsdcMint } = require('./walletManager');

/**
 * Ensure an Associated Token Account exists for a given owner.
 * Creates it (funded by payer) if it doesn't exist.
 * @param {import('@solana/web3.js').Keypair} payer - The fee payer.
 * @param {PublicKey} owner - The token account owner.
 * @returns {Promise<PublicKey>} The ATA address.
 */
async function ensureAta(payer, owner) {
  const connection = getConnection();
  const usdcMint = getUsdcMint();
  const ata = await getAssociatedTokenAddress(usdcMint, owner);

  try {
    await getAccount(connection, ata);
    return ata;
  } catch {
    // ATA doesn't exist — create it
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        owner,
        usdcMint,
      ),
    );
    await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log(`[Solana] Created ATA ${ata.toBase58()} for ${owner.toBase58()}`);
    return ata;
  }
}

/**
 * Transfer USDC from one wallet to another.
 * @param {import('@solana/web3.js').Keypair} fromKeypair - The sender's keypair (signs the tx).
 * @param {string} toAddress - The recipient's Solana address (base58).
 * @param {string|number} amountUsdc - Amount in USDC smallest units.
 * @returns {Promise<{ signature: string }>}
 */
async function transferUsdc(fromKeypair, toAddress, amountUsdc) {
  const connection = getConnection();
  const usdcMint = getUsdcMint();
  const toPublicKey = new PublicKey(toAddress);
  const amount = BigInt(amountUsdc);

  // Get or create ATAs
  const fromAta = await getAssociatedTokenAddress(usdcMint, fromKeypair.publicKey);
  const toAta = await ensureAta(fromKeypair, toPublicKey);

  const tx = new Transaction().add(
    createTransferInstruction(fromAta, toAta, fromKeypair.publicKey, amount),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [fromKeypair]);
  return { signature };
}

/**
 * Transfer SOL from one wallet to another.
 * @param {import('@solana/web3.js').Keypair} fromKeypair - The sender's keypair.
 * @param {string} toAddress - The recipient's Solana address (base58).
 * @param {number} lamports - Amount in lamports.
 * @returns {Promise<{ signature: string }>}
 */
async function transferSol(fromKeypair, toAddress, lamports) {
  const connection = getConnection();
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: new PublicKey(toAddress),
      lamports,
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [fromKeypair]);
  return { signature };
}

/**
 * Get recent transaction signatures for an address.
 * @param {string} address - Solana address (base58).
 * @param {number} [limit=20] - Max signatures to return.
 * @returns {Promise<object[]>}
 */
async function getRecentSignatures(address, limit = 20) {
  const connection = getConnection();
  return connection.getSignaturesForAddress(new PublicKey(address), { limit });
}

module.exports = {
  ensureAta,
  transferUsdc,
  transferSol,
  getRecentSignatures,
};
