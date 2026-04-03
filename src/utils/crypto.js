const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM recommended IV length
const SALT_LENGTH = 16;

/**
 * Get the master encryption key from environment.
 * Must be a 32-byte (64 hex character) string.
 */
function getMasterKey() {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * Derive a per-user encryption key using HKDF.
 * @param {Buffer} salt - 16-byte random salt unique to this user.
 * @returns {Buffer} 32-byte derived key.
 */
function deriveKey(salt) {
  const masterKey = getMasterKey();
  return crypto.hkdfSync('sha256', masterKey, salt, 'wallet-encryption', 32);
}

/**
 * Generate a random salt for a new user.
 * @returns {string} Hex-encoded 16-byte salt.
 */
function generateSalt() {
  return crypto.randomBytes(SALT_LENGTH).toString('hex');
}

/**
 * Encrypt plaintext using AES-256-GCM with a per-user derived key.
 * @param {string} text - The plaintext to encrypt.
 * @param {string} [saltHex] - Hex-encoded salt. If omitted, uses master key directly (legacy).
 * @returns {{ encrypted: string, iv: string, tag: string }} All values as hex strings.
 */
function encrypt(text, saltHex) {
  const key = saltHex ? deriveKey(Buffer.from(saltHex, 'hex')) : getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Decrypt ciphertext using AES-256-GCM.
 * @param {string} encrypted - Hex-encoded ciphertext.
 * @param {string} iv - Hex-encoded initialization vector.
 * @param {string} tag - Hex-encoded authentication tag.
 * @param {string} [saltHex] - Hex-encoded salt. If omitted, uses master key directly (legacy).
 * @returns {string} The decrypted plaintext.
 */
function decrypt(encrypted, iv, tag, saltHex) {
  const key = saltHex ? deriveKey(Buffer.from(saltHex, 'hex')) : getMasterKey();
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

module.exports = { encrypt, decrypt, generateSalt };
