// Tunnel health monitor.
//
// The bot's webhook server is exposed to Vercel via a Cloudflare
// quick-tunnel (cloudflared). Quick tunnels rotate their URL every
// time the cloudflared process restarts — so a bot reboot, Oracle
// reboot, or a cloudflared crash hands back a fresh trycloudflare.com
// URL that no longer matches Vercel's `BOT_API_BASE_URL`. Every
// Vercel-side call (link peek/redeem, wallet grant, CDP onramp mint,
// etc.) then 502s silently, and users see "wallet not found" /
// "setup failed" without the operator realizing the tunnel is the
// actual culprit.
//
// This service is a simple outbound heartbeat: the bot fetches its
// own `${BOT_PUBLIC_URL}/health` endpoint every 5 minutes. If the
// URL fails `FAIL_THRESHOLD` times in a row, a Discord alert fires
// against `ADMIN_ALERTS_CHANNEL_ID` so the operator can refresh the
// Vercel env var + redeploy. Success after an alert fires a
// "recovered" message.
//
// Set `BOT_PUBLIC_URL` in the bot's .env to the same
// trycloudflare.com URL you put in Vercel's `BOT_API_BASE_URL`.
// If it's unset the heartbeat is disabled (no-op, no alerts).

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const REQUEST_TIMEOUT_MS = 10_000;       // 10s
const FAIL_THRESHOLD = 3;                // alert after 3 consecutive fails

let _timer = null;
let _started = false;
let _failCount = 0;
let _alertSentForCurrentOutage = false;
let _discordClient = null;

async function _tick() {
  const url = process.env.BOT_PUBLIC_URL;
  if (!url) return;

  let ok = false;
  let detail = '';
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      if (body && body.status === 'ok') ok = true;
      else detail = `unexpected body: ${JSON.stringify(body).slice(0, 120)}`;
    } else {
      detail = `HTTP ${res.status}`;
    }
  } catch (err) {
    detail = err.message || String(err);
  }

  if (ok) {
    if (_alertSentForCurrentOutage) {
      _postAdminAlert(
        `✅ Tunnel recovered. \`${url}\` is reachable again.`,
      );
      _alertSentForCurrentOutage = false;
    }
    _failCount = 0;
    return;
  }

  _failCount++;
  console.warn(`[TunnelHealth] ${url} unreachable (${_failCount}/${FAIL_THRESHOLD}): ${detail}`);
  if (_failCount >= FAIL_THRESHOLD && !_alertSentForCurrentOutage) {
    _postAdminAlert(
      `🚨 **Tunnel unreachable** — \`${url}\` has failed ${FAIL_THRESHOLD} consecutive health checks.\n` +
      `Last error: \`${detail}\`.\n\n` +
      `If you're using a Cloudflare quick tunnel, the URL probably rotated. Grab the new one:\n` +
      `\`sudo journalctl -u cloudflared-rank --since today | grep trycloudflare.com\`\n` +
      `Paste it into Vercel's \`BOT_API_BASE_URL\` env var and redeploy. Also update \`BOT_PUBLIC_URL\` in this bot's .env + restart.`,
    );
    _alertSentForCurrentOutage = true;
  }
}

async function _postAdminAlert(content) {
  const channelId = process.env.ADMIN_ALERTS_CHANNEL_ID;
  if (!channelId || !_discordClient) return;
  try {
    const ch = _discordClient.channels.cache.get(channelId);
    if (ch) await ch.send({ content });
  } catch (err) {
    console.error(`[TunnelHealth] Failed to send admin alert: ${err.message}`);
  }
}

function start(client) {
  if (_started) return;
  _started = true;
  _discordClient = client;
  if (!process.env.BOT_PUBLIC_URL) {
    console.log('[TunnelHealth] BOT_PUBLIC_URL not set — heartbeat disabled.');
    return;
  }
  console.log(`[TunnelHealth] Starting heartbeat against ${process.env.BOT_PUBLIC_URL} (every ${POLL_INTERVAL_MS / 1000}s)`);
  // Run once immediately so we learn URL state at boot instead of
  // waiting 5 minutes.
  _tick().catch(() => {});
  _timer = setInterval(() => {
    _tick().catch((err) => console.error('[TunnelHealth] tick error:', err.message));
  }, POLL_INTERVAL_MS);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _started = false;
  _discordClient = null;
  _failCount = 0;
  _alertSentForCurrentOutage = false;
}

module.exports = { start, stop };
