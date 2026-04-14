#!/usr/bin/env node
// Create the owner CDP wallet for escrow contract admin calls.
//
// This wallet signs createMatch, resolveMatch, cancelMatch on the
// escrow contract. Run once, then paste the output into your .env
// as CDP_OWNER_WALLET_DATA.
//
// Usage:
//   node scripts/create-owner-wallet.js
//
// Prerequisites:
//   - CDP_API_KEY_NAME and CDP_API_KEY_SECRET set in .env

require('dotenv').config();
const { Coinbase, Wallet } = require('@coinbase/coinbase-sdk');

async function main() {
  const apiKeyName = process.env.CDP_API_KEY_NAME;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;

  if (!apiKeyName || !apiKeySecret) {
    console.error('CDP_API_KEY_NAME and CDP_API_KEY_SECRET must be set in .env');
    process.exit(1);
  }

  Coinbase.configure({ apiKeyName, privateKey: apiKeySecret });

  const network = (process.env.BASE_NETWORK || 'mainnet').toLowerCase();
  const networkId = network === 'sepolia' ? 'base-sepolia' : 'base-mainnet';

  console.log(`[OwnerWallet] Creating owner wallet on ${networkId}...`);
  const wallet = await Wallet.create({ networkId });

  const defaultAddress = await wallet.getDefaultAddress();
  const address = defaultAddress.getId();
  console.log(`[OwnerWallet] Address: ${address}`);

  const walletData = wallet.export();
  const walletDataJson = JSON.stringify(walletData);

  console.log();
  console.log('═'.repeat(60));
  console.log('[OwnerWallet] Done! Add this to your .env:');
  console.log();
  console.log(`CDP_OWNER_WALLET_DATA=${walletDataJson}`);
  console.log();
  console.log(`Owner wallet address: ${address}`);
  console.log('This wallet will need to be set as the owner of the');
  console.log('escrow contract (it is by default if it deploys the contract).');
  console.log('═'.repeat(60));
}

main().catch(err => {
  console.error('[OwnerWallet] FATAL:', err);
  process.exit(1);
});
