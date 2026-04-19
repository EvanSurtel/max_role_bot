# Rank $ CODM Wager Bot

Discord bot for Call of Duty Mobile competitive matches. Users wager USDC on matches through button-based interactions. Also runs a 5v5 ranked XP queue system.

## Tech Stack

- **Runtime**: Node.js
- **Discord**: discord.js v14 — buttons, modals, user select menus (NO slash commands except /rank)
- **Database**: SQLite via better-sqlite3, WAL mode, migrations in `src/database/migrations/` (001–013)
- **Blockchain**: Base mainnet (Coinbase L2, chain ID 8453) — `ethers.js` v6 with FallbackProvider (primary + fallback RPC)
- **Smart Contract**: `contracts/WagerEscrow.sol` deployed at `0xA00E7cCdaE3978cb0f25cB8BadaA2B9d26b62747` (tracks `totalActiveEscrow`; emergencyWithdraw only pulls unallocated funds)
- **Wallets**: Coinbase CDP Smart Accounts (ERC-4337). Keys held by Coinbase, never stored locally.
- **Gas**: 100% gasless at runtime via CDP Paymaster (UserOps). The `escrow-owner` EOA signs ONE transaction ever (deploy + transferOwnership). The runtime owner is a Smart Account (`escrow-owner-smart`, currently `0x407AA75dC2f0D3B7A50dceCbC4BC061Ff92542e6`) routed via `_sendOwnerTx`.
- **Token**: USDC (ERC-20, 6 decimals) at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. ETH used only for edge-case admin withdrawals.
- **NOT Solana, NOT Ethereum mainnet, NOT Polygon. Base only.**

## Architecture

```
User registers → Bot creates CDP Smart Account on Base
               → Approves escrow contract for MAX USDC (gasless via Paymaster)
               → Stores smart_account_address in DB

User deposits  → USDC arrives at user's Smart Account on Base
               → Deposit poller (30s) detects delta → credits DB balance
                 (uses pre-log reconciliation — does NOT label internal flows as deposits)

Match starts   → Smart contract createMatch + depositToEscrow per player
               → transferFrom pulls USDC from each Smart Account into escrow
               → totalActiveEscrow increments

Match resolves → Smart contract resolveMatch pays winners
               → totalActiveEscrow decrements

User withdraws → Bot signs USDC transfer from user Smart Account to external address
```

Every arrow is an on-chain Base transaction with a hash on BaseScan. All admin calls route through the escrow-owner Smart Account → UserOp → Paymaster → zero gas cost.

## Project Structure

