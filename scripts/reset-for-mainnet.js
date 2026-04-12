#!/usr/bin/env node
/* eslint-disable no-console */
// One-off mainnet cutover reset.
//
// Run this ONCE when you're switching the bot from devnet testing
// to real mainnet. It wipes the leaderboard stats built up during
// devnet play AND force-refreshes every user's Discord server
// nickname so the `[XP] [$earnings]` brackets reflect the clean
// state, not the devnet numbers.
//
// Without this script, nicknames stay stuck on their old devnet
// values until each user plays a real match (because the bot only
// refreshes a user's nickname as part of post-match cleanup).
//
// USAGE — stop the bot first so there's no second client logging
// in with the same token:
//
//   pm2 stop all
//   node scripts/reset-for-mainnet.js
//   pm2 start all
//
// What it touches:
//   1. users table: total_wins, total_losses, xp_points,
//      total_earnings_usdc, total_wagered_usdc — all reset to the
//      clean-slate baseline (0 / 0 / 500 / 0 / 0)
//   2. Every member in the guild with accepted_tos=1 gets their
//      nickname rewritten via the same updateNickname helper the
//      bot uses post-match
//   3. If NeatQueue is configured, every user is setPoints'd back
//      to exactly 500 (uses the new additive-safe helper, not the
//      legacy addPoints that stacked on existing values)

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

async function main() {
  console.log('[Reset] Mainnet cutover reset starting...');

  // ─── 1. DB: reset all user stats ───────────────────────────
  const db = require('../src/database/db');
  const result = db.prepare(`
    UPDATE users
    SET total_wins = 0,
        total_losses = 0,
        xp_points = 500,
        total_earnings_usdc = '0',
        total_wagered_usdc = '0'
    WHERE accepted_tos = 1
  `).run();
  console.log(`[Reset] ✓ ${result.changes} user stat row(s) reset in the DB`);

  // ─── 2. Log in as the bot to refresh Discord nicknames ─────
  if (!process.env.BOT_TOKEN) {
    console.error('[Reset] BOT_TOKEN not set in .env — cannot log in to update nicknames.');
    process.exit(1);
  }
  if (!process.env.GUILD_ID) {
    console.error('[Reset] GUILD_ID not set in .env — cannot find the guild to update nicknames.');
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ],
  });

  console.log('[Reset] Logging in to Discord...');
  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.login(process.env.BOT_TOKEN).catch(reject);
  });
  console.log(`[Reset] ✓ Logged in as ${client.user.tag}`);

  const users = db.prepare(
    'SELECT id, discord_id, server_username, cod_ign, country_flag FROM users WHERE accepted_tos = 1',
  ).all();
  console.log(`[Reset] Refreshing ${users.length} nickname(s)...`);

  const { updateNickname } = require('../src/utils/nicknameUpdater');
  let ok = 0, skipped = 0, failed = 0;
  for (const u of users) {
    try {
      await updateNickname(client, u.id);
      ok++;
    } catch (err) {
      console.warn(`[Reset] Failed for user id=${u.id} discord=${u.discord_id}: ${err.message || err}`);
      failed++;
    }
    // Gentle pacing to stay well under Discord rate limits
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(`[Reset] ✓ Nicknames: ${ok} updated, ${skipped} skipped, ${failed} failed`);

  // ─── 3. NeatQueue: full reset then seed everyone to 500 ────
  const neatqueueService = require('../src/services/neatqueueService');
  if (neatqueueService.isConfigured()) {
    // Step A: wipe every stat (points, wins, losses, etc.) for the
    // entire queue channel. Hits /api/v2/managestats/reset/all with
    // IDs as strings (not parseInt — big Discord snowflakes overflow
    // Number precision, which is what broke the old season-end flow).
    console.log('[Reset] Full NeatQueue channel reset...');
    try {
      const token = process.env.NEATQUEUE_API_TOKEN;
      const channelId = process.env.NEATQUEUE_CHANNEL_ID;
      const guildId = process.env.GUILD_ID;
      const res = await fetch('https://api.neatqueue.com/api/v2/managestats/reset/all', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ server_id: guildId, channel_id: channelId }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`[Reset] NeatQueue /managestats/reset/all failed (${res.status}): ${body}`);
      } else {
        console.log('[Reset] ✓ NeatQueue channel wiped to zero');
      }
    } catch (err) {
      console.warn(`[Reset] NeatQueue reset request failed: ${err.message || err}`);
    }

    // Step B: seed every registered user back to exactly 500 points.
    // setPoints reads the current value (which should be 0 after the
    // wipe above, but be defensive) and adds the delta needed to hit
    // 500. Safe to run even if the wipe didn't take.
    console.log('[Reset] Seeding NeatQueue points (500 per user)...');
    let nqOk = 0, nqFailed = 0;
    for (const u of users) {
      try {
        await neatqueueService.setPoints(u.discord_id, 500);
        nqOk++;
      } catch (err) {
        console.warn(`[Reset] NeatQueue setPoints failed for ${u.discord_id}: ${err.message || err}`);
        nqFailed++;
      }
      // Tiny pacing between HTTP calls so NeatQueue's rate limiter
      // doesn't start rejecting them.
      await new Promise(r => setTimeout(r, 120));
    }
    console.log(`[Reset] ✓ NeatQueue seeded: ${nqOk} ok, ${nqFailed} failed`);
  } else {
    console.log('[Reset] NeatQueue not configured — skipping');
  }

  console.log();
  console.log('[Reset] ✅ Done. Now run `pm2 start all` to bring the bot back up.');
  await client.destroy();
  process.exit(0);
}

main().catch(err => {
  console.error('[Reset] ❌ FATAL:', err);
  process.exit(1);
});
