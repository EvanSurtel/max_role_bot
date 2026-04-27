# Rank $ — Standard Operating Procedures

Last updated: 2026-04-27

This document is the operational manual for Rank $, the Discord bot for Call of Duty Mobile cash matches and ranked XP queue. Audience: the operator running the bot day-to-day. Read it once front-to-back, then come back to specific runbooks as needed.

---

## 1. What this is

Rank $ is a Discord bot that lets registered Call of Duty Mobile players:

- Wager USDC on 1v1 / 2v2 / 3v3 / 4v4 / 5v5 cash matches against other players.
- Play free XP challenges with the same match flow but no money.
- Queue for 5v5 ranked Hardpoint matches that pay out XP only (no money).
- Hold their own USDC in a self-custodied Coinbase Smart Wallet — the bot never has signing authority over user funds.

The bot lives in a single Discord server. Every interaction is button-driven; the only slash command is `/rank`.

---

## 2. Architecture in one diagram

```
┌──────────────────┐        ┌──────────────────────────────┐
│ Discord (users)  │◄──────►│ Bot (Node.js, PM2, Oracle)   │
└──────────────────┘        │   src/index.js               │
                            │   - discord.js v14           │
                            │   - SQLite (data/codm-wager) │
                            │   - Express :3001 webhooks   │
                            └─────┬──────────────────┬─────┘
                                  │                  │
                                  │ HTTPS via        │ ethers.js v6 +
                                  │ Cloudflare       │ CDP SDK (UserOps,
                                  │ tunnel           │ Paymaster)
                                  ▼                  ▼
                       ┌────────────────────┐  ┌──────────────────┐
                       │ Web (Next.js, web/)│  │ Base mainnet     │
                       │ Vercel-hosted      │  │ - WagerEscrow    │
                       │ - /setup           │  │ - SPM (Coinbase) │
                       │ - /renew           │  │ - USDC contract  │
                       │ - /withdraw        │  │ - Paymaster (CDP)│
                       │ - /deposit/coinbase│  └──────────────────┘
                       │ - /cashout/coinbase│
                       └────────────────────┘
```

- **Bot** runs on Oracle Cloud, managed by PM2 (`pm2 ls` shows `wager-bot`).
- **Web** runs on Vercel, auto-deploys from `main`.
- **Cloudflare tunnel** (`cloudflared-rank` systemd service on Oracle) bridges Vercel → bot. URL rotates on tunnel restart — when it does, update `BOT_API_BASE_URL` in Vercel.
- **All on-chain calls** go through the `escrow-owner-smart` Smart Account → CDP Paymaster → gasless. The deployer EOA (`escrow-owner`) only signed a single deploy + ownership-transfer tx ever.

---

## 3. Critical invariants — never violate

These are the rules CDP signed off on at the April 2026 architecture review. Any change that touches wallet / onramp / spend-permission code must preserve every one.

1. **Onramp destination is always the user's own Smart Wallet.** Never a pooled or operator-held address.
2. **Withdrawals are unrestricted/ungated.** User signs with their passkey on the web surface. No admin gating, no amount cap, no KYC. This preserves the FinCEN "unhosted wallet" posture.
3. **No `addOwnerAddress`.** The operator never becomes a co-owner of a user's Smart Wallet (Coinbase Smart Wallet ownership is any-of-N — co-ownership = full control).
4. **Operator is only a spender, never a wallet owner.** The `escrow-owner-smart` Smart Account holds no user funds directly.
5. **`clientIp` is the real end-user IP** on every CDP onramp/offramp session-token request. Captured at the Vercel edge via `x-real-ip` / `x-vercel-forwarded-for`. Never the bot server's IP, never the browser-controlled `x-forwarded-for` leftmost.
6. **User-facing language uses Coinbase's terminology.** "Self-custodied", "passkey-gated".
7. **Per-user wallet isolation is architectural.** No operator-held mixed pools. Match escrow goes through the `WagerEscrow` contract whose `totalActiveEscrow` is allocated per-match.

If you ever need to touch any of these, **stop and verify with Coinbase / the audit notes first.**

---

## 4. Money flow (cash matches)

Every cash match goes through this exact path:

