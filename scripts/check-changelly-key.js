#!/usr/bin/env node
/* eslint-disable no-console */
// Inspect the CHANGELLY_FIAT_API_SECRET value and tell you what
// format it's in, whether the bot can parse it, and print a
// ready-to-paste base64-encoded version for your .env.
//
// Usage:
//   node scripts/check-changelly-key.js
//
// The bot itself now accepts all of these formats at runtime
// (PKCS#1, PKCS#8, raw PEM, base64-encoded PEM, newlines as \n
// or actual) — but this script exists if you want to verify
// the value before launch, or normalize it to a single canonical
// form for your .env file.

require('dotenv').config();
const crypto = require('crypto');

function main() {
  const raw = process.env.CHANGELLY_FIAT_API_SECRET || '';
  if (!raw) {
    console.error('❌ CHANGELLY_FIAT_API_SECRET is not set in .env');
    process.exit(1);
  }

  console.log('─'.repeat(70));
  console.log('Input analysis');
  console.log('─'.repeat(70));
  console.log(`Length: ${raw.length} characters`);
  console.log(`Starts with: ${JSON.stringify(raw.slice(0, 30))}${raw.length > 30 ? '…' : ''}`);
  console.log(`Contains "-----BEGIN": ${raw.includes('-----BEGIN')}`);
  console.log(`Contains actual newlines: ${raw.includes('\n')}`);
  console.log(`Contains literal \\n: ${raw.includes('\\n')}`);
  console.log('');

  // Try to decode it progressively and figure out what we have.
  let pem = raw.trim();
  let base64Decoded = false;
  if (!pem.includes('-----BEGIN')) {
    try {
      const decoded = Buffer.from(pem, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN')) {
        pem = decoded;
        base64Decoded = true;
      }
    } catch { /* */ }
  }

  if (pem.includes('\\n') && !pem.includes('\n-----END')) {
    pem = pem.replace(/\\n/g, '\n');
  }

  if (!pem.includes('-----BEGIN')) {
    console.error('❌ FAIL — value does not decode to a PEM key.');
    console.error('   Check that you pasted the full private key Changelly gave you,');
    console.error('   either as raw PEM (multi-line) or single-line base64.');
    process.exit(1);
  }

  const isPkcs1 = pem.includes('-----BEGIN RSA PRIVATE KEY-----');
  const isPkcs8 = pem.includes('-----BEGIN PRIVATE KEY-----');
  const isEncrypted = pem.includes('-----BEGIN ENCRYPTED');

  console.log('─'.repeat(70));
  console.log('Key format');
  console.log('─'.repeat(70));
  console.log(`Was input base64-encoded? ${base64Decoded ? 'yes (decoded)' : 'no (already PEM)'}`);
  console.log(`Detected format: ${isPkcs1 ? 'PKCS#1 (BEGIN RSA PRIVATE KEY)' : isPkcs8 ? 'PKCS#8 (BEGIN PRIVATE KEY)' : isEncrypted ? 'ENCRYPTED (not supported — remove password)' : 'unknown'}`);
  console.log('');

  if (isEncrypted) {
    console.error('❌ Key is password-protected. Changelly API keys should NOT be encrypted.');
    console.error('   Re-export from Changelly without a passphrase.');
    process.exit(1);
  }

  let keyObj;
  try {
    keyObj = crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch (err) {
    console.error(`❌ Node rejected the key: ${err.message}`);
    console.error('   The PEM is malformed or unsupported.');
    process.exit(1);
  }

  console.log('─'.repeat(70));
  console.log('Key validation');
  console.log('─'.repeat(70));
  console.log(`Algorithm: ${keyObj.asymmetricKeyType}`);
  console.log(`Key size: ${keyObj.asymmetricKeyDetails?.modulusLength || '?'} bits`);
  console.log('');

  if (keyObj.asymmetricKeyType !== 'rsa') {
    console.error(`❌ Expected RSA, got ${keyObj.asymmetricKeyType}. Changelly requires RSA keys.`);
    process.exit(1);
  }

  // Test signing — this is what the bot does on every request.
  const testPayload = 'https://fiat-api.changelly.com/v1/test{}';
  try {
    const sig = crypto.sign('sha256', Buffer.from(testPayload), keyObj).toString('base64');
    console.log(`✅ Test SHA256 sign succeeded. Signature preview: ${sig.slice(0, 20)}…`);
  } catch (err) {
    console.error(`❌ Signing failed: ${err.message}`);
    process.exit(1);
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log('Canonical form for .env (copy-paste ready)');
  console.log('─'.repeat(70));

  // Re-export the key as PKCS#8 (modern standard) and base64-encode
  // the whole PEM so it fits on a single .env line.
  const pkcs8Pem = keyObj.export({ type: 'pkcs8', format: 'pem' });
  const base64 = Buffer.from(pkcs8Pem).toString('base64');

  console.log('');
  console.log('Option 1 — single-line base64 (recommended — no newline issues):');
  console.log('');
  console.log(`CHANGELLY_FIAT_API_SECRET=${base64}`);
  console.log('');
  console.log('Option 2 — literal PEM with \\n escapes (if your .env editor supports it):');
  console.log('');
  const escaped = pkcs8Pem.trim().replace(/\n/g, '\\n');
  console.log(`CHANGELLY_FIAT_API_SECRET="${escaped}"`);
  console.log('');
  console.log('Either form works. The bot auto-detects at runtime. Paste whichever');
  console.log('you prefer into your .env.');
}

main();
