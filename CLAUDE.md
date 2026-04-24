# Rank $ CODM Wager Bot

Discord bot for Call of Duty Mobile competitive matches. Users wager USDC on matches through button-based interactions. Also runs a 5v5 ranked XP queue system.

Custody model is **self-custody**: every user owns their own Coinbase Smart Wallet, locked by their own passkey. The bot is a bounded spender only, gated by user-signed EIP-712 SpendPermissions. Coinbase CDP Onramp/Offramp approved this architecture in review (April 2026).

## Tech Stack

- **Runtime**: Node.js (bot) + Next.js 15 App Router (web surface)
- **Discord**: discord.js v14 — buttons, modals, user select menus (NO slash commands except /rank)
- **Database**: SQLite via better-sqlite3, WAL mode, migrations in `src/database/migrations/` (001–022)
- **Blockchain**: Base mainnet (Coinbase L2, chain ID 8453) — `ethers.js` v6 with FallbackProvider (primary + fallback RPC); `viem` v2 for ERC-6492-aware EIP-712 signature verification on the bot side
- **Smart Contract**: `contracts/WagerEscrow.sol` — production at `0x2DabDC8E1Cc7580f07e5807e72ecF23c5D2AeB59`. Entry points: `createMatch`, `depositToEscrow` (legacy users, user self-approved), `depositFromSpender` (self-custody users, spender-approved via SPM), `resolveMatch`, `cancelMatch`, `emergencyWithdraw` (unallocated only). Tracks `totalActiveEscrow`.
- **SpendPermissionManager**: Coinbase singleton on Base at `0xf85210B21cC50302F477BA56686d2019dC9b67Ad`. Mediates every self-custody user→escrow pull via `spend(permission, amount)`.
- **Wallets**:
  - *Self-custody (default for new registrations, April 2026 onward)*: user-owned Coinbase Smart Wallet (ERC-4337), passkey-gated, created in the user's browser via the Coinbase Smart Wallet SDK on `keys.coinbase.com`. User is the sole owner. The bot never holds, sees, or can derive the signing key.
  - *Legacy*: CDP Smart Accounts (ERC-4337) created for users who onboarded before the migration. Keys held by Coinbase CDP, never stored locally. The legacy code path still works; legacy users can migrate via the "Upgrade to Self-Custody" button.
- **Gas**: 100% gasless at runtime via CDP Paymaster (UserOps). The `escrow-owner` EOA signs ONE transaction ever (deploy + transferOwnership). The runtime owner is a Smart Account (`escrow-owner-smart`, currently `0x407AA75dC2f0D3B7A50dceCbC4BC061Ff92542e6`) routed via `_sendOwnerTx` / `_sendOwnerTxBatch`.
- **Token**: USDC (ERC-20, 6 decimals) at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. ETH used only for edge-case admin withdrawals.
- **Web hosting**: Next.js app in `web/` deployed on Vercel (`max-role-bot.vercel.app`). Serves `/setup`, `/renew`, `/withdraw`, and the Coinbase Onramp/Offramp clientIp bridges at `/deposit/coinbase` + `/cashout/coinbase`.
- **Bot ↔ Web auth**: shared HMAC secret (`WALLET_WEB_INTERNAL_SECRET` on bot, `BOT_API_SHARED_SECRET` on Vercel — same value), compared constant-time. Bot exposed to Vercel via Cloudflare quick tunnel (`cloudflared` running as a systemd service on the Oracle host).
- **NOT Solana, NOT Ethereum mainnet, NOT Polygon. Base only.**

## Architecture

Self-custody flow (every new user from April 2026 onward):