```
1. Captain creates challenge → entry held in walletRepo.balance_held (DB-only, no on-chain)
2. Teammates accept → their entries also DB-held
3. Acceptor + their teammates accept → all entries DB-held
4. matchService.startMatch fires:
   - Atomic UserOp from escrow-owner-smart batches:
     a) SpendPermissionManager.spend(perm, entry) for EACH player
     b) WagerEscrow.depositFromSpender(matchId, player, source=spender) for EACH player
   - All-or-nothing; if any player's spend fails, the whole batch reverts
   - On success: walletRepo.decrementHeld for each player
5. Match plays out in Discord channels (private team channels + shared + vote)
6. Captains report results
   - Both agree → matchService.resolveMatch
   - They disagree → admin dispute flow → admin resolve
7. resolveMatch.disburseWinnings:
   - WagerEscrow.resolveMatch(matchId, winners, amounts) — pays winners directly to their Smart Wallets on-chain
   - walletRepo.creditAvailable for each winner (DB mirror)
8. cleanupChannels (DB-backed timer, fires 120s later) deletes the match category
```

**Key architectural points:**

- Pre-match-start, money is DB-locked only. Cancellations refund without any on-chain calls.
- The atomic spend+deposit batch is **never** split into two UserOps. A partial failure between them would orphan USDC at the spender address with no refund path.
- `transferToEscrow` writes a `pending_tx` row **before** sending the UserOp. The deposit poller reconciles against pending rows so a `post_submit` failure can be recovered.
- `disburseWinnings` and `cancelOnChainMatch` distinguish `post_submit` errors (UserOp landed but confirmation unknown) from `pre_submit` errors. `post_submit` keeps rows in `pending_onchain` and posts an admin alert — never reverts the match status, because that could double-pay if an admin retries while the original UserOp lands.

---

## 5. Daily operations

### Check the bot is alive

```bash
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 "pm2 ls"
```

Expected: `wager-bot` row with status `online` and uptime > 0. Memory should be < 200MB; if it's climbing fast, see §11.

### Tail logs

```bash
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 "pm2 logs wager-bot --lines 100 --nostream"
```

For live tailing:

```bash
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 "pm2 logs wager-bot"
```

Useful filters:
- `| grep '\[Nickname\]'` — nickname update successes/failures
- `| grep '\[Escrow\]'` — on-chain deposit/disbursement activity
- `| grep '\[Timer\]'` — timer firings
- `| grep '\[QueuePanel\]'` — queue state changes
- `| grep CRITICAL` — operator-required incidents

### Check admin alerts channel

`ADMIN_ALERTS_CHANNEL_ID` should be quiet. If it has unread red 🚨 messages, see §10 (incident runbook).

### Check transactions feed

Two channels:
- `TRANSACTIONS_CHANNEL_ID` — cash matches, deposits, withdrawals, disbursements, balance mismatches
- `XP_TRANSACTIONS_CHANNEL_ID` — XP challenges + queue match events

A healthy day shows: user_registered → wallet_setup → challenge_created → match_started → match_resolved (no 🚨 balance_mismatch entries).

---

## 6. Deployment

### Standard deploy (bot + web in one push)

From the local repo:

```bash
# 1. Confirm everything compiles
for f in $(git status --short | awk '{print $2}' | grep -E '\.(js)$'); do node -c "$f" || echo FAIL; done

# 2. Commit + push
git add -u
git commit -m "<descriptive subject>

<body explaining WHY, not just WHAT>

Co-Authored-By: <if relevant>"
git push origin main

# 3. Rsync to Oracle (skips data/, .env, .git, node_modules)
rsync -avz --delete \
  --exclude='.git/' --exclude='node_modules/' --exclude='data/' \
  --exclude='.env' --exclude='.claude/' --exclude='target/' \
  --exclude='.anchor/' --exclude='.DS_Store' \
  -e "ssh -i ~/Downloads/ssh-key-2026-04-03.key" \
  ./ ubuntu@40.233.115.208:~/max_role_bot/

# 4. Restart bot — DB-backed timers rehydrate automatically
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "pm2 restart wager-bot --update-env"

# 5. Verify clean boot
sleep 5 && ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "pm2 logs wager-bot --lines 30 --nostream | tail -30"
```

Vercel auto-deploys from `main`. After your `git push`, web changes go live within ~60 seconds — no manual step. If Vercel is broken, see §10.

### Deploy gotchas

