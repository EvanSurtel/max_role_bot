// Webhook HTTP server — placeholder for future integrations.
// MoonPay was removed. The server still boots on WEBHOOK_PORT for
// any future webhook needs (e.g., Alchemy deposit notifications).

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

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
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