```
Register          → TOS accepted, NO CDP wallet created
                  → Bot mints a one-time /setup link nonce (24h TTL)
                  → Shown inline to the user with the link

User completes /setup (in browser)
                  → Passkey ceremony at keys.coinbase.com (email + passkey)
                  → Coinbase Smart Wallet minted — user is sole owner
                  → User picks daily match limit, signs EIP-712 SpendPermission
                  → Web POSTs signed grant to bot's internal endpoint

Bot persists grant → Calls SpendPermissionManager.approveWithSignature
                    via the escrow-owner-smart Smart Account (gasless)
                   → On confirmation: wallet.address flipped to user's
                     Smart Wallet; wallet_type = 'coinbase_smart_wallet'

Deposit           → User clicks Coinbase/Wert/Transak in Discord
                    (Coinbase routes through /deposit/coinbase on web
                     to attach a real clientIp per CDP requirements;
                     Wert/Transak mint server-side)
                  → USDC arrives directly in the user's own Smart Wallet

Match starts      → Atomic UserOp from escrow-owner-smart:
                    1. SpendPermissionManager.spend(perm, entry) —
                       pulls USDC from user's Smart Wallet to spender
                    2. WagerEscrow.depositFromSpender(matchId, player,
                       source=spender) — pulls from spender into escrow
                  → totalActiveEscrow increments

Match resolves    → WagerEscrow.resolveMatch pays winners to their own
                    Smart Wallets
                  → totalActiveEscrow decrements

User withdraws    → Bot DMs a /withdraw link
                  → User signs USDC.transfer(to, amount) with their
                    passkey on the web surface — bot has no signing
                    authority over withdrawals (FinCEN "unhosted wallet"
                    posture preserved)
```

Legacy (pre-migration) users still have `wallet_type = 'cdp_server'` and keep working on the original path: bot-signed USDC transfers, CDP-held key material. They can click the "Upgrade to Self-Custody" button at any time to migrate. `scripts/migrate-funds-to-smart-wallet.js` sweeps leftover USDC from the legacy CDP address into their new Smart Wallet after setup.

Every arrow is an on-chain Base transaction with a hash on BaseScan. All bot-side on-chain calls route through the escrow-owner-smart Smart Account → UserOp → Paymaster → zero gas cost.

## CDP Custody Invariants

These are non-negotiable rules that the CDP review signed off on. Any code change that touches wallets / onramp / spend-permissions must preserve every one:

1. **Onramp destination** is always the user's own Smart Wallet, never a pooled or operator-held address.
2. **Withdrawals** are unrestricted/ungated — user-signed via passkey on the web surface, no admin gating, no amount cap, no KYC step. Preserves the FinCEN "unhosted wallet" posture.
3. **No `addOwnerAddress`** making the operator a co-owner of a Smart Wallet. Coinbase Smart Wallet ownership is any-of-N, so co-ownership gives the operator *more* control not less.
4. **Operator is only ever a spender**, never a wallet owner. The `escrow-owner-smart` Smart Account holds no user funds directly.
5. **`clientIp`** on every CDP session-token request must be the real end-user IP captured on the web surface (`x-real-ip` / `x-vercel-forwarded-for`). Never the bot's server IP, never browser-controlled `x-forwarded-for` leftmost.
6. **User-facing language** describes custody in Coinbase's own terms: "self-custodied", "passkey-gated", "TEE-gated" (for CDP Server Wallet users).
7. **Per-user wallet isolation** is architectural. No operator-held mixed pools — match escrow goes through the `WagerEscrow` contract whose `totalActiveEscrow` is allocated per match.

See `memory/feedback_cdp_custody_invariants.md` for the full rules and rationale.

## Project Structure