- **Never rsync without `--delete`.** Files renamed or removed in a commit need to be removed on the server too.
- **Never commit `.env`.** It's gitignored, but double-check after rebases.
- **Never commit `data/`.** That's the live SQLite DB — gitignored.
- **Don't deploy mid-match unless you have to.** Cash matches survive a restart (pre-log + DB-backed timers + queue recovery), but ANY in-progress queue match (queue is in-memory by design) is **cancelled on restart** — players are dropped with no penalty. Check `queue_matches` table for active matches before restarting.

```bash
# Check for active queue matches before restart:
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "cd ~/max_role_bot && sqlite3 data/codm-wager.db \"SELECT id, phase, created_at FROM queue_matches WHERE status NOT IN ('resolved', 'cancelled');\""
```

If non-empty, either wait for them to finish or accept the cancellations.

### Hotfix deploy (single file)

For a one-line fix, the standard deploy is still the right path. Don't rsync individual files — `--delete` won't run, but you'll likely forget to commit/push and end up with server-only changes that get blown away on the next full sync.

---

## 7. Smart contract operations

### When to redeploy `WagerEscrow`

Only if:
- A bug is found in the contract that requires a code change (rare).
- A new feature requires a new function signature.

Steps:

```bash
# 1. Set BASE_RPC_URL + CDP creds in .env
# 2. Fund escrow-owner EOA with ~$5 ETH on Base (one-time)
node scripts/create-owner-wallet.js   # creates owner + smart owner

# 3. Deploy
node scripts/deploy-escrow.js
# → prints the new ESCROW_CONTRACT_ADDRESS
# → also calls transferOwnership(escrow-owner-smart) and
#   USDC.approve(WagerEscrow, MAX) from escrow-owner-smart

# 4. Update .env on Oracle
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "cd ~/max_role_bot && nano .env"
# Set ESCROW_CONTRACT_ADDRESS to the new address

# 5. Add the new contract to CDP Paymaster allowlist (Portal → Paymaster
#    → Configuration → Contract allowlist). Add ALL functions.

# 6. Restart bot
pm2 restart wager-bot --update-env
```

### CDP Paymaster allowlist (canonical)

Three contracts MUST be on the allowlist or every UserOp fails:

| Contract | Address | Functions |
|---|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `approve(address,uint256)`, `transfer(address,uint256)` |
| WagerEscrow | (current `ESCROW_CONTRACT_ADDRESS` in .env) | all functions |
| SpendPermissionManager | `0xf85210B21cC50302F477BA56686d2019dC9b67Ad` | selectors `0xb9ffc8e1` (approveWithSignature), `0x415a9735` (spend), `0xb2c2b019` (revokeAsSpender) |

Symptom of missing allowlist entry: bundler returns "sender balance and deposit together is 0 but must be at least N to pay for this operation" (AA21 internally). Paymaster Error Logs tab shows nothing because the call never reached Paymaster validation.

### Recovery: stuck on-chain match