```
src/
  index.js                        # Entry point — events, DB, Base connection, health, panel init
  config/constants.js             # Game modes, timers, USDC constants, thresholds, cooldowns
  database/
    db.js                         # SQLite connection + migration runner
    migrations/                   # Sequential SQL (001–013)
    repositories/                 # userRepo, walletRepo, challengeRepo, challengePlayerRepo,
                                  # matchRepo, transactionRepo, evidenceRepo, pendingTxRepo
  base/
    connection.js                 # FallbackProvider (Alchemy primary + Ankr fallback)
    walletManager.js              # CDP Smart Account creation, balance lookups, address validation
    transactionService.js         # ERC-20 USDC transfers + _sendOwnerTx for gasless admin UserOps
    escrowManager.js              # DB-side hold/release + contract createMatch/depositToEscrow/
                                  # resolveMatch/cancelMatch (pre-log pattern, idempotent approve)
    depositService.js             # 30s poll w/ pre-log reconciliation, 90min pending window,
                                  # $0.01 dust filter, skips locked wallets
  queue/                          # 5v5 ranked XP queue (in-memory state, no persistence)
    state.js                      # Single source of truth: waitingQueue + activeMatches map
    matchLifecycle.js             # Create → captains → picks → play → vote → resolve
    captainVote.js                # Captain election voting
    captainPick.js                # Snake draft player picks
    roleSelect.js                 # Weapon role selection
    playPhase.js                  # Match active phase + games played tracking
    subCommands.js                # !sub / substitute handling
    interactions.js               # Button/select interaction router
    helpers.js                    # Shared utilities
    index.js                      # Public API barrel
  panels/
    lobbyPanel.js                 # Main wager channel — Create Wager, XP Match, Wallet, Stats
    queuePanel.js                 # Ranked queue join/leave, auto-ping @7/8/9, 1hr timeout
    queueStatsPanel.js            # All XP match stats (queue + XP challenges)
    wagerStatsPanel.js            # Cash match stats only
    leaderboardPanel.js           # XP, earnings, wins
    seasonPanel.js                # Season pause/resume/end (checks queue matches too)
    escrowPanel.js                # Admin escrow view + emergencyWithdraw (unlocked funds only)
    ranksPanel.js                 # Rank tier display w/ emblems
    howItWorksPanel.js            # How it works guide
    rulesPanel.js                 # Server rules
    welcomePanel.js, xpMatchPanel.js, publicWalletPanel.js, adminWalletViewerPanel.js
    wallet/                       # Split wallet panel
      index.js                    # Router
      deposit.js                  # Region-aware deposit instructions
      withdraw.js, withdrawEth.js, withdrawMenu.js
      cashOut.js                  # Full balance cash out
      history.js                  # Transaction history
      refresh.js, viewOpen.js
  interactions/
    challengeCreate.js            # type → size → teammates → mode → series → visibility → amount
    challengeAccept.js            # Accept from board + opponent team formation
    challengeCancel.js            # Creator cancels challenge, refunds all
    teammateResponse.js           # DM-first w/ private channel fallback
    disputeCreate.js              # Create dispute from lobby
    onboarding.js                 # TOS → wallet creation → escrow approval → region detection
                                  # (acceptTos() runs AFTER wallet creation succeeds — F1 fix)
    languageSwitcher.js           # Per-message language dropdown
    perMessageLanguage.js         # Language state per message
    adminWalletViewer.js
    matchResult/                  # Split match result handling
      index.js                    # Router
      reporting.js                # Report win → accept/dispute → confirm
      noShow.js                   # No-show timer resolution
      dispute.js                  # Dispute creation
      adminResolve.js             # Admin dispute resolution
      disputeResult.js            # Result after admin decision
      helpers.js                  # Shared utilities
  services/
    match/                        # Split from matchService.js
      index.js                    # Public API
      createChannels.js           # 6–7 channels per match w/ permissions
      startMatch.js               # Smart contract createMatch + depositToEscrow
      resolveMatch.js             # Smart contract resolveMatch + payouts
      cleanup.js                  # Channel deletion
      helpers.js
    matchService.js               # Legacy re-export shim (keeps imports working)
    challengeService.js           # Notify teammates, post to board, cancel
    channelService.js             # Channel CRUD w/ permission overwrites
    reconciliationService.js      # On-chain vs DB balance compare every 5min
    healthService.js              # Escrow owner ETH monitoring, daily summary, match gating
    timerService.js, timerHandlers.js  # DB-backed persistent timers
    walletChannelMigration.js, webhookServer.js, changellyService.js
  commands/
    rank.js                       # /rank slash command + rank card builder
    rank-context.js               # Right-click "View Rank" user context menu
  utils/
    crypto.js                     # AES-256-GCM + HKDF per-user key (legacy columns, unused on CDP)
    embeds.js                     # Embed builders, formatUsdc()
    rankCardRenderer.js           # Canvas 1100x440 PNG rank card
    rankRoleSync.js               # Role assignment from local xp_points
    transactionFeed.js            # Routes to TRANSACTIONS (cash) or XP_TRANSACTIONS (XP) channel
    nicknameUpdater.js            # [flag] [name] [XP] [$earnings] sync w/ role-hierarchy diagnostics
    playerStatus.js               # Cross-system busy check (queue + wager matches)
    rateLimiter.js                # Per-user cooldowns, quotas, global on-chain cooldown
    matchTimer.js, mapPicker.js, xpCalculator.js
    ephemeralReply.js             # Scoped per-(user, channel) ephemeral replacement
    ephemeralPanelDispatcher.js, languageButtonHelper.js, languageRefresh.js
    challengeLabel.js, permissions.js, adminAudit.js
contracts/
  WagerEscrow.sol                 # createMatch, depositToEscrow, resolveMatch, cancelMatch,
                                  # totalActiveEscrow, emergencyWithdraw (unallocated only)
scripts/
  deploy-escrow.js                # Deploy + transferOwnership to Smart Account
  create-owner-wallet.js          # Creates escrow-owner EOA + escrow-owner-smart Smart Account
  emergency-cancel-match.js       # Break-glass recovery for stuck escrow paths
  diagnose-balances.js            # On-chain vs DB reconciliation diagnostic
  backup-db.sh                    # Daily DB backup, 30-day retention
  reset-for-mainnet.js            # One-shot DB + nickname reset
  (+ assorted check/test scripts)
programs/
  wager-escrow/                   # Legacy Anchor (Solana) — NOT USED, kept as reference
```

