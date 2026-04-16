#!/usr/bin/env node
// Deploy WagerEscrow.sol to Base using the CDP owner account.
//
// Uses the CDP SDK to sign the deployment transaction — no MetaMask
// or external wallet needed. The owner account (escrow-owner) is
// funded with test ETH via the CDP faucet automatically on testnet.
//
// Usage:
//   node scripts/deploy-escrow.js
//
// Prerequisites:
//   - npm install solc
//   - CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET set in .env
//   - USDC_CONTRACT_ADDRESS set in .env (for testnet)

require('dotenv').config();
const { CdpClient } = require('@coinbase/cdp-sdk');
const { ethers } = require('ethers');
const solc = require('solc');
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('[Deploy] Starting WagerEscrow deployment to Base...');

  const cdp = new CdpClient();
  const network = (process.env.BASE_NETWORK || 'mainnet').toLowerCase();
  const cdpNetwork = network === 'sepolia' ? 'base-sepolia' : 'base';
  const chainId = network === 'sepolia' ? 84532 : 8453;
  const explorerUrl = network === 'sepolia' ? 'https://sepolia.basescan.org' : 'https://basescan.org';

  // ─── Get or create owner EOA + Smart Account ─────────────
  // EOA: signs the one-time deployment + transferOwnership.
  // Smart Account: becomes the on-chain owner after deploy. All
  // future admin calls go through it via Paymaster (gasless).
  const owner = await cdp.evm.getOrCreateAccount({ name: 'escrow-owner' });
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: 'escrow-owner-smart',
    owner,
  });
  console.log(`[Deploy] Deployer EOA: ${owner.address}`);
  console.log(`[Deploy] Smart Account (will become owner): ${smartAccount.address}`);

  // ─── Fund with test ETH on testnet ───────────────────────
  if (network === 'sepolia') {
    console.log('[Deploy] Requesting test ETH from faucet...');
    try {
      const faucet = await cdp.evm.requestFaucet({
        address: owner.address,
        network: 'base-sepolia',
        token: 'eth',
      });
      console.log(`[Deploy] Faucet TX: ${faucet.transactionHash}`);
      // Wait for faucet to land
      const rpcUrl = process.env.BASE_RPC_URL || 'https://sepolia.base.org';
      const provider = new ethers.JsonRpcProvider(rpcUrl, { name: 'base-sepolia', chainId });
      await provider.waitForTransaction(faucet.transactionHash, 1, 30000);
      console.log('[Deploy] Faucet confirmed');
    } catch (err) {
      console.warn(`[Deploy] Faucet request failed (may already have ETH): ${err.message}`);
    }
  }

  // ─── Compile the contract ────────────────────────────────
  const contractPath = path.join(__dirname, '..', 'contracts', 'WagerEscrow.sol');
  const source = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: { 'WagerEscrow.sol': { content: source } },
    settings: {
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
      optimizer: { enabled: true, runs: 200 },
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
  console.log(`[Deploy] Compiled. ABI: ${abi.length} entries, Bytecode: ${bytecode.length} chars`);

  // Save artifact
  const artifactPath = path.join(__dirname, '..', 'contracts', 'WagerEscrow.json');
  fs.writeFileSync(artifactPath, JSON.stringify({ abi, bytecode }, null, 2));
  console.log(`[Deploy] Artifact saved to ${artifactPath}`);

  // ─── Deploy via CDP ──────────────────────────────────────
  const usdcAddress = process.env.USDC_CONTRACT_ADDRESS || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  console.log(`[Deploy] USDC address: ${usdcAddress}`);

  // Encode constructor args (USDC address)
  const iface = new ethers.Interface(abi);
  const constructorData = iface.encodeDeploy([usdcAddress]);
  const deployData = bytecode + constructorData.slice(2); // remove 0x from constructor data

  // CDP sendTransaction doesn't support contract creation (no `to` address).
  // Export the owner account's private key and use ethers.js directly.
  console.log('[Deploy] Exporting owner key for contract deployment...');
  const privateKey = await cdp.evm.exportAccount({ address: owner.address });

  const rpcUrl = process.env.BASE_RPC_URL || (network === 'sepolia' ? 'https://sepolia.base.org' : 'https://mainnet.base.org');
  const provider = new ethers.JsonRpcProvider(rpcUrl, { name: network === 'sepolia' ? 'base-sepolia' : 'base', chainId });
  const deployer = new ethers.Wallet(privateKey, provider);

  console.log('[Deploy] Sending deployment transaction...');
  const factory = new ethers.ContractFactory(abi, bytecode, deployer);
  const contract = await factory.deploy(usdcAddress);
  console.log(`[Deploy] TX hash: ${contract.deploymentTransaction().hash}`);
  console.log('[Deploy] Waiting for confirmation...');

  await contract.waitForDeployment();
  const deployedAddress = await contract.getAddress();

  console.log(`[Deploy] ✅ WagerEscrow deployed at: ${deployedAddress}`);
  console.log(`[Deploy] View on BaseScan: ${explorerUrl}/address/${deployedAddress}`);
  console.log();

  // ─── Transfer ownership from EOA to Smart Account ──────────────
  // After this, the EOA never signs another tx for this contract.
  // The Smart Account becomes the only authorized caller of
  // createMatch / resolveMatch / cancelMatch, and every one of
  // those calls is gasless via the CDP Paymaster.
  console.log('[Deploy] Transferring ownership to the Smart Account (gasless-ready)...');
  const transferTx = await contract.transferOwnership(smartAccount.address);
  console.log(`[Deploy]   transferOwnership TX: ${transferTx.hash}`);
  await transferTx.wait(1);

  // Sanity-check the new owner on-chain
  const newOwner = await contract.owner();
  if (newOwner.toLowerCase() !== smartAccount.address.toLowerCase()) {
    throw new Error(`Ownership transfer failed. On-chain owner=${newOwner}, expected=${smartAccount.address}`);
  }
  console.log(`[Deploy] ✅ Ownership transferred to Smart Account`);
  console.log();

  console.log('═'.repeat(72));
  console.log(`[Deploy] ✅ Deployment complete`);
  console.log(`[Deploy] Contract:      ${deployedAddress}`);
  console.log(`[Deploy] Owner (Smart): ${smartAccount.address}`);
  console.log(`[Deploy] View on BaseScan: ${explorerUrl}/address/${deployedAddress}`);
  console.log();
  console.log('Add these to your .env:');
  console.log(`  ESCROW_CONTRACT_ADDRESS=${deployedAddress}`);
  console.log(`  CDP_OWNER_ADDRESS=${smartAccount.address}`);
  console.log();
  console.log('From now on the EOA is DORMANT. All escrow admin calls route');
  console.log('through the Smart Account via Paymaster — zero gas cost.');
  console.log('═'.repeat(72));
}

main().catch(err => {
  console.error('[Deploy] FATAL:', err);
  process.exit(1);
});
