#!/usr/bin/env node
// Test the exact createMatch call to see the revert reason
require('dotenv').config();
const { ethers } = require('ethers');
const { CdpClient } = require('@coinbase/cdp-sdk');

(async () => {
  const cdp = new CdpClient();
  const owner = await cdp.evm.getOrCreateAccount({ name: 'escrow-owner' });
  console.log('Owner:', owner.address);

  // Check owner ETH balance
  const p = new ethers.JsonRpcProvider('https://sepolia.base.org', { name: 'base-sepolia', chainId: 84532 });
  const ethBal = await p.getBalance(owner.address);
  console.log('Owner ETH:', ethers.formatEther(ethBal));

  // Try a static call first to get the revert reason
  const escrowAddr = process.env.ESCROW_CONTRACT_ADDRESS;
  const abi = [
    'function createMatch(uint256 matchId, uint256 entryAmount, uint8 playerCount)',
    'function owner() view returns (address)',
    'function matches(uint256) view returns (uint256,uint8,uint8,uint256,bool,bool)',
  ];
  const escrow = new ethers.Contract(escrowAddr, abi, p);

  // Check contract owner
  const contractOwner = await escrow.owner();
  console.log('Contract owner:', contractOwner);
  console.log('Match?', contractOwner.toLowerCase() === owner.address.toLowerCase());

  // Check if match 16 exists
  const m = await escrow.matches(16);
  console.log('Match #16 on-chain:', m[0] > 0n ? `exists (entry=${m[0]})` : 'does not exist');

  // Try static call with the owner's key
  const pk = await cdp.evm.exportAccount({ address: owner.address });
  const wallet = new ethers.Wallet(pk, p);
  const escrowWithSigner = escrow.connect(wallet);

  console.log('\nTrying createMatch(16, 2000000, 2) via static call...');
  try {
    await escrowWithSigner.createMatch.staticCall(16, 2000000, 2);
    console.log('Static call succeeded — transaction would work');
  } catch (err) {
    console.error('Static call REVERTED:', err.reason || err.message);
  }

  // Also try with a fresh match ID
  console.log('\nTrying createMatch(999, 2000000, 2) via static call...');
  try {
    await escrowWithSigner.createMatch.staticCall(999, 2000000, 2);
    console.log('Static call succeeded — transaction would work');
  } catch (err) {
    console.error('Static call REVERTED:', err.reason || err.message);
  }
})().catch(console.error);
