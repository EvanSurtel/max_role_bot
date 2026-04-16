#!/usr/bin/env node
// Create the CDP accounts that own / operate the escrow contract.
//
// Creates TWO linked accounts:
//
//   1. EOA  `escrow-owner`
//      Holds the signing key. Used ONCE during contract deployment
//      (and transferOwnership), then never signs another tx.
//      Needs a tiny one-time ETH top-up (~$0.50) for that single
//      deploy transaction. After that, zero ongoing cost.
//
//   2. Smart Account `escrow-owner-smart` (owned by the EOA above)
//      The on-chain owner of the WagerEscrow contract after deploy.
//      Every admin call — createMatch, depositToEscrow, resolveMatch,
//      cancelMatch — goes through this Smart Account via a UserOp.
//      CDP Paymaster sponsors the gas. NEVER needs ETH.
//
// Put the SMART ACCOUNT address in .env as CDP_OWNER_ADDRESS. That's
// what the contract's Ownable module sees as `owner()` after the
// deploy script transfers ownership.

require('dotenv').config();
const { CdpClient } = require('@coinbase/cdp-sdk');

async function main() {
  console.log('[OwnerWallet] Creating owner EOA + Smart Account...');

  const cdp = new CdpClient();

  // 1. EOA signer (one-time deploy only)
  const owner = await cdp.evm.getOrCreateAccount({ name: 'escrow-owner' });

  // 2. Smart Account (ongoing owner — all admin calls gasless via Paymaster)
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: 'escrow-owner-smart',
    owner,
  });

  console.log();
  console.log('═'.repeat(72));
  console.log('[OwnerWallet] Done.');
  console.log();
  console.log('EOA (signs one-time deployment, needs a tiny amount of ETH ONCE):');
  console.log(`  ${owner.address}`);
  console.log();
  console.log('Smart Account (on-chain contract owner after deploy, GASLESS forever):');
  console.log(`  ${smartAccount.address}`);
  console.log();
  console.log('─'.repeat(72));
  console.log('Next steps:');
  console.log('─'.repeat(72));
  console.log(`1. Send ~$0.50 of ETH on Base mainnet to the EOA:`);
  console.log(`     ${owner.address}`);
  console.log(`   (this is the ONE AND ONLY time the EOA ever needs funding)`);
  console.log();
  console.log(`2. Run: node scripts/deploy-escrow.js`);
  console.log(`   Deploys WagerEscrow, then transfers ownership to the Smart Account.`);
  console.log();
  console.log(`3. Put this in your .env (Smart Account address, NOT the EOA):`);
  console.log(`     CDP_OWNER_ADDRESS=${smartAccount.address}`);
  console.log();
  console.log('After step 3, every createMatch / resolveMatch / cancelMatch call');
  console.log('routes through the Smart Account via CDP Paymaster. No more ETH needed.');
  console.log('═'.repeat(72));
}

main().catch(err => {
  console.error('[OwnerWallet] FATAL:', err);
  process.exit(1);
});