## Key Conventions

- **No slash commands** except `/rank`. All user interactions via button panels.
- **No DMs for notifications** — private server channels only. Exceptions: teammate invites (DM-first w/ channel fallback) and rank promotion/demotion.
- **Panel toggles in place**: toggle buttons (language, filter, etc.) must `interaction.update()` the original message. No new ephemeral replies.
- **Display names**: never rely on `<@id>` alone in embed field values. Plain text first, mention as fallback.
- **Amounts**: Stored as strings in USDC smallest units (6 decimals). Use `BigInt` for arithmetic.
- **Legacy columns**: `solana_address` stores Base addresses; `solana_tx_signature` stores Base tx hashes. `encryption_iv` / `encryption_tag` / `encryption_salt` are empty strings on CDP.
- **Escrow model**: Hold = DB balance lock. Match start = contract `transferFrom`. Resolve = contract sends to winners.
- **Gasless owner**: All admin calls (createMatch, depositToEscrow, resolveMatch, cancelMatch) go through `_sendOwnerTx` → Smart Account UserOp → Paymaster. Do not revert to EOA `sendTransaction`.
- **Race conditions**: `walletRepo.acquireLock()` for wallet ops; `challengeRepo/matchRepo.atomicStatusTransition()` (BEGIN IMMEDIATE) for state transitions.
- **Cross-system busy check**: `playerStatus.js` — a user in a queue match cannot join a wager match and vice versa.
- **Pre-log pattern**: On-chain operations write a pending row BEFORE sending the tx. The deposit poller reconciles against pending rows, so internal outflows never get mislabeled as incoming deposits.
- **Idempotent approve**: `ensureApproval()` checks current allowance before re-approving.
- **UNIQUE cod_uid**: Migration 013 adds a partial unique index so no two users can register the same COD Mobile UID.
- **Admin roles**: `ADMIN_ROLE_ID`, `OWNER_ROLE_ID`, `CEO_ROLE_ID`, `ADS_ROLE_ID` — all admin-equivalent for permission checks and alert pings.

## Transaction Feed Channels

- `TRANSACTIONS_CHANNEL_ID` — Cash events: wager holds, releases, escrow in/out, deposits, withdrawals.
- `XP_TRANSACTIONS_CHANNEL_ID` — XP events: queue matches, XP challenges, nickname/XP syncs.
- Per-user DM notifications routed through `transactionFeed.js`.

## Queue System (5v5 Ranked XP)

