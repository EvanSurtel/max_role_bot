# Rank $ CODM Wager Bot

Discord bot for Call of Duty Mobile competitive matches. Users wager USDC on matches through button-based interactions.

## Tech Stack

- **Runtime**: Node.js
- **Discord**: discord.js v14 — buttons, modals, user select menus (NO slash commands except /rank)
- **Database**: SQLite via better-sqlite3, WAL mode, migrations in `src/database/migrations/`
- **Blockchain**: Base (Coinbase L2, chain ID 8453) — `ethers.js` v6
- **Smart Contract**: Solidity `contracts/WagerEscrow.sol` deployed on Base
- **Token**: USDC (ERC-20, 6 decimals) at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. ETH for gas only.
- **NOT Solana, NOT Ethereum mainnet, NOT Polygon. Base only.**

## Architecture

```
User registers → Bot creates CDP Smart Account on Base
               → Encrypts CDP wallet data with AES-256-GCM + per-user salt
               → Approves escrow contract (gasless via Paymaster)
               → Signs approve(escrowContract, MAX) on USDC contract

User deposits  → USDC arrives at user's individual wallet on Base
               → Deposit poller detects it every 30s → credits DB balance

Match starts   → Smart contract pulls USDC from each player (transferFrom)
               → All funds held in the contract

Match resolves → Smart contract sends pot to winners' individual wallets

User withdraws → Bot signs transfer from user's wallet → USDC to external address
```

Every arrow is an on-chain Base transaction with a hash on BaseScan.

## Project Structure

```
src/
  index.js                    # Entry point — loads events, DB, Base connection, health checks, panels
  config/constants.js         # Game modes, timers, USDC constants, thresholds, cooldowns
  database/
    db.js                     # SQLite connection + migration runner
    migrations/               # Sequential SQL migrations (001–007)
    repositories/             # userRepo, walletRepo, challengeRepo, challengePlayerRepo, matchRepo, transactionRepo, evidenceRepo, pendingTxRepo
  base/
    connection.js             # Base RPC provider (ethers.js JsonRpcProvider)
    walletManager.js          # Ethereum keypair gen, AES-256-GCM encryption, USDC/ETH balance, address validation
    transactionService.js     # ERC-20 USDC transfers, ETH transfers, gas funder signer
    escrowManager.js          # Smart contract integration — hold/release (DB), createMatch, depositToEscrow, disburseWinnings, cancelMatch
    depositService.js         # Polls USDC balanceOf every 30s per user wallet
  panels/
    lobbyPanel.js             # Main wager channel panel (Create Wager, XP Match, Wallet, Leaderboard)
    walletPanel.js            # Balance, deposit (region-aware), withdraw USDC/ETH, history
    leaderboardPanel.js       # XP, earnings, wins
    seasonPanel.js            # Season management (pause, resume, end)
    escrowPanel.js            # Admin escrow view + withdraw ETH/USDC
    ranksPanel.js             # Rank tier display with emblems
    howItWorksPanel.js        # How it works guide
    rulesPanel.js             # Server rules
  interactions/
    challengeCreate.js        # Multi-step creation flow (type→size→teammates→mode→series→visibility→amount)
    challengeAccept.js        # Accept from board, opponent team formation
    challengeCancel.js        # Creator cancels challenge, refunds all
    teammateResponse.js       # Accept/decline via DM (private channel fallback)
    matchResult.js            # Report win → accept/dispute → confirm → payout
    onboarding.js             # TOS accept → wallet creation → escrow approval → region detection
    disputeCreate.js          # Create dispute from lobby
  services/
    matchService.js           # Create match channels, start match (smart contract), resolve, cleanup
    challengeService.js       # Notify teammates, post to board, cancel
    reconciliationService.js  # Compare on-chain vs DB balances every 5min
    healthService.js          # Gas funder ETH monitoring, daily summary, match creation gating
    timerService.js           # DB-backed persistent timers
    neatqueueService.js       # Sync XP to NeatQueue bot via REST API
  commands/
    rank.js                   # /rank slash command + rank card builder
    rank-context.js           # Right-click "View Rank" user context menu
  utils/
    crypto.js                 # AES-256-GCM + HKDF per-user key derivation
    embeds.js                 # Discord embed builders, formatUsdc()
    rankCardRenderer.js       # Canvas-rendered rank trading card (1100x440 PNG)
    rankRoleSync.js           # Rank role assignment from NeatQueue leaderboard
    transactionFeed.js        # Admin transaction feed + per-user DM notifications
    nicknameUpdater.js        # [flag] [name] [XP] [$earnings] nickname sync
contracts/
  WagerEscrow.sol             # Solidity escrow (createMatch, depositToEscrow, resolveMatch, cancelMatch)
scripts/
  deploy-escrow.js            # Deploy WagerEscrow.sol to Base
  reset-for-mainnet.js        # One-shot DB + nickname + NeatQueue reset
programs/
  wager-escrow/               # Legacy Anchor (Solana) contract — NOT USED, kept as reference
```

