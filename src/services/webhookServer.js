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

  // ─── NeatQueue Match Completed Webhook ───────────────────────
  // Receives MATCH_COMPLETED events from NeatQueue when a queue
  // match finishes. Stores the result in our local DB so the bot
  // owns all stats data — queue stats panel can then read locally
  // instead of hitting NeatQueue's API.
  //
  // NeatQueue webhook setup: /webhooks setup in your Discord server,
  // point at http://YOUR-SERVER:3001/api/neatqueue/webhook
  app.post('/api/neatqueue/webhook', async (req, res) => {
    res.status(200).json({ ok: true });

    try {
      const payload = req.body;
      const action = payload?.action || payload?.event || payload?.type;

      console.log(`[NeatQueue] Webhook received: action=${action}`);

      if (action !== 'MATCH_COMPLETED' && action !== 'match_completed') {
        return; // Only process completed matches
      }

      // Extract match data — NeatQueue's payload shape may vary.
      // Probe common field names for robustness.
      const teams = payload.teams || payload.team_data || [];
      const winningTeam = payload.winning_team ?? payload.winner ?? null;
      const matchId = payload.match_id || payload.game_number || payload.id;
      const pointsAwarded = payload.points_awarded || payload.mmr_changes || {};

      if (!teams || teams.length === 0) {
        console.warn('[NeatQueue] MATCH_COMPLETED webhook has no team data — skipping');
        return;
      }

      const db = require('../database/db');
      const userRepo = require('../database/repositories/userRepo');
      const { getCurrentSeason } = require('../panels/leaderboardPanel');

      // Flatten all players from all teams
      const allPlayers = [];
      for (let teamIdx = 0; teamIdx < teams.length; teamIdx++) {
        const team = teams[teamIdx];
        const players = team.players || team.members || team;
        if (!Array.isArray(players)) continue;
        for (const p of players) {
          const discordId = String(p.user_id || p.userId || p.id || p.discord_id || '');
          if (!discordId) continue;
          const isWinner = winningTeam != null
            ? (teamIdx + 1) === winningTeam || teamIdx === winningTeam
            : (p.result === 'win' || p.winner === true);

          // XP delta from NeatQueue (if provided)
          const xpDelta = Number(
            (pointsAwarded[discordId]) ||
            p.points_change || p.mmr_change || p.xp_change || 0
          );

          allPlayers.push({ discordId, isWinner, xpDelta, teamIdx });
        }
      }

      if (allPlayers.length === 0) {
        console.warn('[NeatQueue] No players extracted from MATCH_COMPLETED — skipping');
        return;
      }

      console.log(`[NeatQueue] Processing queue match #${matchId || '?'}: ${allPlayers.length} players, ${allPlayers.filter(p => p.isWinner).length} winners`);

      const season = getCurrentSeason();
      const insertXpHistory = db.prepare(
        'INSERT INTO xp_history (user_id, match_id, match_type, xp_amount, season) VALUES (?, ?, ?, ?, ?)'
      );

      for (const p of allPlayers) {
        const user = userRepo.findByDiscordId(p.discordId);
        if (!user) {
          console.warn(`[NeatQueue] User ${p.discordId} not registered — skipping queue stats update`);
          continue;
        }

        try {
          // Update local stats
          if (p.isWinner) {
            userRepo.addWin(user.id);
          } else {
            userRepo.addLoss(user.id);
          }

          if (p.xpDelta && p.xpDelta !== 0) {
            userRepo.addXp(user.id, p.xpDelta);
            insertXpHistory.run(user.id, null, 'queue', p.xpDelta, season);
          }

          console.log(`[NeatQueue]   ${p.discordId}: ${p.isWinner ? 'W' : 'L'} ${p.xpDelta > 0 ? '+' : ''}${p.xpDelta} XP`);
        } catch (err) {
          console.error(`[NeatQueue] Failed to update stats for ${p.discordId}:`, err.message);
        }
      }

      // Sync nicknames + rank roles for all affected players
      try {
        const { updateNicknames } = require('../utils/nicknameUpdater');
        const { syncRanks } = require('../utils/rankRoleSync');
        const userIds = allPlayers
          .map(p => userRepo.findByDiscordId(p.discordId))
          .filter(Boolean)
          .map(u => u.id);

        if (discordClient && userIds.length > 0) {
          updateNicknames(discordClient, userIds).catch(err =>
            console.error('[NeatQueue] Nickname update failed:', err.message)
          );
          syncRanks(discordClient, userIds).catch(err =>
            console.error('[NeatQueue] Rank sync failed:', err.message)
          );
        }
      } catch (err) {
        console.error('[NeatQueue] Post-match sync failed:', err.message);
      }

      // Post to admin feed
      try {
        const { postTransaction } = require('../utils/transactionFeed');
        const winners = allPlayers.filter(p => p.isWinner).map(p => `<@${p.discordId}>`).join(', ');
        const losers = allPlayers.filter(p => !p.isWinner).map(p => `<@${p.discordId}>`).join(', ');
        postTransaction({
          type: 'queue_match',
          memo: `Queue match #${matchId || '?'} completed\nWinners: ${winners}\nLosers: ${losers}`,
        });
      } catch { /* best effort */ }

    } catch (err) {
      console.error('[NeatQueue] Webhook handler error:', err.message);
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
