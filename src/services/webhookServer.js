// Webhook HTTP server — handles Changelly fiat on-ramp callbacks.
// DMs the user on status changes (processing, completed, failed).

const express = require('express');
const { EmbedBuilder } = require('discord.js');

let app = null;
let server = null;
let discordClient = null;

function startWebhookServer(client) {
  if (server) return;
  discordClient = client;

  const port = parseInt(process.env.WEBHOOK_PORT || '3001', 10);
  if (!port || Number.isNaN(port)) {
    console.log('[Webhook] WEBHOOK_PORT not set — webhook server disabled');
    return;
  }

  app = express();

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // ─── Changelly Fiat On-Ramp Webhook ─────────────────────────
  // Changelly verifies via RSA signature over the JSON body, which
  // express.json() parses after we've grabbed what we need via the
  // `x-callback-signature` header path below. Json parser is fine here.
  app.post('/api/changelly/webhook', express.json(), async (req, res) => {
    res.status(200).json({ ok: true });

    try {
      // Verify the callback signature if the public key is configured.
      // On mainnet we REJECT invalid signatures (return early without
      // processing). On sepolia we log and continue since sandbox can
      // use different signing modes during Changelly testing.
      const isMainnet = (process.env.BASE_NETWORK || 'mainnet').toLowerCase() !== 'sepolia';
      const callbackPubKey = process.env.CHANGELLY_CALLBACK_PUBLIC_KEY;
      if (callbackPubKey && req.headers['x-callback-signature']) {
        let sigVerified = false;
        try {
          const crypto = require('crypto');
          const signature = req.headers['x-callback-signature'];
          const body = JSON.stringify(req.body);

          // Key is base64-encoded PEM — decode it first
          let pemKey = callbackPubKey;
          if (!pemKey.includes('-----BEGIN')) {
            pemKey = Buffer.from(pemKey, 'base64').toString('utf8');
          }

          // Convert PKCS#1 (RSA PUBLIC KEY) to PKCS#8 format if needed
          const pubKeyObj = crypto.createPublicKey({
            key: pemKey,
            format: 'pem',
            type: pemKey.includes('RSA PUBLIC KEY') ? 'pkcs1' : 'spki',
          });
          sigVerified = crypto.verify('sha256', Buffer.from(body), pubKeyObj, Buffer.from(signature, 'base64'));
        } catch (verifyErr) {
          console.warn(`[Changelly] Signature verification error: ${verifyErr.message}`);
        }
        if (!sigVerified) {
          if (isMainnet) {
            console.error('[Changelly] REJECTED webhook — invalid signature on mainnet. Not processing.');
            return;
          }
          console.warn('[Changelly] Invalid signature on testnet — processing anyway (sandbox signing mode)');
        }
      } else if (isMainnet && !callbackPubKey) {
        console.warn('[Changelly] CHANGELLY_CALLBACK_PUBLIC_KEY not set on mainnet — any caller can forge webhooks. Configure production public key.');
      }

      const payload = req.body;
      const {
        externalOrderId,
        externalUserId, // Discord user ID
        status,
        currencyTo,
        amountTo,
        amountFrom,
        currencyFrom,
        providerCode,
        type,           // 'buy' (onramp) or 'sell' (offramp)
      } = payload || {};

      console.log(`[Changelly] Webhook: order=${externalOrderId} user=${externalUserId} provider=${providerCode} type=${type} status=${status}`);

      // Idempotency — dedupe replayed webhooks on (provider, externalOrderId+status).
      // Status is part of the key because we want to process each state
      // transition (created / processing / completed) once, but not
      // process the same transition twice.
      if (externalOrderId && status) {
        try {
          const paymentEventRepo = require('../database/repositories/paymentEventRepo');
          const inserted = paymentEventRepo.record({
            provider: 'changelly',
            eventId: `${externalOrderId}:${status}`,
            eventType: type,
            orderId: String(externalOrderId),
            status,
            payload,
          });
          if (!inserted) {
            console.log(`[Changelly] Duplicate event ${externalOrderId}:${status} — skipping.`);
            return;
          }
        } catch (dedupeErr) {
          console.warn('[Changelly] Dedupe check failed, processing anyway:', dedupeErr.message);
        }
      }

      // Wert LKYC lifetime tracking — increment on completed Wert buy.
      // Only counts *completed* on-ramp purchases; refunds/expired/etc.
      // are not counted.
      //
      // Idempotent per orderId: even if Changelly sends multiple
      // completed-status events for the same order (e.g. order flips
      // processing → completed → processing → completed), we only
      // credit the lifetime once. Enforced via a dedicated
      // `wert-credit:<orderId>` row in payment_events (UNIQUE, so the
      // second insert returns null and we skip).
      if ((status === 'completed' || status === 'finished') &&
          providerCode === 'wert' &&
          (type === 'buy' || currencyFrom)) {
        try {
          const userRepo = require('../database/repositories/userRepo');
          const wertKyc = require('../database/repositories/wertKycRepo');
          const paymentEventRepo = require('../database/repositories/paymentEventRepo');
          const dbUser = userRepo.findByDiscordId(String(externalUserId));
          if (dbUser) {
            const usd = parseFloat(amountFrom ?? amountTo ?? '0') || 0;
            if (usd > 0) {
              const creditRecord = paymentEventRepo.record({
                provider: 'changelly',
                eventId: `wert-credit:${externalOrderId}`,
                eventType: 'wert_lifetime_credit',
                orderId: String(externalOrderId),
                status: 'credited',
                payload: { amountUsd: usd, discordId: externalUserId },
              });
              if (creditRecord) {
                const newTotal = wertKyc.addLifetime(dbUser.id, usd);
                console.log(`[Changelly] Wert lifetime for user ${dbUser.id}: +$${usd} → $${newTotal.toFixed(2)}`);
              } else {
                console.log(`[Changelly] Wert lifetime already credited for order ${externalOrderId} — skipping duplicate.`);
              }
            }
          }
        } catch (err) {
          console.warn('[Changelly] Wert lifetime increment failed:', err.message);
        }
      }

      if (!externalUserId || !discordClient) return;

      // DM the user based on status
      try {
        const user = await discordClient.users.fetch(externalUserId);
        if (!user) return;

        let embed;

        if (status === 'completed' || status === 'finished') {
          embed = new EmbedBuilder()
            .setTitle('Deposit Complete')
            .setColor(0x2ecc71)
            .setDescription(`Your purchase of **${amountTo || '?'} ${currencyTo || 'USDC'}** has been completed.\n\nThe funds will appear in your wallet balance shortly.`)
            .setTimestamp();

        } else if (status === 'processing' || status === 'exchanging' || status === 'sending') {
          embed = new EmbedBuilder()
            .setTitle('Deposit Processing')
            .setColor(0xf1c40f)
            .setDescription(`Your purchase of **${amountTo || '?'} ${currencyTo || 'USDC'}** is being processed.\n\nThis usually takes a few minutes.`)
            .setTimestamp();

        } else if (status === 'failed') {
          embed = new EmbedBuilder()
            .setTitle('Deposit Failed')
            .setColor(0xe74c3c)
            .setDescription('Your deposit could not be completed. No funds were charged.\n\nPlease try again or use a different payment method.')
            .setTimestamp();

        } else if (status === 'expired') {
          embed = new EmbedBuilder()
            .setTitle('Deposit Expired')
            .setColor(0xe74c3c)
            .setDescription('Your deposit session expired before payment was completed.\n\nPlease start a new deposit from your wallet.')
            .setTimestamp();

        } else if (status === 'refunded') {
          embed = new EmbedBuilder()
            .setTitle('Deposit Refunded')
            .setColor(0xe67e22)
            .setDescription('Your deposit has been refunded. The funds will be returned to your original payment method.')
            .setTimestamp();

        } else {
          // Unknown status — don't DM
          return;
        }

        await user.send({ embeds: [embed] });
        console.log(`[Changelly] DM sent to ${externalUserId}: ${status}`);
      } catch (dmErr) {
        console.warn(`[Changelly] Could not DM user ${externalUserId}: ${dmErr.message}`);
      }
    } catch (err) {
      console.error('[Changelly] Webhook error:', err.message);
    }
  });

  // ─── Coinbase CDP Onramp / Offramp Webhook ─────────────────────
  //
  // Coinbase delivers webhooks via Hook0. Per their docs
  // (https://docs.cdp.coinbase.com/data/webhooks/verify-signatures):
  //
  //   - Header:     x-hook0-signature
  //   - Format:     t=<unix_ts>,h=<space-separated-header-names>,v1=<hmac_hex>
  //   - Algorithm:  HMAC-SHA256 over
  //                   `${timestamp}.${headerNames}.${headerValues}.${rawBody}`
  //   - Body:       RAW bytes (we must not json-parse before verifying)
  //   - Window:     5-minute replay tolerance on the `t=` timestamp
  //
  // We verify the signature first, then JSON-parse the raw buffer. The
  // secret comes from the webhook subscription response when the
  // subscription was created in the CDP Portal (stored as CDP_WEBHOOK_SECRET).
  //
  // Event types we care about (dot-separated service.resource.verb):
  //   - onramp.transaction.success   → increment trial counter
  //   - onramp.transaction.failed    → log only
  //   - offramp.transaction.*        → forwarded to offramp handler
  //
  // Status enum (from @coinbase/cdp-sdk OpenAPI schemas):
  //   ONRAMP_ORDER_STATUS_PENDING_AUTH|PENDING_PAYMENT|PROCESSING|COMPLETED|FAILED
  app.post('/api/coinbase/webhook',
    express.raw({ type: '*/*' }),
    async (req, res) => {
      res.status(200).json({ ok: true });

      try {
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
        const rawBodyStr = rawBody.toString('utf8');

        const secret = process.env.CDP_WEBHOOK_SECRET;
        const signatureHeader = req.headers['x-hook0-signature'];

        // Signature verification
        if (secret) {
          const verifyResult = _verifyHook0Signature(rawBodyStr, signatureHeader, secret, req.headers);
          if (!verifyResult.ok) {
            console.warn(`[CDP] Webhook signature rejected: ${verifyResult.reason}`);
            return;
          }
        } else {
          const isMainnet = (process.env.BASE_NETWORK || 'mainnet').toLowerCase() !== 'sepolia';
          if (isMainnet) {
            console.error('[CDP] CDP_WEBHOOK_SECRET not set on mainnet — rejecting webhook.');
            return;
          }
        }

        // Parse JSON after signature verification. Payload is FLAT per
        // Coinbase docs (not { data: {...} } wrapped).
        let payload;
        try { payload = JSON.parse(rawBodyStr); } catch (parseErr) {
          console.warn(`[CDP] Webhook body was not JSON: ${parseErr.message}`);
          try {
            const paymentEventRepo = require('../database/repositories/paymentEventRepo');
            paymentEventRepo.record({
              provider: 'coinbase',
              eventId: `parse-error:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
              eventType: 'parse_error',
              status: 'malformed_json',
              payload: { raw: rawBodyStr.slice(0, 1000), error: parseErr.message },
            });
          } catch { /* best effort */ }
          return;
        }

        const eventType = payload?.eventType || payload?.event_type || payload?.type;
        const status = payload?.status;
        // Per SDK schema, orderId is the canonical id on OnrampOrder.
        // Fall back to transactionId for older event shapes.
        const eventId = payload?.orderId || payload?.eventId || payload?.transactionId || payload?.id;
        const orderId = payload?.orderId || payload?.transactionId;
        const partnerUserRef = payload?.partnerUserRef;
        const purchaseAmount = payload?.purchaseAmount;

        console.log(`[CDP] Webhook: event=${eventType} status=${status} order=${orderId} partnerUserRef=${partnerUserRef}`);

        // Dedupe + trial-counter increment MUST be atomic. If the
        // dedupe INSERT committed but the bot crashed before the
        // increment ran, the retry would see the event as "already
        // processed" and skip — our counter would be under-reported
        // forever, letting users perform more CDP transactions than
        // the trial cap allows. Wrapping both in a single SQLite
        // transaction (via better-sqlite3's db.transaction) makes them
        // commit together or not at all.
        const paymentEventRepo = require('../database/repositories/paymentEventRepo');
        const cdpTrial = require('./cdpTrialService');
        const rootDb = require('../database/db');

        let dedupeInserted = true;
        let newCount = null;

        const isOnrampCompleted =
          eventType === 'onramp.transaction.success' ||
          (eventType === 'onramp.transaction.updated' && status === 'ONRAMP_ORDER_STATUS_COMPLETED') ||
          status === 'ONRAMP_ORDER_STATUS_COMPLETED';
        const purchaseAmountNum = parseFloat(purchaseAmount);
        const hasRealValue = Number.isFinite(purchaseAmountNum) && purchaseAmountNum > 0;

        if (eventId) {
          try {
            rootDb.transaction(() => {
              const inserted = paymentEventRepo.record({
                provider: 'coinbase',
                eventId: `${eventId}:${status || eventType}`,
                eventType,
                orderId: orderId ? String(orderId) : null,
                status,
                payload,
              });
              if (!inserted) {
                dedupeInserted = false;
                return;
              }
              if (isOnrampCompleted && hasRealValue) {
                newCount = cdpTrial.incrementTrialCounter();
              }
            })();
          } catch (txErr) {
            console.warn('[CDP] Webhook atomic tx failed:', txErr.message);
          }
        } else if (isOnrampCompleted && hasRealValue) {
          // No eventId to dedupe on — fall back to bare increment.
          newCount = cdpTrial.incrementTrialCounter();
        }

        if (!dedupeInserted) {
          console.log(`[CDP] Duplicate event ${eventId} — skipping.`);
          return;
        }

        // Post-commit logging + transaction feed.
        if (newCount != null) {
          console.log(`[CDP] Trial counter → ${newCount}/${cdpTrial.getStatus().max} (orderId=${orderId} user=${partnerUserRef} amount=${purchaseAmount})`);
          try {
            const { postTransaction } = require('../utils/transactionFeed');
            postTransaction({
              type: 'cdp_onramp_completed',
              memo: `CDP Onramp completed — ${purchaseAmount} USDC to ${partnerUserRef}. Trial counter ${newCount}/${cdpTrial.getStatus().max}`,
            });
          } catch { /* best effort */ }
        } else if (isOnrampCompleted && !hasRealValue) {
          console.warn(`[CDP] Completed event had zero purchaseAmount (${purchaseAmount}) — NOT incrementing trial counter.`);
        }
      } catch (err) {
        console.error('[CDP] Webhook handler error:', err.message);
      }
    });

  // ─── Internal API for the wallet web surface ─────────────────────
  //
  // These endpoints are called only by our Next.js app on Vercel.
  // Authed via an HMAC-style shared-secret header (X-Internal-Secret)
  // that matches process.env.WALLET_WEB_INTERNAL_SECRET. Without the
  // header (or with a wrong value) the endpoints 401.
  //
  // Endpoints:
  //   POST /api/internal/link/redeem
  //   POST /api/internal/wallet/grant
  //   POST /api/internal/wallet/observed-revoke   (web reports a user-
  //                                                signed revoke landed)

  function _internalAuth(req, res, next) {
    const expected = process.env.WALLET_WEB_INTERNAL_SECRET;
    if (!expected) {
      console.error('[Internal API] WALLET_WEB_INTERNAL_SECRET not set — rejecting all internal calls');
      res.status(503).json({ error: 'internal api not configured' });
      return;
    }
    const provided = req.headers['x-internal-secret'];
    if (!provided || typeof provided !== 'string') {
      res.status(401).json({ error: 'missing X-Internal-Secret header' });
      return;
    }
    // Constant-time compare to avoid timing-leak of the secret.
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'invalid X-Internal-Secret' });
      return;
    }
    next();
  }

  app.post('/api/internal/link/redeem', express.json(), _internalAuth, (req, res) => {
    try {
      const { nonce, purpose } = req.body || {};
      const linkNonceService = require('./linkNonceService');
      const result = linkNonceService.redeem({ nonce, purpose });
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({
        discordId: result.discordId,
        discordTag: result.discordTag,
        userId: result.userId,
        purpose: result.purpose,
      });
    } catch (err) {
      console.error('[Internal API] /link/redeem error:', err.message);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Non-consuming lookup. Used by /setup and /renew on page load so
  // the UI can show "signed in as X" without burning the nonce if
  // the user bails mid-flow. The grant endpoint is what actually
  // consumes the nonce, atomically with the DB write.
  app.post('/api/internal/link/peek', express.json(), _internalAuth, (req, res) => {
    try {
      const { nonce, purpose } = req.body || {};
      const linkNonceService = require('./linkNonceService');
      const result = linkNonceService.peek({ nonce, purpose });
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({
        discordId: result.discordId,
        discordTag: result.discordTag,
        userId: result.userId,
        purpose: result.purpose,
      });
    } catch (err) {
      console.error('[Internal API] /link/peek error:', err.message);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/api/internal/wallet/grant', express.json(), _internalAuth, async (req, res) => {
    // Grant endpoint hardened per audit findings C1/H3/H6:
    //
    //   - Consumes the nonce HERE (not in a prior /link/redeem call)
    //     so the web can't submit a grant for a userId different from
    //     the one the nonce was minted for.
    //   - Verifies permission.spender exactly matches CDP_OWNER_ADDRESS
    //     — rejects grants against a misconfigured web env.
    //   - Verifies the EIP-712 signature SYNCHRONOUSLY via viem's
    //     ERC-6492-aware verifyTypedData before writing anything.
    //   - Does NOT flip wallet.address until the on-chain
    //     approveWithSignature UserOp confirms. So a forged grant that
    //     somehow slips past verification still can't redirect the
    //     user's deposit / Onramp destination.
    try {
      const { nonce, userId, smartWalletAddress, permission, signature, purpose } = req.body || {};
      if (!nonce || !userId || !smartWalletAddress || !permission || !signature) {
        res.status(400).json({ error: 'nonce, userId, smartWalletAddress, permission, signature required' });
        return;
      }

      const expectedPurpose = purpose === 'renew' ? 'renew' : 'setup';
      const linkNonceService = require('./linkNonceService');
      const redeemed = linkNonceService.redeem({ nonce, purpose: expectedPurpose });
      if (!redeemed.ok) {
        res.status(400).json({ error: redeemed.error });
        return;
      }

      // Nonce must bind to the same user the web is claiming. A web
      // bug or malicious caller that passed a different userId is
      // rejected here.
      if (redeemed.userId !== userId) {
        console.warn(
          `[Internal API] /wallet/grant userId mismatch: nonce for user ${redeemed.userId}, ` +
          `request claims ${userId}. Possible forged grant — rejected.`,
        );
        res.status(400).json({ error: 'userId does not match nonce binding' });
        return;
      }

      // permission.account must match the smartWalletAddress the user
      // is reporting. Mismatch = browser bug or tampering.
      if (String(permission.account).toLowerCase() !== String(smartWalletAddress).toLowerCase()) {
        res.status(400).json({ error: 'permission.account does not match smartWalletAddress' });
        return;
      }

      // permission.spender must match our backend Smart Account. If
      // the web env has a stale/wrong spender, every grant signed
      // during that window is useless (bot can't spend against it).
      // Better to reject up front than to debug silent match-start
      // reverts later. Compares to CDP_OWNER_ADDRESS — the repo's
      // canonical env var for escrow-owner-smart.
      const expectedSpender = String(process.env.CDP_OWNER_ADDRESS || '').toLowerCase();
      if (!expectedSpender) {
        res.status(503).json({ error: 'CDP_OWNER_ADDRESS not configured on bot' });
        return;
      }
      if (String(permission.spender).toLowerCase() !== expectedSpender) {
        console.warn(
          `[Internal API] /wallet/grant rejected — permission.spender=${permission.spender} ` +
          `but CDP_OWNER_ADDRESS=${expectedSpender}. Stale NEXT_PUBLIC_BOT_SPENDER_ADDRESS?`,
        );
        res.status(400).json({ error: 'permission.spender does not match bot backend spender' });
        return;
      }

      // Basic permission shape validation (audit M2).
      const spendPermissionService = require('./spendPermissionService');
      const USDC_ADDR = spendPermissionService.USDC_BASE_MAINNET.toLowerCase();
      if (String(permission.token).toLowerCase() !== USDC_ADDR) {
        res.status(400).json({ error: 'permission.token must be USDC on Base' });
        return;
      }
      try {
        const allowance = BigInt(permission.allowance);
        if (allowance <= 0n) throw new Error('allowance must be positive');
        const period = Number(permission.period);
        const start = Number(permission.start);
        const end = Number(permission.end);
        if (!Number.isFinite(period) || period <= 0) throw new Error('period must be positive');
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          throw new Error('end must be > start');
        }
        // Refuse permissions that run more than 2 years — unusual and
        // ties the user to a signature they may regret.
        const maxEnd = Math.floor(Date.now() / 1000) + (2 * 365 * 24 * 60 * 60);
        if (end > maxEnd) throw new Error('end more than 2 years in the future');
      } catch (shapeErr) {
        res.status(400).json({ error: `invalid permission shape: ${shapeErr.message}` });
        return;
      }

      const userRepo = require('../database/repositories/userRepo');
      const walletRepo = require('../database/repositories/walletRepo');

      const user = userRepo.findById(userId);
      if (!user) {
        res.status(404).json({ error: 'user not found' });
        return;
      }

      // Block mid-match wallet-type changes (audit L5). If the user
      // has funds locked in an active match, refuse to accept a new
      // grant — the payout address would change mid-flight.
      const currentWallet = walletRepo.findByUserId(userId);
      if (currentWallet && BigInt(currentWallet.balance_held || 0) > 0n) {
        res.status(409).json({
          error: 'Cannot upgrade wallet while a match is in progress. Finish or cancel it first.',
        });
        return;
      }

      // Synchronous signature verification (viem + ERC-6492). Throws
      // if the sig is bad or malformed.
      let row;
      try {
        row = await spendPermissionService.recordUserGrant({
          userId,
          permission,
          signature,
        });
      } catch (sigErr) {
        console.warn(`[Internal API] /wallet/grant sig verification failed for user ${userId}: ${sigErr.message}`);
        res.status(400).json({ error: 'signature verification failed' });
        return;
      }

      // Respond to the caller now — the on-chain approve + the
      // wallet.address flip happen async below.
      res.json({ ok: true, permissionId: row.id });

      // Background: lift the permission on-chain, then flip the user's
      // wallet.address to the Smart Wallet once approveWithSignature
      // confirms. Flipping AFTER on-chain confirmation means a grant
      // that somehow passes local validation but on-chain validation
      // rejects (e.g. the user revoked between signing and submission)
      // does NOT redirect their deposits to the attacker's address.
      spendPermissionService.approveOnChain(row.id).then(() => {
        try {
          const wallet = walletRepo.findByUserId(userId);
          const smartLower = smartWalletAddress.toLowerCase();
          const db = require('../database/db');
          if (wallet) {
            db.prepare(`
              UPDATE wallets
              SET wallet_type = 'coinbase_smart_wallet',
                  smart_wallet_address = @smart,
                  legacy_cdp_address = COALESCE(legacy_cdp_address, address),
                  address = @smart,
                  migrated_at = COALESCE(migrated_at, datetime('now'))
              WHERE user_id = @userId
            `).run({ smart: smartLower, userId });
          } else {
            walletRepo.create({
              userId,
              address: smartWalletAddress,
              accountRef: null,
              smartAccountRef: null,
            });
            db.prepare(`
              UPDATE wallets
              SET wallet_type = 'coinbase_smart_wallet',
                  smart_wallet_address = @smart,
                  migrated_at = datetime('now')
              WHERE user_id = @userId
            `).run({ smart: smartLower, userId });
          }
          console.log(`[Internal API] Wallet flipped to self-custody for user ${userId} after on-chain approve`);
        } catch (flipErr) {
          console.error(`[Internal API] Wallet flip failed for user ${userId}: ${flipErr.message}`);
        }
      }).catch((err) => {
        console.error(`[Internal API] approveOnChain background failed for row ${row.id}: ${err.message}`);
      });
    } catch (err) {
      console.error('[Internal API] /wallet/grant error:', err.message);
      res.status(500).json({ error: err.message || 'internal error' });
    }
  });

  // Mint a CDP Onramp one-click-buy session on behalf of a user. Called
  // by the web surface (Vercel) AFTER the user has loaded
  // /deposit/coinbase?t=<nonce> in their browser — the web captures
  // the user's real IP from the request and forwards it here so the
  // outbound CDP /sessions call carries clientIp (CDP requires this so
  // the resulting widget URL can only be redeemed by the originating
  // viewer; without it any leak of the URL would be trivially abusable).
  //
  // Body: { nonce, clientIp }
  // Response: { onrampUrl, quote? } or { error }
  app.post('/api/internal/cdp/onramp/mint', express.json(), _internalAuth, async (req, res) => {
    try {
      const { nonce, clientIp } = req.body || {};
      if (!nonce || !clientIp) {
        res.status(400).json({ error: 'nonce and clientIp required' });
        return;
      }

      // Peek first, consume only after CDP succeeds. A 429 / 5xx /
      // TrialExhaustedError from Coinbase shouldn't burn the user's
      // one-time link — they should be able to click the Discord
      // button again and retry against a different provider without
      // having to generate a fresh link.
      const linkNonceService = require('./linkNonceService');
      const peeked = linkNonceService.peek({ nonce, purpose: 'deposit-cdp' });
      if (!peeked.ok) {
        res.status(400).json({ error: peeked.error });
        return;
      }

      const meta = peeked.metadata || {};
      const { walletAddress, amountUsd, country, paymentCurrency, subdivision, partnerUserRef } = meta;
      if (!walletAddress || !amountUsd || !country) {
        res.status(400).json({ error: 'nonce metadata missing required fields' });
        return;
      }

      const onramp = require('./coinbaseOnrampService');
      try {
        const session = await onramp.createOneClickBuySession({
          walletAddress,
          purchaseCurrency: 'USDC',
          destinationNetwork: 'base',
          purchaseAmount: String(amountUsd),
          paymentCurrency,
          country,
          subdivision,
          partnerUserRef,
          clientIp,
        });
        // Consume only after the CDP mint succeeds.
        linkNonceService.redeem({ nonce, purpose: 'deposit-cdp' });
        res.json({ onrampUrl: session.onrampUrl, quote: session.quote || null });
      } catch (err) {
        // TrialExhaustedError still bubbles up as a normal 500 here.
        // The web surface decides what to render — we don't have the
        // bot's silent-fallback-to-Wert path available from this entry
        // point because the original Discord interaction has long since
        // been resolved. The web page surfaces the failure and the user
        // can pick a different provider back in Discord.
        const status = err && err.name === 'TrialExhaustedError' ? 503 : 502;
        console.error('[Internal API] /cdp/onramp/mint failed:', err.message);
        res.status(status).json({ error: err.message || 'cdp session mint failed' });
      }
    } catch (err) {
      console.error('[Internal API] /cdp/onramp/mint error:', err.message);
      res.status(500).json({ error: 'internal error' });
    }
  });

  // Mint a CDP Offramp session token on behalf of a user. Parallel to
  // /cdp/onramp/mint but for cash-out. Returns the full Coinbase offramp
  // URL built from the session token + preset amount.
  //
  // Body: { nonce, clientIp }
  // Response: { offrampUrl } or { error }
  app.post('/api/internal/cdp/offramp/mint', express.json(), _internalAuth, async (req, res) => {
    try {
      const { nonce, clientIp } = req.body || {};
      if (!nonce || !clientIp) {
        res.status(400).json({ error: 'nonce and clientIp required' });
        return;
      }

      // Peek-then-consume — same reasoning as /cdp/onramp/mint.
      const linkNonceService = require('./linkNonceService');
      const peeked = linkNonceService.peek({ nonce, purpose: 'cashout-cdp' });
      if (!peeked.ok) {
        res.status(400).json({ error: peeked.error });
        return;
      }

      const meta = peeked.metadata || {};
      const { walletAddress, amountUsdc } = meta;
      if (!walletAddress || !amountUsdc) {
        res.status(400).json({ error: 'nonce metadata missing required fields' });
        return;
      }

      const onramp = require('./coinbaseOnrampService');
      try {
        const sessionToken = await onramp.createSessionToken({
          walletAddress,
          assets: ['USDC'],
          blockchains: ['base'],
          clientIp,
        });

        const params = new URLSearchParams({
          sessionToken,
          defaultAsset: 'USDC',
          defaultNetwork: 'base',
          partnerUserId: String(walletAddress).slice(0, 49),
          presetCryptoAmount: String(amountUsdc),
        });
        const offrampUrl = `https://pay.coinbase.com/v3/sell/input?${params.toString()}`;

        linkNonceService.redeem({ nonce, purpose: 'cashout-cdp' });
        res.json({ offrampUrl });
      } catch (err) {
        console.error('[Internal API] /cdp/offramp/mint failed:', err.message);
        res.status(502).json({ error: err.message || 'cdp session mint failed' });
      }
    } catch (err) {
      console.error('[Internal API] /cdp/offramp/mint error:', err.message);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.post('/api/internal/wallet/observed-revoke', express.json(), _internalAuth, (req, res) => {
    // Web reports that a user just signed + broadcast a `revoke()`
    // call from their Smart Wallet (revoking a SpendPermission they
    // previously granted us). We update our DB so subsequent
    // spendForUser() calls fail-fast with NO_ACTIVE_PERMISSION rather
    // than wasting a UserOp on a guaranteed-revert spend().
    try {
      const { permissionHash, txHash } = req.body || {};
      if (!permissionHash) {
        res.status(400).json({ error: 'permissionHash required' });
        return;
      }
      const spendPermissionRepo = require('../database/repositories/spendPermissionRepo');
      const row = spendPermissionRepo.findByHash(permissionHash);
      if (!row) {
        res.status(404).json({ error: 'permission not found' });
        return;
      }
      spendPermissionRepo.setRevoked(row.id, txHash || null);
      res.json({ ok: true });
    } catch (err) {
      console.error('[Internal API] /wallet/observed-revoke error:', err.message);
      res.status(500).json({ error: 'internal error' });
    }
  });

  app.use((req, res) => {
    res.status(404).send('not found');
  });

  server = app.listen(port, () => {
    console.log(`[Webhook] Listening on port ${port}`);
  });
}

function stopWebhookServer() {
  if (server) {
    server.close(() => console.log('[Webhook] Stopped'));
    server = null;
    app = null;
    discordClient = null;
  }
}

/**
 * Verify a Hook0 webhook signature.
 *
 * Header format: `t=<unix_ts>,h=<space-separated-header-names>,v1=<hmac_hex>`
 * Signed payload: `${timestamp}.${headerNames}.${headerValues}.${rawBody}`
 * Algorithm: HMAC-SHA256
 * Window: 5-minute max age on the timestamp (replay protection)
 *
 * Returns { ok: boolean, reason: string }.
 */
function _verifyHook0Signature(rawBody, signatureHeader, secret, reqHeaders, maxAgeSeconds = 5 * 60) {
  if (!signatureHeader) return { ok: false, reason: 'missing x-hook0-signature header' };

  const parts = String(signatureHeader).split(',');
  const get = (prefix) => {
    const el = parts.find(p => p.startsWith(prefix));
    return el ? el.slice(prefix.length) : null;
  };

  const timestamp = get('t=');
  const headerNames = get('h=');
  const providedSig = get('v1=');
  if (!timestamp || headerNames == null || !providedSig) {
    return { ok: false, reason: 'signature header missing t=, h=, or v1= component' };
  }
  // Signature encoding is hex per Coinbase's reference code. Reject
  // non-hex v1= up front to keep crypto.timingSafeEqual off malformed
  // input, and reject non-numeric timestamps so the replay window
  // calc below can't become NaN.
  if (!/^[0-9a-fA-F]+$/.test(providedSig)) {
    return { ok: false, reason: 'v1= signature is not hex' };
  }
  if (!/^[0-9]+$/.test(timestamp)) {
    return { ok: false, reason: 't= timestamp is not numeric' };
  }
  // An empty h= list reduces the signed payload to just
  // "timestamp..rawBody" — we never rely on it. Require at least one
  // header name so the signature binds to some non-body context.
  if (!headerNames || !headerNames.trim()) {
    return { ok: false, reason: 'h= header list is empty (refuse to verify body-only signatures)' };
  }

  // Replay guard
  const ageSeconds = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (!Number.isFinite(ageSeconds) || ageSeconds > maxAgeSeconds || ageSeconds < -maxAgeSeconds) {
    return { ok: false, reason: `timestamp out of ±${maxAgeSeconds}s window (age=${ageSeconds}s)` };
  }

  // Build the header-values portion. The `h=` list is space-separated
  // header names (possibly empty string if no extra headers are
  // included). Values are concatenated with '.' separators; missing
  // headers contribute an empty string.
  const names = headerNames ? headerNames.split(' ') : [];
  const values = names.map(name => String(reqHeaders[name.toLowerCase()] ?? '')).join('.');

  const signedPayload = `${timestamp}.${headerNames}.${values}.${rawBody}`;

  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  let verified = false;
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(providedSig, 'hex');
    verified = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (err) {
    return { ok: false, reason: `compare failed: ${err.message}` };
  }

  return verified ? { ok: true, reason: 'ok' } : { ok: false, reason: 'hmac mismatch' };
}

module.exports = { startWebhookServer, stopWebhookServer };
