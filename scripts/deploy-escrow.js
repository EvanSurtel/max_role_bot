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

  // matchOperator — always the bot's Smart Account, never changes in
  // normal operation. Holds day-to-day authority (createMatch,
  // depositFromSpender, resolveMatch, cancelMatch).
  const matchOperator = smartAccount.address;

  // admin — holds break-glass authority (emergencyWithdraw, rotate the
  // matchOperator if the bot's key is compromised, rotate itself).
  //
  // Normally this is a multisig Safe (set SAFE_ADMIN_ADDRESS in .env).
  // During bring-up before the Safe is deployed, admin can fall back
  // to the Smart Account too — admin is then migrated to the Safe
  // later via transferAdmin. Clear warning is logged below if the
  // fallback is used, since that leaves the role-based protection
  // providing no additional defense vs. the prior single-owner model.
  const configuredAdmin = (process.env.SAFE_ADMIN_ADDRESS || '').trim();
  const adminAddress = configuredAdmin || smartAccount.address;
  if (!configuredAdmin) {
    console.warn(
      '[Deploy] WARNING: SAFE_ADMIN_ADDRESS not set — admin role falls ' +
      'back to escrow-owner-smart. This means the role-based model ' +
      'provides no additional protection beyond single-owner. Migrate ' +
      'admin to the multisig Safe via transferAdmin() as soon as the ' +
      'Safe is deployed.',
    );
  }
  console.log(`[Deploy] matchOperator: ${matchOperator}`);
  console.log(`[Deploy] admin:         ${adminAddress}${configuredAdmin ? ' (multisig Safe)' : ' (bring-up fallback — migrate to Safe)'}`);

  // CDP sendTransaction doesn't support contract creation (no `to` address).
  // Export the owner account's private key and use ethers.js directly.
  console.log('[Deploy] Exporting owner key for contract deployment...');
  const privateKey = await cdp.evm.exportAccount({ address: owner.address });

  const rpcUrl = process.env.BASE_RPC_URL || (network === 'sepolia' ? 'https://sepolia.base.org' : 'https://mainnet.base.org');
  const provider = new ethers.JsonRpcProvider(rpcUrl, { name: network === 'sepolia' ? 'base-sepolia' : 'base', chainId });
  const deployer = new ethers.Wallet(privateKey, provider);

  console.log('[Deploy] Sending deployment transaction...');
  const factory = new ethers.ContractFactory(abi, bytecode, deployer);
  const contract = await factory.deploy(usdcAddress, matchOperator, adminAddress);
  console.log(`[Deploy] TX hash: ${contract.deploymentTransaction().hash}`);
  console.log('[Deploy] Waiting for confirmation...');

  await contract.waitForDeployment();
  const deployedAddress = await contract.getAddress();

  console.log(`[Deploy] ✅ WagerEscrow deployed at: ${deployedAddress}`);
  console.log(`[Deploy] View on BaseScan: ${explorerUrl}/address/${deployedAddress}`);

  // Sanity-check the roles on-chain (constructor emitted events but
  // verifying state confirms the call actually stuck).
  const onChainMatchOp = await contract.matchOperator();
  const onChainAdmin = await contract.admin();
  if (onChainMatchOp.toLowerCase() !== matchOperator.toLowerCase()) {
    throw new Error(`matchOperator mismatch after deploy: on-chain ${onChainMatchOp}, expected ${matchOperator}`);
  }
  if (onChainAdmin.toLowerCase() !== adminAddress.toLowerCase()) {
    throw new Error(`admin mismatch after deploy: on-chain ${onChainAdmin}, expected ${adminAddress}`);
  }
  console.log(`[Deploy] ✅ Roles verified on-chain`);
  console.log();

  // ─── Smart Account approves WagerEscrow for USDC ───────────────
  // Required for the self-custody deposit path. When a smart-wallet
  // player joins a match the flow is:
  //   (1) SpendPermissionManager.spend(perm, entry) →
  //       USDC flows from user's Smart Wallet to escrow-owner-smart
  //   (2) WagerEscrow.depositFromSpender(matchId, player, source) →
  //       escrow contract does transferFrom(escrow-owner-smart, ...)
  //
  // Step 2 requires escrow-owner-smart to have approved the WagerEscrow
  // contract. We do it here as part of deploy bring-up — one UserOp,
  // max allowance, never needs to be redone. Gasless via Paymaster.
  console.log('[Deploy] Approving WagerEscrow from escrow-owner-smart for USDC (self-custody deposit path)...');
  try {
    const MAX_UINT256 = (1n << 256n) - 1n;
    const approveIface = new ethers.Interface([
      'function approve(address spender, uint256 value) returns (bool)',
    ]);
    const approveData = approveIface.encodeFunctionData('approve', [deployedAddress, MAX_UINT256]);

    const userOpResult = await cdp.evm.prepareAndSendUserOperation({
      smartAccount,
      network: cdpNetwork,
      ...(process.env.PAYMASTER_RPC_URL ? { paymasterUrl: process.env.PAYMASTER_RPC_URL } : {}),
      calls: [
        {
          to: usdcAddress,
          value: 0n,
          data: approveData,
        },
      ],
    });
    console.log(`[Deploy]   approve UserOp: ${userOpResult.userOpHash}`);
    // Wait for the UserOp to land so subsequent match deposits don't
    // race against an unconfirmed approval.
    await cdp.evm.waitForUserOperation({
      smartAccountAddress: smartAccount.address,
      userOpHash: userOpResult.userOpHash,
    });
    console.log('[Deploy] ✅ escrow-owner-smart approved WagerEscrow for USDC');
  } catch (err) {
    // Non-fatal — operator can run `scripts/approve-escrow-from-spender.js`
    // later if this step fails. Surface loudly though.
    console.error(`[Deploy] WARNING: escrow-owner-smart approve failed: ${err.message}`);
    console.error('[Deploy] Self-custody match deposits will revert until this approve lands.');
  }
  console.log();

  console.log('═'.repeat(72));
  console.log(`[Deploy] ✅ Deployment complete`);
  console.log(`[Deploy] Contract:       ${deployedAddress}`);
  console.log(`[Deploy] matchOperator:  ${matchOperator} (bot's Smart Account)`);
  console.log(`[Deploy] admin:          ${adminAddress}${configuredAdmin ? ' (multisig Safe)' : ' (bring-up fallback — migrate to Safe!)'}`);
  console.log(`[Deploy] View on BaseScan: ${explorerUrl}/address/${deployedAddress}`);
  console.log();
  console.log('Add these to your .env:');
  console.log(`  ESCROW_CONTRACT_ADDRESS=${deployedAddress}`);
  console.log(`  CDP_OWNER_ADDRESS=${smartAccount.address}`);
  console.log();
  console.log('From now on the EOA is DORMANT. All match-operator calls route');
  console.log('through the Smart Account via Paymaster — zero gas cost.');
  if (!configuredAdmin) {
    console.log();
    console.log('⚠️  admin is currently the same address as matchOperator.');
    console.log('    Deploy a 2-of-3 Gnosis Safe at https://safe.global/ on Base,');
    console.log('    then call transferAdmin(<safe address>) from escrow-owner-smart.');
    console.log('    Alternatively: redeploy with SAFE_ADMIN_ADDRESS set.');
  }
  console.log('═'.repeat(72));
}

main().catch(err => {
  console.error('[Deploy] FATAL:', err);
  process.exit(1);
});
