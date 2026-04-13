#!/usr/bin/env node
// Deploy WagerEscrow.sol to Base using ethers.js directly.
//
// This does NOT use Hardhat or Foundry — it compiles and deploys
// using just ethers.js + solc, so there's no additional toolchain
// to install. The compiled ABI + bytecode are saved to
// contracts/WagerEscrow.json for the bot to use at runtime.
//
// Usage:
//   node scripts/deploy-escrow.js
//
// Prerequisites:
//   - npm install solc (Solidity compiler)
//   - DEPLOYER_PRIVATE_KEY set in .env (deployer pays gas)
//   - BASE_RPC_URL set in .env
//   - USDC_CONTRACT_ADDRESS set in .env

require('dotenv').config();
const { ethers } = require('ethers');
const solc = require('solc');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('[Deploy] Starting WagerEscrow deployment to Base...');

  // ─── Load and compile the contract ───────────────────────
  const contractPath = path.join(__dirname, '..', 'contracts', 'WagerEscrow.sol');
  const source = fs.readFileSync(contractPath, 'utf8');

  // Resolve OpenZeppelin imports from node_modules
  const input = {
    language: 'Solidity',
    sources: {
      'WagerEscrow.sol': { content: source },
    },
    settings: {
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object'],
        },
      },
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  };

  function findImports(importPath) {
    const resolved = path.join(__dirname, '..', 'node_modules', importPath);
    if (fs.existsSync(resolved)) {
      return { contents: fs.readFileSync(resolved, 'utf8') };
    }
    return { error: `File not found: ${importPath}` };
  }

  console.log('[Deploy] Compiling Solidity...');
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  if (output.errors) {
    const errors = output.errors.filter(e => e.severity === 'error');
    if (errors.length > 0) {
      console.error('[Deploy] Compilation errors:');
      errors.forEach(e => console.error(e.formattedMessage));
      process.exit(1);
    }
    // Print warnings but continue
    output.errors.filter(e => e.severity === 'warning').forEach(e => {
      console.warn('[Deploy] Warning:', e.message);
    });
  }

  const compiled = output.contracts['WagerEscrow.sol']['WagerEscrow'];
  if (!compiled) {
    console.error('[Deploy] WagerEscrow contract not found in compilation output');
    process.exit(1);
  }

  const abi = compiled.abi;
  const bytecode = '0x' + compiled.evm.bytecode.object;

  console.log(`[Deploy] Compiled successfully. ABI: ${abi.length} entries, Bytecode: ${bytecode.length} chars`);

  // Save the compiled ABI + bytecode for the bot to use
  const artifactPath = path.join(__dirname, '..', 'contracts', 'WagerEscrow.json');
  fs.writeFileSync(artifactPath, JSON.stringify({ abi, bytecode }, null, 2));
  console.log(`[Deploy] Artifact saved to ${artifactPath}`);

  // ─── Deploy ──────────────────────────────────────────────
  const network = (process.env.BASE_NETWORK || 'mainnet').toLowerCase();
  const chainId = network === 'sepolia' ? 84532 : 8453;
  const defaultRpc = network === 'sepolia' ? 'https://sepolia.base.org' : 'https://mainnet.base.org';
  const explorerUrl = network === 'sepolia' ? 'https://sepolia.basescan.org' : 'https://basescan.org';
  const rpcUrl = process.env.BASE_RPC_URL || defaultRpc;
  const provider = new ethers.JsonRpcProvider(rpcUrl, { name: network === 'sepolia' ? 'base-sepolia' : 'base', chainId });
  console.log(`[Deploy] Network: ${network} (chain ${chainId})`);
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!deployerKey) {
    console.error('[Deploy] DEPLOYER_PRIVATE_KEY not set in .env');
    process.exit(1);
  }

  const deployer = new ethers.Wallet(deployerKey, provider);
  console.log(`[Deploy] Deployer address: ${deployer.address}`);

  const balance = await provider.getBalance(deployer.address);
  console.log(`[Deploy] Deployer ETH balance: ${ethers.formatEther(balance)} ETH`);
  if (balance < ethers.parseEther('0.001')) {
    console.error('[Deploy] Deployer needs at least 0.001 ETH for deployment gas');
    process.exit(1);
  }

  const usdcAddress = process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  console.log(`[Deploy] USDC address: ${usdcAddress}`);

  const factory = new ethers.ContractFactory(abi, bytecode, deployer);
  console.log('[Deploy] Sending deployment transaction...');

  const contract = await factory.deploy(usdcAddress);
  console.log(`[Deploy] TX hash: ${contract.deploymentTransaction().hash}`);
  console.log('[Deploy] Waiting for confirmation...');

  await contract.waitForDeployment();
  const deployedAddress = await contract.getAddress();

  console.log();
  console.log('═'.repeat(60));
  console.log(`[Deploy] ✅ WagerEscrow deployed at: ${deployedAddress}`);
  console.log(`[Deploy] View on BaseScan: ${explorerUrl}/address/${deployedAddress}`);
  console.log();
  console.log('Add this to your .env:');
  console.log(`  ESCROW_CONTRACT_ADDRESS=${deployedAddress}`);
  console.log('═'.repeat(60));
}

main().catch(err => {
  console.error('[Deploy] FATAL:', err);
  process.exit(1);
});