```
src/
  index.js                        # Entry point — events, DB, Base connection,
                                  # webhook server, SPM event listener, panels
  config/constants.js             # Game modes, timers, USDC constants, thresholds
  database/
    db.js                         # SQLite connection + migration runner
    migrations/                   # Sequential SQL (001–022)
                                  # 020 — self-custody schema (spend_permissions,
                                  # discord_link_nonces, wallet_type, smart_wallet_address)
                                  # 021 — link_nonce metadata JSON column
                                  # 022 — wallets.legacy_cdp_address
    repositories/                 # userRepo, walletRepo, challengeRepo,
                                  # matchRepo, transactionRepo, evidenceRepo,
                                  # pendingTxRepo, spendPermissionRepo,
                                  # linkNonceRepo
  base/
    connection.js                 # FallbackProvider (Alchemy primary + Ankr fallback)
    walletManager.js              # CDP Smart Account creation (legacy path)
    transactionService.js         # ERC-20 USDC transfers + _sendOwnerTx(Batch)
                                  # for gasless admin UserOps
    escrowManager.js              # DB-side hold/release + contract interactions.
                                  # depositToEscrow branches on wallet_type:
                                  # legacy → transferFrom(player); self-custody →
                                  # atomic (SPM.spend + depositFromSpender) batch
    depositService.js             # 30s poll, pre-log reconciliation
  queue/                          # 5v5 ranked XP queue (in-memory state)
    state.js, matchLifecycle.js, captainVote.js, captainPick.js,
    roleSelect.js, playPhase.js, subCommands.js, interactions.js,
    helpers.js, index.js
  panels/
    lobbyPanel.js, queuePanel.js, queueStatsPanel.js, wagerStatsPanel.js,
    leaderboardPanel.js, seasonPanel.js, escrowPanel.js, ranksPanel.js,
    howItWorksPanel.js, rulesPanel.js, welcomePanel.js, xpMatchPanel.js,
    publicWalletPanel.js, adminWalletViewerPanel.js, walletPanelView.js,
    coinbaseReviewDemoPanel.js   # Public CDP review/demo channel
    wallet/                       # Wallet panel router + sub-flows
      index.js                    # Router
      viewOpen.js                 # "View My Wallet" button
      deposit.js                  # Deposit provider picker + handlers
                                  # (CDP Onramp routes to web bridge
                                  # for real clientIp)
      cashOut.js                  # Cash out provider picker + handlers
                                  # (CDP Offramp routes to web bridge)
      withdraw.js, withdrawEth.js, withdrawMenu.js  # Legacy withdraw
      selfCustodySetup.js         # "Upgrade to Self-Custody" button
                                  # (legacy users migrating)
      selfCustodyWithdraw.js      # Smart-wallet users withdraw via web
      pendingSetup.js             # Shown when user registered but
                                  # hasn't completed /setup yet
      history.js, refresh.js
  interactions/
    challengeCreate.js, challengeAccept.js, challengeCancel.js,
    teammateResponse.js, disputeCreate.js
    onboarding.js                 # Self-custody-first: TOS → region →
                                  # country → COD form → mint setup link
                                  # (new users skip CDP wallet creation)
    languageSwitcher.js, perMessageLanguage.js, adminWalletViewer.js
    matchResult/                  # Split match result handling
      index.js, reporting.js, noShow.js, dispute.js,
      adminResolve.js, disputeResult.js, helpers.js
  services/
    match/                        # Split match flow
      index.js, createChannels.js, startMatch.js, resolveMatch.js,
      cleanup.js, helpers.js
    matchService.js               # Legacy re-export shim
    challengeService.js, channelService.js, reconciliationService.js,
    healthService.js, timerService.js, timerHandlers.js,
    changellyService.js, bitrefillService.js, paymentRouter.js,
    cdpTrialService.js, wertKycRepo.js, walletChannelMigration.js
    coinbaseOnrampService.js      # createOneClickBuySession +
                                  # createSessionToken, both accept
                                  # clientIp and include it in the body
    spendPermissionService.js     # EIP-712 sig verification (viem, ERC-
                                  # 6492-capable), recordUserGrant,
                                  # approveOnChain (also flips wallet
                                  # row to self-custody), spendForUser,
                                  # buildSpendCalls (used by escrowManager
                                  # for atomic match-deposit batch),
                                  # revokePermission
    spendPermissionEventListener.js  # Bounded-chunk eth_getLogs poll
                                  # for SpendPermissionRevoked events
                                  # scoped to our spender (user-initiated
                                  # revokes caught in real time)
    linkNonceService.js           # One-time link mint + peek + redeem
                                  # (purposes: setup, renew, withdraw,
                                  # deposit-cdp, cashout-cdp)
    webhookServer.js              # Express HTTP server on :3001.
                                  # Changelly + CDP webhooks; internal
                                  # auth-gated endpoints:
                                  # /api/internal/link/{peek,redeem}
                                  # /api/internal/wallet/grant
                                  # /api/internal/wallet/observed-revoke
                                  # /api/internal/cdp/onramp/mint
                                  # /api/internal/cdp/offramp/mint
  commands/
    rank.js                       # /rank slash command + rank card builder
    rank-context.js               # Right-click "View Rank" user context menu
  utils/
    reviewerWhitelist.js          # ensureReviewerUser() auto-provisions
                                  # minimal user rows for anyone clicking
                                  # in the review demo channel
    crypto.js                     # AES-256-GCM + HKDF per-user key
                                  # (legacy, unused on self-custody path)
    embeds.js, rankCardRenderer.js, rankRoleSync.js, transactionFeed.js,
    nicknameUpdater.js, playerStatus.js, rateLimiter.js, matchTimer.js,
    mapPicker.js, xpCalculator.js, ephemeralReply.js,
    ephemeralPanelDispatcher.js, languageButtonHelper.js,
    languageRefresh.js, challengeLabel.js, permissions.js, adminAudit.js

web/                              # Next.js 15 App Router on Vercel
  app/
    layout.tsx, page.tsx, providers.tsx, globals.css
    setup/                        # First-time passkey + SpendPermission sign
      page.tsx, SetupClient.tsx
    renew/                        # Re-sign an expired SpendPermission
      page.tsx                    # (reuses SetupClient with purpose='renew')
    withdraw/                     # Passkey-signed USDC.transfer
      page.tsx, WithdrawClient.tsx
    deposit/coinbase/             # Onramp clientIp bridge
      page.tsx, DepositCoinbaseClient.tsx
    cashout/coinbase/             # Offramp clientIp bridge
      page.tsx, CashoutCoinbaseClient.tsx
    api/
      link/peek/route.ts          # Proxies to bot's /api/internal/link/peek
      link/redeem/route.ts        # Proxies to bot's /api/internal/link/redeem
      wallet/grant/route.ts       # Proxies to bot's /api/internal/wallet/grant
      deposit/coinbase/mint/route.ts   # Captures client IP from x-real-ip,
                                       # forwards to bot's onramp mint endpoint
      cashout/coinbase/mint/route.ts   # Same pattern for Offramp
      health/route.ts

contracts/
  WagerEscrow.sol                 # createMatch, depositToEscrow,
                                  # depositFromSpender, resolveMatch,
                                  # cancelMatch, emergencyWithdraw

scripts/
  deploy-escrow.js                # Deploy + transferOwnership +
                                  # escrow-owner-smart → WagerEscrow
                                  # USDC approve (needed for depositFromSpender)
  approve-escrow-from-spender.js  # Standalone/recovery: escrow-owner-smart
                                  # USDC.approve(WagerEscrow, MAX). Idempotent.
  migrate-funds-to-smart-wallet.js  # Sweep USDC from legacy CDP Server
                                  # Wallet → user's Smart Wallet after they
                                  # complete /setup. --dry-run by default.
  create-owner-wallet.js          # Creates escrow-owner EOA +
                                  # escrow-owner-smart Smart Account
  emergency-cancel-match.js       # Break-glass recovery for stuck matches
  diagnose-balances.js            # On-chain vs DB reconciliation
  backup-db.sh                    # Daily DB backup, 30-day retention

memory/                           # Auto-memory files for future sessions
  MEMORY.md                       # Index
  project_overview.md
  project_cdp_self_custody.md     # The custody architecture + why
  feedback_cdp_custody_invariants.md  # The 7 hard rules above
  feedback_no_dms.md, feedback_dm_exceptions.md,
  feedback_display_names_pattern.md, feedback_no_slash_commands.md,
  feedback_panel_toggles_in_place.md, feedback_language_system.md
```