If a match got stuck mid-startup (some deposits landed, some didn't):

```bash
# Diagnose
node scripts/diagnose-balances.js --match <matchId>

# Emergency cancel — forces an on-chain cancel, refunds whoever did
# deposit, and DB-unlocks the rest.
node scripts/emergency-cancel-match.js --match <matchId>
```

Then confirm via:

```bash
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "cd ~/max_role_bot && sqlite3 data/codm-wager.db \"SELECT * FROM matches WHERE id = <matchId>;\""
```

---

## 8. User support runbooks

### "I created a wallet but the bot doesn't see it"

Stuck-grant. Most common cause: the on-chain `approveWithSignature` UserOp failed silently after the user signed in the browser. The `spendPermissionSweeper` retries automatically every 60s up to 5 attempts. If still stuck after ~10 min:

```bash
# Find their pending permission
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "cd ~/max_role_bot && sqlite3 data/codm-wager.db \"SELECT id, user_id, status, retry_count, created_at FROM spend_permissions WHERE status = 'pending';\""

# Force-retry one specific permission ID
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "cd ~/max_role_bot && node -e \"require('dotenv').config(); require('./src/database/db'); require('./src/services/spendPermissionService').approveOnChain(<permId>).then(()=>console.log('ok')).catch(e=>console.error(e))\""
```

If that succeeds the wallet row gets flipped via the `_flipWalletToSelfCustody` side effect and the user can now play.

If it fails repeatedly, check:
1. CDP Paymaster has SPM (`0xf85210...`) on the allowlist with `approveWithSignature` selector enabled.
2. `escrow-owner-smart` has gas credit at CDP.
3. RPC isn't dropping requests — `[Base]` log lines should be quiet, not red.

### "My match resolved but I don't see XP / earnings update"

Two possibilities:

**A. Nickname doesn't show updated stats** — bot's role is below the user's role in the Discord role hierarchy. Bot can't change nicknames of users with higher roles, OR the server owner (Discord API forbids it). Fix: drag bot's role above all admin/staff/rank roles in Server Settings → Roles.

Force-refresh all member nicknames:

```bash
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 "cd ~/max_role_bot && cat > scripts/refresh-nicks.js <<'EOF'
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const { updateNicknames } = require('../src/utils/nicknameUpdater');
const db = require('../src/database/db');
client.once('clientReady', async () => {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  await guild.members.fetch();
  const users = db.prepare(\"SELECT id FROM users WHERE accepted_tos = 1 AND discord_id GLOB '[0-9]*'\").all();
  await updateNicknames(client, users.map(u => u.id));
  process.exit(0);
});
client.login(process.env.BOT_TOKEN);
EOF
cd ~/max_role_bot && node scripts/refresh-nicks.js"
```

**B. DB actually has wrong values** — query the user directly to verify:

```bash
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "cd ~/max_role_bot && sqlite3 data/codm-wager.db \"SELECT id, server_username, xp_points, total_earnings_usdc, total_wins, total_losses, cash_wins, cash_losses FROM users WHERE LOWER(server_username) LIKE '%<name>%';\""
```

If DB is wrong, that's a real bug — check `xp_history` for the missing rows and reconcile manually.

### "I tried to cancel my challenge but it says I can't"

Most likely they hit the 1-hour expiry first. Their funds are already refunded. The new error message clarifies this with "This challenge already expired (1 hour timeout, no one accepted). Your entry has been refunded to your balance."

Verify:

```bash
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "cd ~/max_role_bot && sqlite3 data/codm-wager.db \"SELECT id, display_number, status, type, total_pot_usdc, created_at FROM challenges WHERE display_number = <num>;\""
```

If status is `EXPIRED`, refund already happened. If status is `IN_PROGRESS`, a match was started — they need to play it out.

### "My teammate didn't get the invite"

Their DMs are off for the server. The bot can't deliver invites any other way. They need to:

- Right-click server icon → Privacy Settings → toggle on **Direct Messages**.

The challenge auto-cancelled and the captain's funds are refunded. They can re-create after the teammate fixes their DMs.

### "I want to send USDC to another player"

They click **📤 Send to User** in the wallet panel, pick a recipient (must be registered + have a wallet), enter amount, and sign with their passkey on the web surface. The bot pre-fills the recipient address and amount in the link metadata so the sender just signs.

### "I want to extend my challenge"

Click **Extend +10 min** on the challenge embed (creator-only, only works while OPEN). Bumps `expires_at` by 10 minutes from now and rebuilds the timer.

---

## 9. Database operations

### Backup

A daily backup runs via cron + `scripts/backup-db.sh`. 30-day retention. Verify recent backups exist:

```bash
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "ls -lah ~/max_role_bot/data/backups/ | head -10"
```

### Manual backup before risky operations

```bash
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "cd ~/max_role_bot && bash scripts/backup-db.sh manual-$(date +%Y%m%d-%H%M%S)"
```

### Restore from backup

DESTRUCTIVE. Only if the live DB is corrupted.

```bash
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208
# (on the server)
pm2 stop wager-bot
cp data/codm-wager.db data/codm-wager.db.broken-$(date +%s)  # safety copy
cp data/backups/<chosen-backup>.db data/codm-wager.db
pm2 start wager-bot
```

After restore, on-chain state and DB are out of sync until the deposit poller catches up. Watch the admin alerts channel for `balance_mismatch` events; those will guide reconciliation.

### Migrations

Migrations live in `src/database/migrations/` numbered sequentially. They run automatically on bot boot via `src/database/db.js`. **Do not write destructive migrations** (no `DROP TABLE`, no irreversible `ALTER TABLE` where data could be lost). Add a new column rather than rewriting an existing one.

---

## 10. Incident runbooks

### 🚨 `balance_mismatch` in admin feed

Investigate immediately. Memo will say which match + user. Pattern:

1. Find the relevant `pending_tx` row by id mentioned in the memo.
2. Check on-chain via BaseScan with the userOpHash or txHash:
   - If the on-chain tx confirmed: the deposit poller will reconcile within ~30s. If 5min later still showing mismatch, kick the poller manually:
     ```bash
     ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
       "cd ~/max_role_bot && node -e \"require('dotenv').config(); require('./src/database/db'); require('./src/base/depositService').reconcileOnce()\""
     ```
   - If the on-chain tx failed: the row should be marked `failed` already; verify via SQL.
3. Reach out to the affected user with status (DM via `pm2 logs | grep <user_id>`).

### 🚨 Stuck escrow deposit

Posted by `startMatch.js` when an atomic match-start UserOp lands `post_submit` with unknown confirmation status. Memo includes the userOpHash.

1. Open BaseScan, search the userOpHash.
2. If it confirmed: do nothing — the deposit poller reconciles. The match goes through.
3. If it failed (reverted): manually run `scripts/emergency-cancel-match.js --match <matchId>`. This cancels on-chain, refunds whoever did deposit, and DB-unlocks everyone. Tell the players.

**DO NOT click Cancel in Discord** for a stuck match — it would double-refund anyone whose deposit landed.

### Bot crash loop

```bash
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "pm2 logs wager-bot --lines 200 --nostream"
```

Look for the last error before each restart. Common crashes:

- `[DB] Database initialized` then crash → migration failure. Diff the last commit's migration SQL.
- Missing env var → restore .env from backup.
- Cloudflare tunnel down → `sudo systemctl status cloudflared-rank`. If not running, restart:
  ```bash
  ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
    "sudo systemctl restart cloudflared-rank"
  ```

If after 5 auto-restarts PM2 backs off, manually restart:

```bash
pm2 restart wager-bot --update-env
```

### Cloudflare tunnel URL rotated

Quick tunnels rotate the URL whenever `cloudflared` restarts. When that happens, Vercel can't reach the bot's webhook server.

```bash
# Get current URL
ssh -i ~/Downloads/ssh-key-2026-04-03.key ubuntu@40.233.115.208 \
  "sudo journalctl -u cloudflared-rank --since '10 min ago' | grep trycloudflare.com"
```

Copy the URL into Vercel:
1. Vercel Project Settings → Environment Variables
2. Update `BOT_API_BASE_URL` to the new URL
3. Trigger redeploy (Deployments → latest → Redeploy)

To avoid this, point a domain at a named tunnel — but the quick tunnel works fine for now.

### Vercel deploy broken

Symptoms: clicking "Set up wallet" or any web link fails.

1. Check Vercel Dashboard → Deployments → most recent.
2. If status = "Failed", click → "Function Logs" or "Build Logs" — fix and redeploy.
3. If status = "Ready" but pages 500, the env vars are likely wrong. Verify all 5 web env vars are set:
   - `BOT_API_BASE_URL` (current Cloudflare tunnel URL)
   - `BOT_API_SHARED_SECRET` (matches bot's `WALLET_WEB_INTERNAL_SECRET`)
   - `NEXT_PUBLIC_CDP_PROJECT_ID`
   - `NEXT_PUBLIC_BASE_RPC_URL`
   - `NEXT_PUBLIC_BOT_SPENDER_ADDRESS` (matches bot's `CDP_OWNER_ADDRESS`)

---

## 11. Memory leak / OOM

The bot should sit at <200MB RSS. If it climbs steadily over hours/days, the most likely culprits:

- **Unbounded Map/Set** — search for `new Map()` and `new Set()` in `src/` and verify they have eviction. Known bounded ones: `_pendingSends` in `wallet/sendToUser.js` (24h GC), `acceptFlows` in `challengeAccept.js` (cleared on submit).
- **Discord client cache** — discord.js caches every guild member by default. This is bounded by the guild size, so unless the guild is huge it's fine.
- **better-sqlite3 prepared statements** — each `db.prepare()` allocates. Search for `db.prepare(` inside loops or per-request handlers; preferred pattern is to prepare at module load.

If you can't find the source, restart the bot — buys a clean baseline.

---

## 12. Configuration reference

### Bot `.env` on Oracle (`~/max_role_bot/.env`)

Required:

| Var | Purpose |
|---|---|
| `BOT_TOKEN` | Discord bot token |
| `GUILD_ID` | Single Discord server ID |
| `ADMIN_ROLE_ID`, `OWNER_ROLE_ID`, `CEO_ROLE_ID`, `ADS_ROLE_ID` | Admin-equivalent roles |
| `WAGER_STAFF_ROLE_ID`, `XP_STAFF_ROLE_ID` | Lower-tier staff (can see match channels for moderation, not wallet info) |
| `MEMBER_ROLE_ID` | Granted on registration completion |
| `WAGER_CHANNEL_ID`, `CHALLENGES_CHANNEL_ID` | Cash match flow |
| `RANKED_QUEUE_CHANNEL_ID`, `QUEUE_STATS_CHANNEL_ID`, `WAGER_STATS_CHANNEL_ID` | Queue + stats |
| `TRANSACTIONS_CHANNEL_ID`, `XP_TRANSACTIONS_CHANNEL_ID` | Audit feeds |
| `ADMIN_ALERTS_CHANNEL_ID` | Operator-required alerts |
| `RESULTS_CHANNEL_ID`, `WAGER_RESULTS_CHANNEL_ID` | Match results board |
| `BASE_RPC_URL`, `BASE_RPC_URL_FALLBACK` | RPC (Alchemy primary, Ankr fallback) |
| `BASE_NETWORK` | `mainnet` (default) or `sepolia` (test) |
| `ESCROW_CONTRACT_ADDRESS` | Current `WagerEscrow` |
| `USDC_CONTRACT_ADDRESS` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` | CDP secret API key |
| `CDP_PROJECT_ID` | CDP project |
| `CDP_OWNER_ADDRESS` | `escrow-owner-smart` Smart Account |
| `PAYMASTER_RPC_URL` | Copy from CDP Portal → Paymaster → Configuration |
| `CDP_WEBHOOK_SECRET` | For onramp/offramp webhook verification |
| `WALLET_WEB_BASE_URL` | `https://max-role-bot.vercel.app` |
| `WALLET_WEB_INTERNAL_SECRET` | Shared with Vercel `BOT_API_SHARED_SECRET` |
| `CHANGELLY_API_KEY`, `CHANGELLY_SECRET_KEY`, `CHANGELLY_CALLBACK_PUBLIC_KEY` | Wert/Transak |
| `ENCRYPTION_KEY` | Legacy (pre-self-custody compat) |

Optional:

| Var | Default | Purpose |
|---|---|---|
| `WEBHOOK_PORT` | 3001 | Express server port |
| `ENABLE_SPM_LISTENER` | `true` | Set `false` to disable SPM-revoke event listener |
| `MATCH_INACTIVITY_HOURS` | 24 | Auto-dispute timer for unreported matches |
| `CDP_ZERO_FEE_USDC` | (unset) | Set `true` to display 0% fee on Coinbase offramp |
| `MIN_WAGER_USDC`, `MAX_WAGER_USDC`, `MIN_WITHDRAWAL_USDC` | (varies) | Validation bounds |

### Vercel project (`web/`)

5 env vars only:

- `BOT_API_BASE_URL` (Cloudflare tunnel URL)
- `BOT_API_SHARED_SECRET` (matches bot's `WALLET_WEB_INTERNAL_SECRET`)
- `NEXT_PUBLIC_CDP_PROJECT_ID`
- `NEXT_PUBLIC_BASE_RPC_URL` (= `https://mainnet.base.org`)
- `NEXT_PUBLIC_BOT_SPENDER_ADDRESS` (= bot's `CDP_OWNER_ADDRESS`)

---

## 13. Testing checklist (pre-launch and after major deploys)

Run through these manually after any commit that touches the listed area.

### Cash match path
- [ ] Create a 1v1 cash match, accept with another account, both report won/lost as expected, winner gets payout to their Smart Wallet (BaseScan confirms).
- [ ] Create a 2v2 cash match, all 4 accept, match resolves correctly, both winners paid.
- [ ] Try to cancel after acceptor accepted but before match starts → should refund.
- [ ] Try to accept your own challenge with a same-COD-UID alt → blocked with self-play error.

### Self-custody money paths
- [ ] New user `/setup` flow end-to-end. Wallet row shows `wallet_type=coinbase_smart_wallet`, `address` matches what's on Coinbase Smart Wallet.
- [ ] Admin feed shows `wallet_setup` event after setup completes.
- [ ] Withdraw $X via wallet panel → DM link → sign on web → tx on BaseScan.
- [ ] Send to User: pick recipient, enter amount, sign on web → recipient's USDC balance up by $X on BaseScan.

### Queue path
- [ ] Queue 10 players, captain vote, captain pick, role select, play, both captains report, XP awarded.
- [ ] Force a no-show: don't join voice, verify -300 XP penalty applied.
- [ ] DQ a player as admin, verify replacement gets channel access + auto-assigned roles.

### Crash safety
- [ ] Start a teammate-invite flow, restart the bot, verify the 10-min decline timer survives (DB-backed).
- [ ] Resolve a match, restart immediately, verify channels still get cleaned up after 120s (also DB-backed).

### Channel visibility
- [ ] Create a match. As a non-participant member, verify the match category is visible, voice channels show who's connected, but you can't join voice or read text.

### UX
- [ ] Try to create a cash match without a wallet → blocked with "create a wallet first" + setup link.
- [ ] Let a challenge expire (1h) → DM creator, admin feed event, board embed flips to "Expired".

---

## 14. Known limitations / accepted residual risks

These are documented in `memory/` and accepted by the operator:

1. **Queue match state is in-memory.** Restarting the bot mid-queue-match cancels it. No money at stake (queue is XP-only) so this is acceptable.
2. **Cloudflare quick tunnel rotates URL on restart.** Operator updates `BOT_API_BASE_URL` in Vercel when this happens. Permanent solution: named tunnel with a domain.
3. **Server owner nickname can never update.** Discord API forbids bots changing the owner's nickname.
4. **xp_history can over-state penalty magnitude** for users floored at 0. The `addXp` function clamps to 0 and returns the actual delta, but if a caller forgets to use the returned delta and writes the requested delta to xp_history, the audit row says "-300 XP" while the actual change was "-50 XP" (because they only had 50 to lose). Most callers correctly use the returned delta. If you add a new caller, follow the pattern.
5. **CDP Paymaster has a 50 RPS cap.** Way above expected load, but a coordinated burst of >50 simultaneous match starts would throttle. Mitigation: rate limiter per user (`MATCH_ENTRY_PER_24H = 10`).

---

## 15. Going forward — what to monitor

After launch, watch for:

- **`wallet_setup` events** — should match new registrations with a small lag.
- **`match_resolved` vs `challenge_created` ratio** — if many created but few resolved, users are abandoning mid-match. Investigate UX.
- **`balance_mismatch` events** — should be ~0 per day. Anything else is an incident.
- **PM2 restart count** — `pm2 ls` shows `↺` column. If it's climbing over 24h, see §10 crash loop.
- **Vercel function errors** — Vercel Dashboard → Analytics. Spike = bot↔web bridge broken (check tunnel).

---

## 16. Contacts / escalation

- **Coinbase CDP support** — for stuck Paymaster, allowlist, or onramp issues. Reference the April 2026 architecture review.
- **Changelly support** — for Wert / Transak provider issues. `support@changelly.com`.
- **Bitrefill support** — for gift-card cash-out issues.
- **Vercel support** — for hosting issues with the web surface.

---

## 17. File layout quick reference

```
src/
  index.js                      Entry point
  config/                       Constants (game modes, timers, USDC, queue)
  database/
    db.js                       SQLite + migration runner
    migrations/                 Numbered SQL (001-023)
    repositories/               Per-table CRUD wrappers
  base/                         Base / on-chain
    connection.js               FallbackProvider
    transactionService.js       UserOp helpers (_sendOwnerTx, _sendOwnerTxBatch)
    escrowManager.js            DB holds + WagerEscrow interactions
    depositService.js           30s polling + reconciliation
  services/
    challengeService.js         Challenge create / cancel / notify teammates
    spendPermissionService.js   EIP-712 verify + on-chain approve + spend
    spendPermissionSweeper.js   Retry-pending poller
    spendPermissionEventListener.js   Watch for revokes
    linkNonceService.js         One-time link mint / peek / redeem
    timerService.js             DB-backed timers
    timerHandlers.js            Handler registrations (challenge_expiry, teammate_accept, match_inactivity, match_cleanup)
    webhookServer.js            Express :3001 — internal API + Changelly + CDP webhooks
    paymentRouter.js            Onramp/offramp provider picker (region-aware)
    healthService.js            Periodic health checks
    reconciliationService.js    DB ↔ on-chain reconcile
    match/                      Cash match flow (split for clarity)
      createChannels.js
      startMatch.js
      resolveMatch.js
      cleanup.js
      helpers.js
      index.js
  queue/                        5v5 ranked queue (in-memory + queue_matches table)
    state.js                    In-memory state + DB recovery
    matchLifecycle.js           Create / no-show / resolve / cancel
    captainVote.js              Captain vote phase
    captainPick.js              Snake draft
    roleSelect.js               Weapon + operator selection
    playPhase.js                Play phase + report
    subCommands.js              Sub flow
    interactions.js             Button routing + DQ
    helpers.js                  Channel overwrites + replacement finder
    index.js                    Public API
  panels/                       UI surfaces
    welcomePanel.js             Onboarding TOS + accept
    walletPanelView.js          Personal wallet panel embed
    wallet/                     Per-action handlers
      index.js                  Router
      viewOpen.js
      deposit.js
      cashOut.js
      withdrawMenu.js
      selfCustodyWithdraw.js
      sendToUser.js             "Send to User" 3-step flow
      pendingSetup.js
      history.js
      refresh.js
    lobbyPanel.js
    queuePanel.js
    queueStatsPanel.js
    wagerStatsPanel.js
    leaderboardPanel.js
    seasonPanel.js
    escrowPanel.js
    ranksPanel.js
    howItWorksPanel.js
    rulesPanel.js
    xpMatchPanel.js
    publicWalletPanel.js
    adminWalletViewerPanel.js
  interactions/                 Button / modal / select handlers
    onboarding.js
    challengeCreate.js
    challengeAccept.js
    challengeCancel.js
    challengeExtend.js
    teammateResponse.js
    matchResult/                Reporting + dispute + admin resolve
      index.js
      reporting.js
      noShow.js
      dispute.js
      adminResolve.js
      disputeResult.js
      helpers.js
    languageSwitcher.js
    perMessageLanguage.js
    adminWalletViewer.js
  commands/
    rank.js                     /rank slash command
    rank-context.js             Right-click "View Rank"
  utils/
    crypto.js                   Legacy (pre-self-custody encryption)
    embeds.js                   formatUsdc + shared embed helpers
    rankCardRenderer.js         /rank card image
    rankRoleSync.js             XP → rank role
    transactionFeed.js          postTransaction()
    nicknameUpdater.js          Per-user nickname format
    playerStatus.js             Cross-system busy check
    rateLimiter.js
    matchTimer.js
    mapPicker.js
    xpCalculator.js
    ephemeralReply.js
    ephemeralPanelDispatcher.js
    languageButtonHelper.js
    languageRefresh.js
    permissions.js              Channel overwrite templates
    adminAudit.js
  locales/
    i18n.js                     Lookup + fallback
    messages/<lang>.js          UI strings
    howItWorks/<lang>.js        How It Works panel
    rules/<lang>.js             Rules panel

web/                            Next.js 15 App Router on Vercel
  app/
    setup/                      First-time passkey + SpendPermission sign
    renew/                      Re-sign expired SpendPermission
    withdraw/                   Passkey-signed USDC.transfer (also send-to-user)
    deposit/coinbase/           Onramp clientIp bridge
    cashout/coinbase/           Offramp clientIp bridge
    api/
      link/peek/                Proxy to bot's /api/internal/link/peek
      link/redeem/              Proxy to bot's /api/internal/link/redeem
      wallet/grant/             Proxy to bot's /api/internal/wallet/grant
      deposit/coinbase/mint/    Captures clientIp + proxy
      cashout/coinbase/mint/    Same
      health/

contracts/
  WagerEscrow.sol               createMatch / depositFromSpender / resolveMatch / cancelMatch / emergencyWithdraw

scripts/
  deploy-escrow.js              Contract deploy + transferOwnership + USDC approve
  approve-escrow-from-spender.js  Idempotent retry of the spender's USDC.approve
  create-owner-wallet.js        Creates escrow-owner EOA + escrow-owner-smart Smart Account
  emergency-cancel-match.js     Break-glass for stuck matches
  diagnose-balances.js          DB ↔ on-chain reconcile
  backup-db.sh                  Daily backup + 30-day retention

memory/                         Auto-memory for assistant sessions (project rules)
docs/
  SOP.md                        ← this file
  terms_of_service.md
```

---

## 18. Final note

If something here is wrong or missing, fix it. The SOP is a living document — every incident, every "huh, that wasn't documented" should produce a PR adding the missing rule. Future-you (or future operator) will thank you.
