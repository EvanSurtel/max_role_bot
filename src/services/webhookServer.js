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
  app.use(express.json());

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // ─── Changelly Fiat On-Ramp Webhook ─────────────────────────
  app.post('/api/changelly/webhook', async (req, res) => {
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
        payoutAddress,
      } = payload || {};

      console.log(`[Changelly] Webhook: order=${externalOrderId} user=${externalUserId} status=${status} amount=${amountTo} ${currencyTo}`);

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
  // Coinbase posts transaction.updated events here when an Onramp
  // session completes or fails. We use it to increment the CDP trial
  // counter so the payment router auto-falls-back to Wert once the
  // 25-transaction trial cap is exhausted.
  //
  // Docs: https://docs.cdp.coinbase.com/onramp/additional-resources/webhooks
  // Signature verification is via HMAC with CDP_WEBHOOK_SECRET.
  app.post('/api/coinbase/webhook', async (req, res) => {
    res.status(200).json({ ok: true });

    try {
      // Signature verification — only runs if CDP_WEBHOOK_SECRET is
      // set. On mainnet without a secret we refuse to increment the
      // counter (otherwise anyone could POST to this endpoint and
      // accelerate trial burn).
      const secret = process.env.CDP_WEBHOOK_SECRET;
      const signature = req.headers['x-cc-webhook-signature'] || req.headers['x-webhook-signature'];
      if (secret) {
        try {
          const crypto = require('crypto');
          const body = JSON.stringify(req.body);
          const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
          if (!signature || signature !== expected) {
            console.warn('[CDP] Webhook signature mismatch — ignoring');
            return;
          }
        } catch (verifyErr) {
          console.warn('[CDP] Webhook signature verification error:', verifyErr.message);
          return;
        }
      } else {
        const isMainnet = (process.env.BASE_NETWORK || 'mainnet').toLowerCase() !== 'sepolia';
        if (isMainnet) {
          console.error('[CDP] CDP_WEBHOOK_SECRET not set on mainnet — rejecting webhook to prevent trial-counter tampering.');
          return;
        }
      }

      const payload = req.body;
      const eventType = payload?.eventType || payload?.event_type || payload?.type;
      const status = payload?.data?.status || payload?.status;

      console.log(`[CDP] Webhook received: event=${eventType} status=${status}`);

      // Increment trial counter ONLY on confirmed onramp completions.
      // Offramp events don't count separately (Coinbase's trial cap is
      // shared, but we're not offering CDP offramp on Day 1).
      const isOnrampCompleted =
        (eventType === 'onramp.transaction.updated' && status === 'ONRAMP_ORDER_STATUS_COMPLETED') ||
        (status === 'ONRAMP_ORDER_STATUS_COMPLETED');

      if (isOnrampCompleted) {
        const cdpTrial = require('./cdpTrialService');
        const newCount = cdpTrial.incrementTrialCounter();
        console.log(`[CDP] Trial counter incremented → ${newCount}/${cdpTrial.getStatus().max}`);

        // Best-effort transaction feed log
        try {
          const { postTransaction } = require('../utils/transactionFeed');
          postTransaction({
            type: 'cdp_onramp_completed',
            memo: `CDP Onramp completed — trial counter now ${newCount}/${cdpTrial.getStatus().max}`,
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

module.exports = { startWebhookServer, stopWebhookServer };
