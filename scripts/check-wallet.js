#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

const escrow = process.env.ESCROW_CONTRACT_ADDRESS;
const usdcAddr = process.env.USDC_CONTRACT_ADDRESS;

const p = new ethers.JsonRpcProvider('https://sepolia.base.org', { name: 'base-sepolia', chainId: 84532 });
const abi = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
];
const usdc = new ethers.Contract(usdcAddr, abi, p);
const db = require('../src/database/db');

(async () => {
  const wallets = db.prepare('SELECT w.*, u.server_username, u.discord_id FROM wallets w JOIN users u ON u.id = w.user_id').all();
  console.log(`Escrow: ${escrow}\nUSDC: ${usdcAddr}\n`);
  for (const w of wallets) {
    const bal = await usdc.balanceOf(w.address);
    const allow = await usdc.allowance(w.address, escrow);
    console.log(`${w.server_username} (${w.discord_id})`);
    console.log(`  Address: ${w.address}`);
    console.log(`  USDC: ${(Number(bal) / 1e6).toFixed(2)} | Allowance: ${allow > 0n ? 'OK' : 'NONE'}`);
    console.log(`  DB balance: ${(Number(w.balance_available) / 1e6).toFixed(2)} avail / ${(Number(w.balance_held) / 1e6).toFixed(2)} held`);
    console.log('');
  }
})().catch(console.error);