## Key Conventions

- **No slash commands** except `/rank`. All user interactions via button panels.
- **No DMs for notifications** — private server channels only. Exceptions: teammate invites (DM-first w/ channel fallback), rank promotion/demotion, and the "Upgrade to Self-Custody" / withdraw link delivery (DM-first with ephemeral fallback — both contain one-time tokens, DM is the right channel for private credential-adjacent material).
- **Panel toggles in place**: toggle buttons (language, filter, etc.) must `interaction.update()` the original message. No new ephemeral replies.
- **Display names**: never rely on `<@id>` alone in embed field values. Plain text first, mention as fallback.
- **Amounts**: Stored as strings in USDC smallest units (6 decimals). Use `BigInt` for arithmetic.
- **Legacy columns**: `solana_address` stores Base addresses; `solana_tx_signature` stores Base tx hashes. `encryption_iv` / `encryption_tag` / `encryption_salt` are empty strings on CDP. `account_ref` is `'self-custody'` for self-custody wallets (satisfies legacy NOT NULL while clearly marking the row as non-CDP on inspection). `legacy_cdp_address` preserves the pre-migration CDP Smart Account address so the sweep script can withdraw from it.
- **Escrow model (legacy)**: Hold = DB balance lock. Match start = contract `transferFrom(player, ...)`. Resolve = contract sends to winners.
- **Escrow model (self-custody)**: Hold = DB balance lock. Match start = atomic UserOp from escrow-owner-smart containing `SpendPermissionManager.spend` + `WagerEscrow.depositFromSpender`. Resolve = contract sends to winners (same function, same code path).
- **Gasless owner**: All admin calls go through `_sendOwnerTx` / `_sendOwnerTxBatch` → Smart Account UserOp → Paymaster. Never revert to EOA `sendTransaction` at runtime.
- **Atomic self-custody deposit**: The SPM.spend + depositFromSpender pair MUST be batched in one UserOp (via `_sendOwnerTxBatch`). Never as two separate UserOps — a partial failure between them would orphan USDC at `escrow-owner-smart` and break the cancel-refund path.
- **Race conditions**: `walletRepo.acquireLock()` for wallet ops; `challengeRepo/matchRepo.atomicStatusTransition()` (BEGIN IMMEDIATE) for state transitions.
- **Cross-system busy check**: `playerStatus.js` — a user in a queue match cannot join a wager match and vice versa.
- **Pre-log pattern**: On-chain operations write a pending transaction row BEFORE sending the tx. The deposit poller reconciles against pending rows.
- **SpendPermission signature verification**: Synchronous via viem's `verifyTypedData` (ERC-6492-capable via universal validator). Forged sigs rejected before any DB write — never defer to on-chain `approveWithSignature` as the only check.
- **Nonce binding on grants**: `/api/internal/wallet/grant` consumes the setup nonce atomically in the same request; the nonce's stored `user_id` must match the `userId` in the grant body. Prevents a compromised web layer from rebinding wallet addresses.
- **wallet.address flip happens AFTER on-chain approve confirms**, not at grant intake. `spendPermissionService.approveOnChain` owns the wallet-row creation/update as a side effect — any code path that approves a permission also flips the wallet, so manual retries don't skip it.
- **Demo channel fast path**: anyone clicking View My Wallet in the channel `DEMO_CHANNEL_ID` gets auto-provisioned (see `utils/reviewerWhitelist.js` — misnomer, no whitelist enforced, any Discord ID works) with a minimal user row and an ephemeral setup link. Scoped to that channel only.
- **Admin roles**: `ADMIN_ROLE_ID`, `OWNER_ROLE_ID`, `CEO_ROLE_ID`, `ADS_ROLE_ID` — all admin-equivalent.

