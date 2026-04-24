#!/usr/bin/env node
// Rotate the WagerEscrow admin role from the current holder to a new
// address — typically used when migrating from the bring-up admin
// (escrow-owner-smart itself) to the production multisig Safe.
//
// Must be called FROM the current admin. During bring-up, that's
// escrow-owner-smart — so the bot can do it via the usual Paymaster-
// sponsored UserOp path. After this runs, escrow-owner-smart retains
// matchOperator (day-to-day authority) but loses emergencyWithdraw /
// setMatchOperator / transferAdmin — those all require the Safe to
// co-sign now.
//
// Usage:
//   SAFE_ADMIN_ADDRESS=0xYourSafeHere node scripts/transfer-admin-to-safe.js
//
// Or pass on the command line:
//   node scripts/transfer-admin-to-safe.js 0xYourSafeHere

require('dotenv').config();
const { ethers } = require('ethers');
const { CdpClient } = require('@coinbase/cdp-sdk');
const transactionService = require('../src/base/transactionService');
const { getProvider } = require('../src/base/connection');

async function main() {
  const newAdmin = (process.argv[2] || process.env.SAFE_ADMIN_ADDRESS || '').trim();
  if (!newAdmin || !ethers.isAddress(newAdmin)) {
    console.error('Usage: node scripts/transfer-admin-to-safe.js <safe address>');
    console.error('   or: SAFE_ADMIN_ADDRESS=<safe address> node scripts/transfer-admin-to-safe.js');
    process.exit(2);
  }

  const escrow = process.env.ESCROW_CONTRACT_ADDRESS;
  if (!escrow) throw new Error('ESCROW_CONTRACT_ADDRESS must be set in .env');

  // Read current state
  const provider = getProvider();
  const abi = [
    'function admin() view returns (address)',
    'function matchOperator() view returns (address)',
    'function transferAdmin(address)',
  ];
  const contract = new ethers.Contract(escrow, abi, provider);

  const [currentAdmin, currentOperator] = await Promise.all([
    contract.admin(),
    contract.matchOperator(),
  ]);
  console.log(`[TransferAdmin] WagerEscrow:    ${escrow}`);
  console.log(`[TransferAdmin] matchOperator:  ${currentOperator}`);
  console.log(`[TransferAdmin] current admin:  ${currentAdmin}`);
  console.log(`[TransferAdmin] target admin:   ${newAdmin}`);

  if (currentAdmin.toLowerCase() === newAdmin.toLowerCase()) {
    console.log('[TransferAdmin] admin already points at target — no-op.');
    return;
  }

  // The caller of transferAdmin MUST be the current admin. During
  // bring-up that's escrow-owner-smart; we submit the UserOp via
  // the same _sendOwnerTx path the match flow uses.
  const cdpOwner = (process.env.CDP_OWNER_ADDRESS || '').toLowerCase();
  if (currentAdmin.toLowerCase() !== cdpOwner) {
    console.error(
      `[TransferAdmin] FATAL: current on-chain admin ${currentAdmin} is not ` +
      `escrow-owner-smart (${cdpOwner}). This script can only be used during ` +
      `bring-up, when admin is still the bot's Smart Account. To rotate from ` +
      `a Safe to another Safe, execute transferAdmin() via the Safe's own UI.`,
    );
    process.exit(3);
  }

  const iface = new ethers.Interface(['function transferAdmin(address newAdmin)']);
  const data = iface.encodeFunctionData('transferAdmin', [newAdmin]);

  console.log('[TransferAdmin] Submitting UserOp via Paymaster…');
  const hash = await transactionService._sendOwnerTx(escrow, data);
  console.log(`[TransferAdmin] tx: ${hash}`);

  // Verify the change landed
  const verifiedAdmin = await contract.admin();
  if (verifiedAdmin.toLowerCase() !== newAdmin.toLowerCase()) {
    console.error(
      `[TransferAdmin] WARNING: tx submitted but admin on-chain is still ` +
      `${verifiedAdmin} instead of ${newAdmin}. Check the tx on BaseScan.`,
    );
    process.exit(4);
  }
  console.log(`[TransferAdmin] ✅ admin rotated to ${newAdmin}`);
  console.log();
  console.log('From now on emergencyWithdraw, setMatchOperator, and transferAdmin');
  console.log('can ONLY be called by the Safe — the bot keeps matchOperator for');
  console.log('routine match flow (createMatch/depositFromSpender/resolveMatch/cancelMatch).');
}

main().catch((err) => {
  console.error('[TransferAdmin] FATAL:', err);
  process.exit(1);
});