- In-memory state (`src/queue/state.js`) — `waitingQueue` array + `activeMatches` Map. **Not persisted**; resets on restart (accepted risk C5).
- `queuePanel.js` — join/leave buttons, auto-pings configured role at 7, 8, 9 players. Panel shows comma-separated mentions of queued players. 1-hour inactivity timeout.
- Full flow: captains vote → snake-draft picks → role/weapon select → play phase (games played count) → captain result vote → XP payout.
- `queueStatsPanel.js` reads local DB. `cash_wins` / `cash_losses` columns track wager record separately from XP record.
- Subs handled in `subCommands.js`.

## Deposit Flow (Region-Based)

- **Group A** (US, UK, Canada, EU, Australia, Switzerland, Singapore, Japan): Coinbase Onramp — 0% fee.
- **Group B** (LATAM, Africa, Asia, everywhere else): Bitget Wallet app — 3–5% fee.
- Region detected from country flag at onboarding, stored in `users.deposit_region`.
- Depositor-side addresses are per-user Smart Account addresses. Poller runs every 30s with:
  - Pending-inflow window of 90 minutes
  - $0.01 dust floor
  - Skips DB-locked wallets
  - Reconciles against pre-logged outflows (no double-counting)

## XP Source of Truth

- **Local DB** is canonical for everything: current season XP (`users.xp_points`), earnings leaderboard, historical seasons (`xp_history`), cash and queue win/loss records.
- Rank roles (`rankRoleSync.js`) read directly from `users.xp_points`. Crowned tier = top N by xp_points among players past the Obsidian threshold.
- All XP deltas (wager match resolve, queue match resolve, no-shows, DQs, subs, admin adjust) write to `users.xp_points` and `xp_history` only — no external sync.

## Environment Variables

See `.env.example`. Key vars:
- `BOT_TOKEN`, `GUILD_ID`, `ADMIN_ROLE_ID`, `OWNER_ROLE_ID`, `CEO_ROLE_ID`, `ADS_ROLE_ID`
- `BASE_RPC_URL`, `BASE_RPC_URL_FALLBACK` (Alchemy + Ankr), `ESCROW_CONTRACT_ADDRESS`, `USDC_CONTRACT_ADDRESS`
- `WAGER_CHANNEL_ID`, `CHALLENGES_CHANNEL_ID`, `ADMIN_ALERTS_CHANNEL_ID`
- `TRANSACTIONS_CHANNEL_ID` (cash feed), `XP_TRANSACTIONS_CHANNEL_ID` (XP feed)
- `RANKED_QUEUE_CHANNEL_ID`, `QUEUE_STATS_CHANNEL_ID`, `WAGER_STATS_CHANNEL_ID`, `QUEUE_PING_ROLE_ID`
- `ENCRYPTION_KEY` (legacy, still required for migration compat)
- `MIN_WAGER_USDC`, `MAX_WAGER_USDC`, `MIN_WITHDRAWAL_USDC`
- `CDP_API_KEY_NAME`, `CDP_API_KEY_SECRET`, `CDP_PROJECT_ID`, `PAYMASTER_RPC_URL`, `CDP_OWNER_WALLET_DATA`
- `COINBASE_ONRAMP_APP_ID` (Group A deposits)

## Audit Status

Six rounds of security audit completed. 23 findings fixed across all rounds. Final round (R6) covered: registration races, precision, routing edge cases, season transitions. Migration 013 closes the last open finding (duplicate cod_uid via register race). Accepted residual risk: queue match state resets on bot restart (C5, documented; an in-match crash drops the lobby but no money is at stake for XP matches).

## Running

```bash
npm install
# Configure .env from .env.example
npm start        # Production
npm run dev      # Watch mode (nodemon)
```

## Smart Contract Deployment

```bash
# Set CDP credentials + BASE_RPC_URL in .env
# Fund the deployer EOA with ~$5 ETH on Base (one-time)
node scripts/create-owner-wallet.js   # Creates escrow-owner EOA + escrow-owner-smart Smart Account
node scripts/deploy-escrow.js         # Deploys + transfers ownership to escrow-owner-smart
# Copy printed ESCROW_CONTRACT_ADDRESS into .env
```
