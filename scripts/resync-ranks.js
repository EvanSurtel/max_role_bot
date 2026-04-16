#!/usr/bin/env node
// One-shot rank role resync. Pulls every TOS-accepted user from the
// DB, looks up their current NeatQueue XP, picks the right tier from
// RANK_TIERS in constants.js, and grants/strips Discord roles to match.
//
// Run after changing rank tier thresholds (constants.js → RANK_TIERS)
// so existing members move to their new correct tier without waiting
// for them to play another match.
//
// Usage:
//   node scripts/resync-ranks.js

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { syncAllRanks } = require('../src/utils/rankRoleSync');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('ready', async () => {
  console.log(`[Resync] Logged in as ${client.user.tag}`);
  console.log('[Resync] Starting full rank resync...');
  try {
    await syncAllRanks(client);
    console.log('[Resync] Done.');
  } catch (err) {
    console.error('[Resync] Failed:', err);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.BOT_TOKEN);
