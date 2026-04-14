#!/usr/bin/env node
require('dotenv').config();
const { CdpClient } = require('@coinbase/cdp-sdk');

async function main() {
  console.log('[OwnerWallet] Creating owner account...');

  const cdp = new CdpClient();
  const network = (process.env.BASE_NETWORK || 'mainnet').toLowerCase();
  const cdpNetwork = network === 'sepolia' ? 'base-sepolia' : 'base';

  // Create a named account — idempotent, so re-running is safe
  const account = await cdp.evm.getOrCreateAccount({ name: 'escrow-owner' });

  console.log();
  console.log('═'.repeat(60));
  console.log(`[OwnerWallet] Done! Owner address: ${account.address}`);
  console.log();
  console.log('Add this to your .env:');
  console.log(`  CDP_OWNER_ADDRESS=${account.address}`);
  console.log();
  console.log('This account will need to be set as the owner of the');
  console.log('escrow contract (it is by default if it deploys the contract).');
  console.log('═'.repeat(60));
}

main().catch(err => {
  console.error('[OwnerWallet] FATAL:', err);
  process.exit(1);
});
