#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

const addr = process.argv[2] || '0xd53cD88a294C222a22AFcc07d171714135e0C966';
const escrow = process.env.ESCROW_CONTRACT_ADDRESS;
const usdcAddr = process.env.USDC_CONTRACT_ADDRESS;

const p = new ethers.JsonRpcProvider('https://sepolia.base.org', { name: 'base-sepolia', chainId: 84532 });
const abi = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
];
const usdc = new ethers.Contract(usdcAddr, abi, p);

(async () => {
  const bal = await usdc.balanceOf(addr);
  const allow = await usdc.allowance(addr, escrow);
  console.log(`Wallet: ${addr}`);
  console.log(`USDC Balance: ${bal.toString()} (${(Number(bal) / 1e6).toFixed(2)} USDC)`);
  console.log(`Escrow Allowance: ${allow.toString()}`);
  console.log(`Escrow Contract: ${escrow}`);
})().catch(console.error);