## Key Conventions

- **No slash commands** except /rank — All user interactions via button panels
- **No DMs for notifications** — Use private server channels (DM-first for teammate invites with channel fallback)
- **Amounts**: Stored as strings in USDC smallest units (6 decimals: 1 USDC = 1000000). Use `BigInt` for arithmetic.
- **DB columns**: `solana_address` and `solana_tx_signature` are legacy column names that store Base addresses and tx hashes.
- **Wallet security**: CDP Smart Accounts — keys held by Coinbase, never stored locally. The `encryption_iv` / `encryption_tag` / `encryption_salt` columns on the wallets table are legacy from the XRP/Solana era (always empty strings on CDP). No local encryption, no ENCRYPTION_KEY env var needed.
- **Escrow model**: Hold = DB-level balance lock. Match start = smart contract pulls USDC via transferFrom. Resolve = smart contract sends to winners.
- **Gas**: 100% gasless at runtime via CDP Paymaster. Two kinds of Smart Accounts: user Smart Accounts for USDC approve/transfer, and a dedicated `escrow-owner-smart` Smart Account that's the on-chain owner of the escrow contract. All admin calls (createMatch, depositToEscrow, resolveMatch, cancelMatch) route through `_sendOwnerTx` → UserOp → Paymaster → zero gas cost. The `escrow-owner` EOA signs ONE transaction ever — the deploy + ownership transfer — then goes dormant forever. Do not revert owner calls back to EOA `sendTransaction`.
- **Race conditions**: walletRepo.acquireLock() for wallet ops, challengeRepo/matchRepo.atomicStatusTransition() for challenge/match state transitions
- **Admin roles**: ADMIN_ROLE_ID, OWNER_ROLE_ID, CEO_ROLE_ID, ADS_ROLE_ID — all admin-equivalent for permissions + alert pings

## Deposit Flow (Region-Based)

- **Group A** (US, UK, Canada, EU, Australia, Switzerland, Singapore, Japan): Coinbase Onramp — 0% fee, card/Apple Pay/Google Pay/bank transfer
- **Group B** (LATAM, Africa, Asia, everywhere else): Bitget Wallet app — 3-5% fee, card/Apple Pay/PIX/SPEI/bank transfer
- Region is auto-detected from user's country flag during onboarding, stored in `users.deposit_region`
- Deposit instructions shown when user clicks "Deposit Info" in wallet panel

## XP Source of Truth

- **NeatQueue** is the source of truth for current season XP (sees queue matches + bot's wager/XP challenge deltas)
- **Local DB** is the source of truth for earnings leaderboard and historical seasons
- Rank roles (`rankRoleSync.js`) read from NeatQueue's leaderboard
- The bot pushes XP deltas to NeatQueue on every match resolution

## Environment Variables

See `.env.example` for full list. Key vars:
- `BOT_TOKEN`, `GUILD_ID`, `ADMIN_ROLE_ID`, `OWNER_ROLE_ID`, `CEO_ROLE_ID`, `ADS_ROLE_ID`
- `BASE_RPC_URL`, `ESCROW_CONTRACT_ADDRESS`, `USDC_CONTRACT_ADDRESS`
- `WAGER_CHANNEL_ID`, `CHALLENGES_CHANNEL_ID`, `ADMIN_ALERTS_CHANNEL_ID`
- `ENCRYPTION_KEY`
- `MIN_WAGER_USDC`, `MAX_WAGER_USDC`, `MIN_WITHDRAWAL_USDC`
- `CDP_API_KEY_NAME`, `CDP_API_KEY_SECRET`, `CDP_PROJECT_ID`, `PAYMASTER_RPC_URL`, `CDP_OWNER_WALLET_DATA` (Coinbase Onramp for Group A deposits)

## Running

```bash
npm install
# Set up .env from .env.example
npm start        # Production
npm run dev      # Watch mode
```

## Smart Contract Deployment

```bash
# Set CDP credentials and BASE_RPC_URL in .env first
# Fund the deployer wallet with ~$5 ETH on Base
node scripts/deploy-escrow.js
# Prints ESCROW_CONTRACT_ADDRESS=0x... — paste into .env
```
