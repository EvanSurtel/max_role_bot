# Rank $ Wallet — Web Surface

Self-custody wallet flows for the Rank $ Discord bot. Hosts:
- Initial Coinbase Smart Wallet creation (passkey)
- EIP-712 SpendPermission signing (one-time grant of bounded USDC allowance to the bot)
- External withdrawal signing
- SpendPermission renewal

The Discord bot DMs users a one-time link into here whenever an action requires a real cryptographic user signature. Every other UX (deposits, match flow, leaderboards, etc.) stays inside Discord.

## Architecture (one-liner)

Next.js 15 App Router, deployed on Vercel free tier. Frontend uses `@coinbase/onchainkit` + `wagmi` + the Coinbase Smart Wallet (`smartWalletOnly` preference, passkey-backed). API routes proxy to the bot's internal HTTP API using a shared secret.

## Local dev

```bash
cd web
npm install
cp .env.example .env.local
# fill in BOT_API_*, NEXT_PUBLIC_CDP_PROJECT_ID, NEXT_PUBLIC_BOT_SPENDER_ADDRESS,
# DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET
npm run dev
# → http://localhost:3100
```

## Deploy to Vercel (free tier)

1. Push the parent repo to GitHub (the bot lives at the repo root; this app lives at `/web`).
2. Sign in to <https://vercel.com> with GitHub.
3. **New Project** → import the repo.
4. **Root Directory:** set to `web` (Vercel will detect Next.js automatically).
5. Add the env vars from `.env.example` in **Project Settings → Environment Variables**.
6. **Deploy.** Vercel will give you a URL like `https://rank-wallet-<slug>.vercel.app`.
7. Add that URL (plus any custom domain you set later) to your Discord application's OAuth2 **Redirects** at `https://discord.com/developers/applications/<your-app>/oauth2`.
8. Set the bot's `WALLET_WEB_BASE_URL` env to the Vercel URL so it knows where to mint setup links.

## Endpoints

- `GET /` — landing page (mostly for reviewers / search engines)
- `GET /setup?t=<nonce>` — initial wallet creation + SpendPermission grant
- `GET /withdraw?t=<nonce>` — external withdrawal signing (next pass)
- `GET /renew?t=<nonce>` — SpendPermission renewal (next pass)
- `GET /api/health` — sanity-check route. Returns 200 + commit SHA on Vercel.
- `POST /api/link/redeem` — exchange a one-time nonce for the bound Discord ID. Proxies to the bot.
- `POST /api/wallet/grant` — submit a signed SpendPermission to the bot (next pass).
- `GET /api/discord/callback` — Discord OAuth2 callback (next pass).

## Security headers

`next.config.mjs` sets:
- `X-Frame-Options: SAMEORIGIN` — keeps a malicious site from embedding the wallet flow inside a fake skin.
- `Permissions-Policy: publickey-credentials-create=(self), publickey-credentials-get=(self)` — explicit grant for WebAuthn API in this origin only.
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Content-Type-Options: nosniff`

## Why this exists separately from the bot

Passkey signing requires a browser context with WebAuthn API access — Discord button webhooks can't authenticate against a user's device authenticator. The web surface is the only place a true cryptographic user signature can be produced. The bot remains the source of truth for everything else (database, matches, payments).
