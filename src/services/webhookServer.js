// Minimal Express HTTP server for receiving webhook callbacks.
//
// Right now the only thing it handles is MoonPay webhooks, but the
// pattern lets us add more providers later (Stripe, Checkout.com,
// etc.) by mounting additional routes.
//
// Started from src/index.js once the Discord client is ready.
//
// ── Deployment ────────────────────────────────────────────────
// The server listens on WEBHOOK_PORT (default 3001). For MoonPay
// to reach it you need a publicly reachable URL:
//
//   * Sandbox/dev: run ngrok locally
//         ngrok http 3001
//      and paste the https URL into MoonPay dashboard → Webhooks.
//   * Production: put nginx/Caddy/Cloudflare in front of the bot
//      on a real domain with TLS, reverse-proxy /webhooks/* to
//      localhost:3001.
//
// Set WEBHOOK_PUBLIC_URL in .env to the public base URL (used by
// anything that needs to tell a third party how to reach you).

const express = require('express');
const moonpay = require('./moonpay');
const moonpayService = require('./moonpayService');

let app = null;
let server = null;

function startWebhookServer() {
  if (server) {
    console.warn('[Webhook] Already running — skipping start');
    return;
  }

  const port = parseInt(process.env.WEBHOOK_PORT || '3001', 10);
  if (!port || Number.isNaN(port)) {
    console.warn('[Webhook] WEBHOOK_PORT not set or invalid — webhook server disabled');
    return;
  }

  app = express();

  // ─── Health check (for uptime monitoring / manual ping) ────
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // ─── MoonPay webhook endpoint ──────────────────────────────
  // MUST use express.raw so req.body is the raw Buffer — we need
  // the byte-exact payload to recompute the HMAC. Using
  // express.json() would re-serialize and break signature matching.
  app.post('/webhooks/moonpay', express.raw({ type: '*/*' }), async (req, res) => {
    try {
      const rawBody = req.body; // Buffer
      const sigHeader = req.header('Moonpay-Signature-V2');
      if (!moonpay.verifyWebhookSignature(rawBody, sigHeader)) {
        console.warn('[Webhook] MoonPay signature verification FAILED');
        return res.status(401).send('invalid signature');
      }

      let event;
      try {
        event = JSON.parse(rawBody.toString('utf8'));
      } catch (parseErr) {
        console.error('[Webhook] MoonPay body not valid JSON:', parseErr.message);
        return res.status(400).send('bad json');
      }

      // Respond to MoonPay FAST so they don't retry while we process
      res.status(200).send('ok');

      // Process async after responding — any DB/chain work should
      // not block the HTTP response. Errors here are logged, not
      // thrown, because the response is already sent.
      try {
        await moonpayService.handleWebhook(event);
      } catch (handlerErr) {
        console.error('[Webhook] MoonPay handler threw:', handlerErr);
      }
    } catch (err) {
      console.error('[Webhook] MoonPay endpoint outer error:', err);
      if (!res.headersSent) res.status(500).send('error');
    }
  });

  // 404 for anything else so we don't accidentally expose other
  // routes on the same port
  app.use((req, res) => {
    res.status(404).send('not found');
  });

  server = app.listen(port, () => {
    console.log(`[Webhook] Listening on port ${port} — POST /webhooks/moonpay`);
    if (process.env.WEBHOOK_PUBLIC_URL) {
      console.log(`[Webhook] Public URL: ${process.env.WEBHOOK_PUBLIC_URL}/webhooks/moonpay`);
    } else {
      console.log('[Webhook] WEBHOOK_PUBLIC_URL not set — set this to whatever MoonPay should POST to (your domain or ngrok URL)');
    }
  });

  server.on('error', (err) => {
    console.error('[Webhook] Server error:', err.message);
  });
}

function stopWebhookServer() {
  if (server) {
    server.close(() => {
      console.log('[Webhook] Stopped');
    });
    server = null;
    app = null;
  }
}

module.exports = { startWebhookServer, stopWebhookServer };
