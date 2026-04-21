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

        // Idempotency — dedupe on (provider, eventId). Coinbase retries
        // on 5xx, so the same event can arrive multiple times.
        if (eventId) {
          try {
            const paymentEventRepo = require('../database/repositories/paymentEventRepo');
            const inserted = paymentEventRepo.record({
              provider: 'coinbase',
              eventId: `${eventId}:${status || eventType}`,
              eventType,
              orderId: orderId ? String(orderId) : null,
              status,
              payload,
            });
            if (!inserted) {
              console.log(`[CDP] Duplicate event ${eventId} — skipping.`);
              return;
            }
          } catch (dedupeErr) {
            console.warn('[CDP] Dedupe check failed, processing anyway:', dedupeErr.message);
          }
        }

        // Increment trial counter on confirmed onramp completions.
        // Accept both event-type signals (.success) and status signals
        // (ONRAMP_ORDER_STATUS_COMPLETED) — Coinbase docs aren't
        // 100% explicit on which fires, so either qualifies.
        const isOnrampCompleted =
          eventType === 'onramp.transaction.success' ||
          (eventType === 'onramp.transaction.updated' && status === 'ONRAMP_ORDER_STATUS_COMPLETED') ||
          status === 'ONRAMP_ORDER_STATUS_COMPLETED';

        if (isOnrampCompleted) {
          const cdpTrial = require('./cdpTrialService');
          const newCount = cdpTrial.incrementTrialCounter();
          console.log(`[CDP] Trial counter → ${newCount}/${cdpTrial.getStatus().max} (orderId=${orderId} user=${partnerUserRef} amount=${purchaseAmount})`);

          try {
            const { postTransaction } = require('../utils/transactionFeed');
            postTransaction({
              type: 'cdp_onramp_completed',
              memo: `CDP Onramp completed — ${purchaseAmount} USDC to ${partnerUserRef}. Trial counter ${newCount}/${cdpTrial.getStatus().max}`,
            });
          } catch { /* best effort */ }
        }
      } catch (err) {
        console.error('[CDP] Webhook handler error:', err.message);
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