## Self-Custody Wallet Lifecycle

```
users.wallets row state transitions:

(no row)                    Fresh registration, no wallet yet
   │
   │  User completes /setup, signs SpendPermission, approveOnChain
   │  confirms on-chain
   ▼
wallet_type = 'coinbase_smart_wallet'
address = user's Smart Wallet address (same value as smart_wallet_address)
account_ref = 'self-custody'
legacy_cdp_address = NULL

--- OR (legacy user) ---

wallet_type = 'cdp_server'         (pre-migration state)
address = CDP Smart Account address
account_ref = CDP account name
   │
   │  User clicks "Upgrade to Self-Custody", completes /setup
   ▼
wallet_type = 'coinbase_smart_wallet'
smart_wallet_address = Smart Wallet address
legacy_cdp_address = <old CDP address>   (preserved for sweep)
address = Smart Wallet address            (flipped)
account_ref = <old CDP account name>      (not cleared — harmless)
   │
   │  Operator runs `node scripts/migrate-funds-to-smart-wallet.js --user <id>`
   ▼
Legacy CDP wallet drained into new Smart Wallet
```

## Deposit / Onramp Flow

- **Coinbase Onramp** (free, preferred where available): user clicks Coinbase in the deposit picker → bot mints a one-time link + DMs `/deposit/coinbase?t=<nonce>` → user's browser loads the Vercel page → Vercel captures `x-real-ip` → forwards `{nonce, clientIp}` to bot's `/api/internal/cdp/onramp/mint` → bot calls `createOneClickBuySession` with `clientIp` in the body → returns the Coinbase Onramp URL → web redirects the user. Destination is always the user's own Smart Wallet address.
- **Wert** (card, Changelly-routed): Server-side mint, redirects to a card-payment flow. US users must have a state on file (modal prompts for it if missing).
- **Transak** (card, Changelly-routed): Same pattern, different rail, no Wert LKYC lifetime cap.
- **Region-aware picker**: `paymentRouter.getOnrampOptions({ country, amountUsd })` decides which options to show. Coinbase is available in Group A countries (US, CA, EU, UK, etc.); Wert/Transak cover the rest. The review demo channel overrides country to `US` and passes `demo=true` so reviewers see every provider regardless of their actual IP.

