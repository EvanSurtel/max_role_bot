#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

const p = new ethers.JsonRpcProvider('https://sepolia.base.org', { name: 'base-sepolia', chainId: 84532 });
const escrow = new ethers.Contract(
  process.env.ESCROW_CONTRACT_ADDRESS,
  [
    'function owner() view returns (address)',
    'function matches(uint256) view returns (uint256,uint8,uint8,uint256,bool,bool)',
  ],
  p,
);

(async () => {
  const owner = await escrow.owner();
  console.log('Contract owner:', owner);
  console.log('CDP_OWNER_ADDRESS:', process.env.CDP_OWNER_ADDRESS);
  console.log('Match?', owner.toLowerCase() === process.env.CDP_OWNER_ADDRESS?.toLowerCase() ? 'YES' : 'NO — MISMATCH!');

  // Check match IDs 1-15
  for (let i = 1; i <= 15; i++) {
    try {
      const m = await escrow.matches(i);
      if (m[0] > 0n) {
        console.log(`Match #${i}: entry=${m[0]} players=${m[1]} deposits=${m[2]} total=${m[3]} resolved=${m[4]} cancelled=${m[5]}`);
      }
    } catch { /* */ }
  }
})().catch(console.error);
