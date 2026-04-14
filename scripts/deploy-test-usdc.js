#!/usr/bin/env node
// Deploy a simple test USDC (ERC-20) token on Base Sepolia.
//
// Mints 1,000,000 USDC to the owner account so you can distribute
// it to test users. Only for testnet — on mainnet you use real USDC.
//
// Usage:
//   node scripts/deploy-test-usdc.js

require('dotenv').config();
const { CdpClient } = require('@coinbase/cdp-sdk');
const { ethers } = require('ethers');

// Minimal ERC-20 with mint — good enough for testing
const SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TestUSDC {
    string public name = "Test USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public owner;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        owner = msg.sender;
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        require(allowance[from][msg.sender] >= amount, "not approved");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "only owner");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
}
`;

async function main() {
  console.log('[TestUSDC] Deploying test USDC token on Base Sepolia...');

  const cdp = new CdpClient();
  const ownerAccount = await cdp.evm.getOrCreateAccount({ name: 'escrow-owner' });
  console.log(`[TestUSDC] Deployer: ${ownerAccount.address}`);

  // Compile with solc
  const solc = require('solc');
  const input = {
    language: 'Solidity',
    sources: { 'TestUSDC.sol': { content: SOURCE } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors?.some(e => e.severity === 'error')) {
    output.errors.filter(e => e.severity === 'error').forEach(e => console.error(e.formattedMessage));
    process.exit(1);
  }

  const compiled = output.contracts['TestUSDC.sol']['TestUSDC'];
  const abi = compiled.abi;
  const bytecode = '0x' + compiled.evm.bytecode.object;

  // Export key and deploy with ethers
  const privateKey = await cdp.evm.exportAccount({ address: ownerAccount.address });
  const provider = new ethers.JsonRpcProvider('https://sepolia.base.org', { name: 'base-sepolia', chainId: 84532 });
  const deployer = new ethers.Wallet(privateKey, provider);

  // 1,000,000 USDC (6 decimals)
  const initialSupply = 1000000n * 1000000n;

  console.log('[TestUSDC] Deploying...');
  const factory = new ethers.ContractFactory(abi, bytecode, deployer);
  const contract = await factory.deploy(initialSupply);
  console.log(`[TestUSDC] TX: ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log();
  console.log('═'.repeat(60));
  console.log(`[TestUSDC] ✅ Test USDC deployed at: ${address}`);
  console.log(`[TestUSDC] 1,000,000 USDC minted to ${ownerAccount.address}`);
  console.log();
  console.log('Add this to your .env:');
  console.log(`  USDC_CONTRACT_ADDRESS=${address}`);
  console.log('═'.repeat(60));
}

main().catch(err => {
  console.error('[TestUSDC] FATAL:', err);
  process.exit(1);
});