## Cash Out / Offramp Flow

- **Coinbase Offramp**: same web-bridge pattern as Onramp — bot mints a link, Vercel captures clientIp, forwards to bot's `/api/internal/cdp/offramp/mint` → `createSessionToken` with `clientIp` → Vercel redirects to `https://pay.coinbase.com/v3/sell/input?sessionToken=...`.
- **Transak sell**: Changelly-routed card cash-out.
- **Bitrefill**: gift-card cash-out for regions without easy card offramp.

## Queue System (5v5 Ranked XP)

- In-memory state (`src/queue/state.js`) — `waitingQueue` array + `activeMatches` Map. Persisted to `queue_matches` table via migration 019; rehydrated on bot startup by `queueState.recoverFromDb()` before any Discord interactions are processed.
- `queuePanel.js` — join/leave buttons, auto-pings at 7, 8, 9 players; 1-hour inactivity timeout.
- Full flow: captains vote → snake-draft picks → role/weapon select → play phase → captain result vote → XP payout.
- Subs via `subCommands.js`.

## XP Source of Truth

- **Local DB** is canonical. Current season XP (`users.xp_points`), earnings, historical seasons (`xp_history`), cash/queue win-loss records.
- Rank roles (`rankRoleSync.js`) read directly from `users.xp_points`. Crowned tier = top N by `xp_points` among players past the Obsidian threshold.
- All XP deltas (wager resolve, queue resolve, no-shows, DQs, subs, admin adjust) write to `users.xp_points` and `xp_history`.

## Environment Variables

See `.env.example`. Key vars:

**Discord / game config**
- `BOT_TOKEN`, `GUILD_ID`, `ADMIN_ROLE_ID`, `OWNER_ROLE_ID`, `CEO_ROLE_ID`, `ADS_ROLE_ID`
- `WAGER_CHANNEL_ID`, `CHALLENGES_CHANNEL_ID`, `ADMIN_ALERTS_CHANNEL_ID`
- `TRANSACTIONS_CHANNEL_ID`, `XP_TRANSACTIONS_CHANNEL_ID`
- `RANKED_QUEUE_CHANNEL_ID`, `QUEUE_STATS_CHANNEL_ID`, `WAGER_STATS_CHANNEL_ID`, `QUEUE_PING_ROLE_ID`
- `DEMO_CHANNEL_ID` (optional — public review/demo channel where unregistered users can exercise the wallet flow)
- `MIN_WAGER_USDC`, `MAX_WAGER_USDC`, `MIN_WITHDRAWAL_USDC`
- `MEMBER_ROLE_ID`

