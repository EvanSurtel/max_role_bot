#!/usr/bin/env node
require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once('ready', async () => {
  const chId = process.env.RANKS_CHANNEL_ID;
  console.log('RANKS_CHANNEL_ID:', chId || 'NOT SET');

  if (!chId) { c.destroy(); return; }

  const ch = c.channels.cache.get(chId);
  console.log('Channel found:', ch ? ch.name : 'NOT IN CACHE');

  if (!ch) {
    try {
      const fetched = await c.channels.fetch(chId);
      console.log('Fetched:', fetched ? fetched.name : 'FAILED');
    } catch (e) {
      console.log('Fetch error:', e.message);
    }
    c.destroy();
    return;
  }

  try {
    const msg = await ch.send('Ranks channel test');
    await msg.delete();
    console.log('Can send + delete: YES');
  } catch (e) {
    console.log('Send error:', e.message);
  }

  c.destroy();
});
c.login(process.env.BOT_TOKEN);
