// Force-repost the 'skip if intact' panels (how-it-works, rules,
// rank-tiers). Used after editing those panel templates so users see
// the new copy — without this, the bot detects the existing panels
// in the channel and skips re-posting on its normal boot path.
//
// Usage:
//   node scripts/force-repost-panels.js
//   pm2 restart wager-bot --update-env
//
// Step 1 deletes the old bot messages in each panel channel; step 2
// (the bot restart) triggers postSupportPanel/postRulesPanel/etc.,
// which now sees no existing panel and posts fresh.

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once('clientReady', async () => {
  console.log('Logged in as', client.user.tag);

  const targets = [
    { id: process.env.HOW_IT_WORKS_CHANNEL_ID, label: 'how-it-works' },
    { id: process.env.RULES_CHANNEL_ID, label: 'rules' },
    { id: process.env.RANKS_CHANNEL_ID, label: 'rank-tiers' },
  ];

  for (const t of targets) {
    if (!t.id) {
      console.log(`Skipping ${t.label} — env var not set`);
      continue;
    }
    const ch = client.channels.cache.get(t.id)
      || await client.channels.fetch(t.id).catch(() => null);
    if (!ch) {
      console.log(`Skipping ${t.label} — channel not found`);
      continue;
    }
    const messages = await ch.messages.fetch({ limit: 50 });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    let deleted = 0;
    for (const [, m] of botMessages) {
      try { await m.delete(); deleted++; } catch { /* */ }
    }
    console.log(`#${t.label}: deleted ${deleted} bot messages`);
  }

  console.log('Done. Restart bot — fresh panels will post on boot.');
  process.exit(0);
});

client.login(process.env.BOT_TOKEN);
