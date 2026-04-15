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
      // Verify the callback signature if the public key is configured
      const callbackPubKey = process.env.CHANGELLY_CALLBACK_PUBLIC_KEY;
      if (callbackPubKey && req.headers['x-callback-signature']) {
        try {
          const crypto = require('crypto');
          const signature = req.headers['x-callback-signature'];
          const body = JSON.stringify(req.body);

          // Convert base64 key to PEM if needed
          let pemKey = callbackPubKey;
          if (!pemKey.includes('-----BEGIN')) {
            pemKey = `-----BEGIN PUBLIC KEY-----\n${pemKey}\n-----END PUBLIC KEY-----`;
          }

          const pubKeyObj = crypto.createPublicKey(pemKey);
          const isValid = crypto.verify('sha256', Buffer.from(body), pubKeyObj, Buffer.from(signature, 'base64'));
          if (!isValid) {
            console.warn('[Changelly] Invalid webhook signature — rejecting');
            return;
          }
        } catch (verifyErr) {
          console.warn(`[Changelly] Signature verification error: ${verifyErr.message} — processing anyway`);
        }
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
