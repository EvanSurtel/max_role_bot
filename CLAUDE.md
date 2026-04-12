# CODM Wager Bot

Discord bot for Call of Duty Mobile competitive matches. Users wager USDC on matches through button-based interactions.

## Tech Stack

- **Runtime**: Node.js
- **Discord**: discord.js v14 — buttons, modals, user select menus (NO slash commands)
- **Database**: SQLite via better-sqlite3, WAL mode, migrations in `src/database/migrations/`
- **Blockchain**: Solana — `@solana/web3.js`, `@solana/spl-token`
- **Smart Contract**: Anchor (Rust) in `programs/wager-escrow/`
- **Token**: USDC (SPL token, 6 decimals). SOL for gas only.

## Project Structure

```
src/
  index.js                    # Entry point — loads events, DB, Solana, health checks, lobby panel
  config/constants.js         # Game modes, timers, USDC/SOL constants, thresholds, cooldowns
  database/
    db.js                     # SQLite connection + migration runner
    migrations/               # Sequential SQL migrations (001–004)
    repositories/             # userRepo, walletRepo, challengeRepo, challengePlayerRepo, matchRepo, transactionRepo, evidenceRepo, pendingTxRepo
  solana/
    connection.js             # Solana RPC singleton
    walletManager.js          # Keypair generation, HKDF per-user salt + AES-256-GCM, USDC/SOL balance
    transactionService.js     # USDC/SOL transfers, ATA management
    escrowManager.js          # Hold/release (DB), transfer to escrow, disburse winnings, refund
  panels/
    lobbyPanel.js             # Main wager channel panel (Create Wager, XP Match, Wallet, Leaderboard)
    walletPanel.js            # Balance, deposit, withdraw USDC/SOL, history
    leaderboardPanel.js       # XP, earnings, wins
  interactions/
    challengeCreate.js        # Multi-step creation flow (type→size→teammates→mode→series→visibility→amount)
    challengeAccept.js        # Accept from board, opponent team formation
    challengeCancel.js        # Creator cancels challenge, refunds all
    teammateResponse.js       # Accept/decline in private notification channels
    matchResult.js            # Report win → accept/dispute → confirm → payout (replaces blind voting)
    onboarding.js             # TOS accept → wallet creation
  services/
    matchService.js           # Create match channels, start match, resolve, cleanup
    challengeService.js       # Notify teammates, post to board, cancel
    depositService.js         # Poll Solana every 30s for USDC deposits
    reconciliationService.js  # Compare on-chain vs DB balances every 5min
    healthService.js          # Escrow SOL monitoring, daily summary, match creation gating
    timerService.js           # DB-backed persistent timers
    timerHandlers.js          # challenge_expiry, teammate_accept, match_inactivity handlers
    neatqueueService.js       # Sync XP to NeatQueue bot via REST API
    channelService.js         # Create/delete private channels
    onboardingService.js      # Welcome channel + TOS embed
  events/
    interactionCreate.js      # Master router — all buttons, modals, selects
    guildMemberAdd.js         # Trigger onboarding
    guildMemberRemove.js      # Cancel forming challenges, auto-dispute active matches
    ready.js                  # Log bot login
  utils/
    crypto.js                 # AES-256-GCM + HKDF per-user key derivation
    embeds.js                 # Discord embed builders, formatUsdc()
    permissions.js            # Channel permission overwrite helpers
    solCheck.js               # SOL balance validation before on-chain actions
    rateLimiter.js            # In-memory per-user action cooldowns
    adminAudit.js             # Admin action logging to admin_actions table
programs/
  wager-escrow/               # Anchor smart contract (Rust)
    src/lib.rs                # create_match, deposit_to_escrow, resolve_match, cancel_match
legacy/                       # Old XRP code, slash commands, captainVote (preserved, not loaded)
```

## Key Conventions

- **No slash commands** — All user interactions via button panels in the wager channel
- **No DMs** — All notifications via private server channels
- **Amounts**: Stored as strings in USDC smallest units (6 decimals: 1 USDC = 1000000). Use `BigInt` for arithmetic.
- **DB columns**: `_usdc` suffix for amounts, `solana_address`, `solana_tx_signature`
- **Wallet security**: Per-user salt → HKDF key derivation → AES-256-GCM encryption. Stored as `encrypted_private_key` + `encryption_iv` + `encryption_tag` + `encryption_salt`
- **Escrow model**: Hold = DB-level balance lock. Match start = on-chain USDC transfer to escrow. Resolve = on-chain transfer to winners.
- **SOL checks**: Always verify SOL >= MIN_SOL_FOR_GAS before any on-chain action
- **Race conditions**: walletRepo.acquireLock() for wallet ops, challengeRepo.atomicStatusTransition() for challenge acceptance
- **Admin audit**: All admin actions logged to admin_actions table via adminAudit.logAdminAction()

## Match Result Flow

1. Captain clicks **Report Win** → opponent sees claim with Accept/Dispute buttons (10 min timeout)
2. Accept → confirmation screen ("Are you sure? They won. You lose the pot.") → Yes/Go Back
3. Dispute → dispute text + voice channels created, evidence submission via modal, admin resolves
4. No response in 10 min → auto-dispute
5. Match inactivity (24h no report) → auto-dispute

## Database Tables (11 total)

users, wallets, challenges, challenge_players, matches, transactions, timers, admin_actions, evidence, pending_transactions, moonpay_transactions

## MoonPay Fiat On-Ramp / Off-Ramp

