#!/usr/bin/env node
// Convert EC PRIVATE KEY (SEC1) to PRIVATE KEY (PKCS8) format
require('dotenv').config();
const crypto = require('crypto');

const key = process.env.CDP_API_KEY_SECRET;
if (!key) {
  console.error('CDP_API_KEY_SECRET not set');
  process.exit(1);
}

console.log('Input format:', key.includes('BEGIN EC PRIVATE KEY') ? 'SEC1 (EC PRIVATE KEY)' : key.includes('BEGIN PRIVATE KEY') ? 'PKCS8 (already correct)' : 'Unknown');

try {
  const keyObj = crypto.createPrivateKey(key);
  const pkcs8 = keyObj.export({ type: 'pkcs8', format: 'pem' });
  console.log('\nConverted to PKCS8:\n');
  console.log(pkcs8);
  console.log('\nPut this in your .env as CDP_API_KEY_SECRET (in double quotes with real line breaks)');
} catch (err) {
  console.error('Failed to convert:', err.message);

  // If the key is invalid, try the raw JSON format
  console.log('\nThe key may be corrupted. Copy the privateKey value from your downloaded JSON file.');
  console.log('It should look like: -----BEGIN EC PRIVATE KEY-----\\nMHcCAQEE...\\n-----END EC PRIVATE KEY-----');
}