**On-chain / Base**
- `BASE_RPC_URL`, `BASE_RPC_URL_FALLBACK` (Alchemy primary + Ankr fallback)
- `ESCROW_CONTRACT_ADDRESS` (current: `0x2DabDC8E1Cc7580f07e5807e72ecF23c5D2AeB59`)
- `USDC_CONTRACT_ADDRESS` (Base mainnet USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
- `BASE_NETWORK` (`mainnet` default; `sepolia` for testnet)

**CDP (Server Wallets, Paymaster, Onramp)**
- `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` (secret API key for SDK JWT auth)
- `CDP_PROJECT_ID`
- `CDP_OWNER_ADDRESS` (escrow-owner-smart Smart Account address, needed by SPM event listener and escrow admin calls)
- `PAYMASTER_RPC_URL` (copy exactly from CDP Portal → Paymaster → Configuration)
- `CDP_WEBHOOK_SECRET` (for CDP Onramp/Offramp webhook signature verification)

**Self-custody web surface**
- `WALLET_WEB_BASE_URL` (e.g. `https://max-role-bot.vercel.app`)
- `WALLET_WEB_INTERNAL_SECRET` (shared HMAC with Vercel's `BOT_API_SHARED_SECRET` — same value both sides)
- `ENABLE_SPM_LISTENER` (default `true`; set `false` to disable the revoke event poller — lazy reconcile via failed spendForUser still catches revokes)

**Changelly (Wert / Transak)**
- `CHANGELLY_API_KEY`, `CHANGELLY_SECRET_KEY`, `CHANGELLY_CALLBACK_PUBLIC_KEY`

**Other**
- `ENCRYPTION_KEY` (legacy, still required for migration compat)
- `WEBHOOK_PORT` (default 3001)

## Vercel Env Vars (web/)

Configured in Vercel Project Settings. Five total:

- `BOT_API_BASE_URL` — the Cloudflare tunnel URL pointing to the bot's webhook server (e.g. `https://<random>.trycloudflare.com`). Rotates when cloudflared restarts.
- `BOT_API_SHARED_SECRET` — same hex value as the bot's `WALLET_WEB_INTERNAL_SECRET`.
- `NEXT_PUBLIC_CDP_PROJECT_ID` — same as the bot's `CDP_PROJECT_ID`.
- `NEXT_PUBLIC_BASE_RPC_URL` — `https://mainnet.base.org` (public endpoint; fine for browser-side wagmi use).
- `NEXT_PUBLIC_BOT_SPENDER_ADDRESS` — same as the bot's `CDP_OWNER_ADDRESS` (escrow-owner-smart address, embedded in the SpendPermission struct as `spender`).

## CDP Paymaster Allowlist

Configure in CDP Portal → Paymaster → Configuration → Contract allowlist. Three contracts must be present:

- **USDC** (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) — functions: `approve(address,uint256)`, `transfer(address,uint256)`
- **WagerEscrow** (current: `0x2DabDC8E1Cc7580f07e5807e72ecF23c5D2AeB59`) — all functions
- **SpendPermissionManager** (`0xf85210B21cC50302F477BA56686d2019dC9b67Ad`) — selectors `0xb9ffc8e1` (approveWithSignature), `0x415a9735` (spend), `0xb2c2b019` (revokeAsSpender)

Missing any of the above → UserOps targeting that contract fail at the bundler with "sender balance and deposit together is 0 but must be at least N to pay for this operation" (AA21 in the background). Paymaster Error Logs tab shows no entries because the call never reaches the Paymaster validation stage — it's rejected at the bundler's allowlist check.

## Audit Status

Six rounds of pre-self-custody security audit completed (23 findings fixed). Self-custody migration audit (April 2026) found 4 critical (C1 grant binding, C2 clientIp spoofing, C3 atomic deposit / cancel filter) + 6 high (H1–H6) issues; all fixed. Accepted residual risks: queue match state resets on bot restart (C5 — documented, no money at stake); CDP Paymaster rate-limit could throttle simultaneous admin ops under load (mitigated by the 50 RPS CDP cap being well above expected load).

## Running

```bash
# Bot (on Oracle)
npm install
# Configure .env from .env.example
npm start        # Production (or `pm2 start src/index.js --name wager-bot`)
npm run dev      # Watch mode (nodemon)

# Web (local dev)
cd web
npm install
npm run dev      # Next.js dev server on :3100
```

## Smart Contract Deployment

```bash
# Set CDP credentials + BASE_RPC_URL in .env
# Fund the deployer EOA (`escrow-owner`) with ~$5 ETH on Base (one-time)
node scripts/create-owner-wallet.js     # Creates escrow-owner EOA + escrow-owner-smart Smart Account
node scripts/deploy-escrow.js           # Deploys + transferOwnership + escrow-owner-smart USDC approve
# Copy printed ESCROW_CONTRACT_ADDRESS into .env
# Add the new contract to the CDP Paymaster allowlist (all functions)
# If deploy-time USDC approve failed (e.g., Paymaster wasn't ready):
node scripts/approve-escrow-from-spender.js   # Idempotent retry
# Restart the bot to pick up the new contract address
```

## Web Deployment (Vercel)

```bash
# Push to main — Vercel auto-deploys from GitHub if the project is wired.
# Otherwise, from web/:
cd web
vercel deploy --prod

# After deploy, ensure the 5 env vars above are set (Project Settings →
# Environment Variables → Production). Redeploy if you changed any.
```

## Cloudflare Tunnel (Bot ↔ Vercel bridge)

```bash
# On Oracle. One-time setup:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o cloudflared
sudo mv cloudflared /usr/local/bin/ && sudo chmod +x /usr/local/bin/cloudflared

# Install as systemd service so it survives reboots:
sudo tee /etc/systemd/system/cloudflared-rank.service > /dev/null <<'EOF'
[Unit]
Description=Cloudflare quick tunnel to localhost:3001
After=network-online.target
Wants=network-online.target

[Service]
User=ubuntu
ExecStart=/usr/local/bin/cloudflared tunnel --url http://localhost:3001
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-rank

# Grab the URL:
sudo journalctl -u cloudflared-rank --since today | grep trycloudflare.com
# → paste the printed URL into Vercel's BOT_API_BASE_URL env var
```

Quick tunnels rotate the URL every time `cloudflared` restarts. For a permanent URL, point a domain at a named tunnel — otherwise you'll update `BOT_API_BASE_URL` after any cloudflared outage.

## Self-Custody Migration Operational Notes

- **New contract + new allowlist rules must be in place before any self-custody user can join a match.** The bot's atomic deposit UserOp touches USDC.approve (initially, from escrow-owner-smart), SPM.approveWithSignature, SPM.spend, and WagerEscrow.depositFromSpender. Missing any in the allowlist → AA21 errors.
- **escrow-owner-smart must have USDC.approve(WagerEscrow, MAX) on-chain** before any self-custody match can start. `deploy-escrow.js` does this automatically; `approve-escrow-from-spender.js` is the recovery path.
- **Legacy users migrate on their own schedule** via the Upgrade button. After they complete `/setup`, sweep their legacy CDP balance with `migrate-funds-to-smart-wallet.js --user <discord_id>`.
- **Old WagerEscrow contract** at `0xA00E7cCdaE3978cb0f25cB8BadaA2B9d26b62747` is still on-chain but no longer referenced in `.env`. Any matches that were live on it at cutover resolve/cancel via the old address directly (operators can call from escrow-owner-smart manually). Drain its leftover balance via `emergencyWithdraw` to the escrow-owner-smart.