Users can deposit via card / Apple Pay / Google Pay and cash out to bank through MoonPay's widget. Integrated as two Primary buttons on the wallet panel (second row), each gated on configuration state.

### Architecture

```
User clicks "Deposit using Credit/Debit Card"
  ↓
walletPanel → moonpayService.initiateOnramp(userId)
  ↓
  inserts pending row in moonpay_transactions (external_id = UUID)
  moonpay.js builds signed URL via HMAC-SHA256(url.search, sk_...)
  ↓
bot replies with ephemeral "Open MoonPay" link button
  ↓
user completes purchase on buy-sandbox.moonpay.com / buy.moonpay.com
  ↓
  MoonPay sends USDC to the user's bot wallet address (pre-filled in URL)
  depositService polls every 30s, credits the user's DB balance
  ↓
  optional: MoonPay webhooks → webhookServer → moonpayService.handleWebhook
    updates moonpay_transactions row with moonpay_id + fiat details
    posts status updates to #transactions feed
```

Off-ramp is more involved because MoonPay generates the deposit address asynchronously:

```
User clicks "Cash Out to Bank" (only visible if webhooks are configured)
  ↓
walletPanel → moonpayService.initiateOfframp(userId)
  ↓
bot replies with ephemeral "Open MoonPay" link button
  ↓
user completes bank form on sell-sandbox.moonpay.com / sell.moonpay.com
  ↓
MoonPay creates sell transaction → webhook "transaction_created"
  bot updates moonpay_transactions row with moonpay_id + fiat amount
  ↓
MoonPay generates deposit address → webhook "transaction_updated" status=waitingForDeposit
  moonpayService._executeOfframpTransfer:
    acquires wallet lock → signs USDC transfer from user's bot wallet
    → MoonPay's deposit address → debits balance_available → stores signature
  ↓
MoonPay sees USDC arrive → converts to fiat → pays user's bank
  final "transaction_updated" status=completed webhook closes the row
```

### Files
- `src/services/moonpay.js` — URL signing (HMAC-SHA256), webhook signature verification, config checks (`isConfigured` for on-ramp, `isOfframpConfigured` for off-ramp)
- `src/services/moonpayService.js` — initiate flows, handle webhooks, drive off-ramp USDC transfers, idempotent via `deposit_tx_signature`
- `src/services/webhookServer.js` — Express HTTP server on `WEBHOOK_PORT` (default 3001), routes `POST /webhooks/moonpay` and `GET /health`, verifies signatures with `express.raw` body preserved
- `src/database/migrations/006_moonpay_transactions.sql` — correlation table
- `src/panels/walletPanel.js` + `walletPanelView.js` — button wiring, conditional visibility

### Button visibility rules
- **💳 Deposit using Credit/Debit Card** — shown if `MOONPAY_API_KEY` + `MOONPAY_SECRET_KEY` are set. Deposits work even without webhooks because the existing deposit poller credits the user once USDC arrives on-chain.
- **🏦 Cash Out to Bank** — shown ONLY if ALSO `MOONPAY_WEBHOOK_SECRET` + `WEBHOOK_PUBLIC_URL` are set. Hidden by default so users can't start a flow that would silently strand.

### Deployment
- **Sandbox**: run `ngrok http 3001` on the bot server, paste the `https://xxxxx.ngrok-free.app` URL into the MoonPay dashboard webhook config, set that same URL as `WEBHOOK_PUBLIC_URL` in `.env`.
- **Production**: put nginx/Caddy/Cloudflare in front, reverse proxy `/webhooks/*` to `localhost:3001`, use a real domain with TLS, point the MoonPay production dashboard webhook at `https://your-domain.com/webhooks/moonpay`.

### Env vars
```
MOONPAY_ENV=sandbox                  # or "production"
MOONPAY_API_KEY=pk_test_...           # pk_live_... in production
MOONPAY_SECRET_KEY=sk_test_...        # sk_live_... in production — used for URL signing
MOONPAY_WEBHOOK_SECRET=whsec_...      # from MoonPay webhook dashboard
WEBHOOK_PORT=3001
WEBHOOK_PUBLIC_URL=https://your-domain-or-ngrok.tld
```

## Environment Variables

See `.env.example` for full list. Key vars:
- `BOT_TOKEN`, `GUILD_ID`, `ADMIN_ROLE_ID`, `OWNER_ROLE_ID`, `CEO_ROLE_ID`, `ADS_ROLE_ID` (owner, CEO, and ads are admin-equivalent — same permissions and alert pings)
- `WAGER_CHANNEL_ID`, `CHALLENGES_CHANNEL_ID`, `ADMIN_ALERTS_CHANNEL_ID`
- `SOLANA_NETWORK`, `ESCROW_WALLET_SECRET`, `ENCRYPTION_KEY`
- `PLATFORM_FEE_PERCENT`, `MIN_WAGER_USDC`, `MAX_WAGER_USDC`, `MIN_WITHDRAWAL_USDC`
- `MIN_SOL_FOR_GAS`, `ESCROW_SOL_WARNING_THRESHOLD`, `ESCROW_SOL_CRITICAL_THRESHOLD`
- `MATCH_INACTIVITY_HOURS`

## Running

```bash
npm install
# Set up .env from .env.example
npm start        # Production
npm run dev      # Watch mode
```

## Smart Contract

```bash
anchor build
anchor deploy
# Update program ID in Anchor.toml and lib.rs after first deploy
```
