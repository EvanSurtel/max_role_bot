// Webhook HTTP server — handles Changelly fiat on-ramp callbacks
// and health checks. Runs on WEBHOOK_PORT (default 3001).

const express = require('express');

let app = null;
let server = null;

function startWebhookServer() {
  if (server) return;

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
  // Changelly sends POST requests with transaction status updates.
  // When a fiat purchase completes, the user's USDC arrives at their
  // wallet on Base — the deposit poller picks it up automatically.
  // This webhook just logs the status for tracking/debugging.
  app.post('/api/changelly/webhook', (req, res) => {
    // Always respond 200 so Changelly doesn't retry
    res.status(200).json({ ok: true });

    try {
      const payload = req.body;
      const { externalOrderId, externalUserId, status, currencyTo, amountTo, payoutAddress } = payload || {};

      console.log(`[Changelly] Webhook: order=${externalOrderId} user=${externalUserId} status=${status} amount=${amountTo} ${currencyTo} → ${payoutAddress}`);

      if (status === 'completed' || status === 'finished') {
        console.log(`[Changelly] ✅ Order ${externalOrderId} completed — ${amountTo} ${currencyTo} sent to ${payoutAddress}`);
        // The deposit poller will detect the USDC balance increase
        // and credit the user's DB balance automatically.
        // No manual action needed here.
      } else if (status === 'failed' || status === 'expired' || status === 'refunded') {
        console.warn(`[Changelly] ❌ Order ${externalOrderId} ${status} for user ${externalUserId}`);
      }
    } catch (err) {
      console.error('[Changelly] Webhook parse error:', err.message);
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
  }
}

module.exports = { startWebhookServer, stopWebhookServer };
