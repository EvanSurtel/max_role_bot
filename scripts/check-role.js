#!/usr/bin/env node
// Diagnostic: print each registered user's XP + their currently-held
// rank role(s). Useful for spotting drift between xp_points and
// what's assigned on Discord (e.g. after a thresholds change, after
// an env-var rename, or after Discord role-hierarchy issues block
// the bot from updating roles).
//
// If a user shows the WRONG rank role for their XP, run
//   node scripts/resync-ranks.js
// to re-sync everyone.
//
// Usage:
//   node scripts/check-role.js          (last 20 registered users)
//   node scripts/check-role.js --all    (every TOS-accepted user)

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { allSubTierEnvVarNames, computeSubTier } = require('../src/utils/subTier');
const db = require('../src/database/db');

const ALL = process.argv.includes('--all');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('clientReady', async () => {
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) { console.error('GUILD_ID not in cache'); process.exit(1); }
  await guild.members.fetch();

  // Build a lookup of every configured rank-role ID → role name so we
  // can identify which roles the member is carrying.
  const rankRoleIdToName = {};
  for (const v of allSubTierEnvVarNames()) {
    const id = process.env[v];
    if (!id) continue;
    const role = guild.roles.cache.get(id);
    rankRoleIdToName[id] = role ? role.name : `(role ${id} not found on server)`;
  }

  const sql = ALL
    ? 'SELECT id, server_username, xp_points, discord_id FROM users WHERE accepted_tos = 1 ORDER BY xp_points DESC'
    : 'SELECT id, server_username, xp_points, discord_id FROM users WHERE accepted_tos = 1 ORDER BY id DESC LIMIT 20';
  const users = db.prepare(sql).all();

  let mismatches = 0;
  for (const u of users) {
    const m = guild.members.cache.get(u.discord_id);
    const expected = computeSubTier(u.xp_points || 0, false).englishName;
    const heldRoles = m
      ? [...m.roles.cache.values()].filter(r => rankRoleIdToName[r.id]).map(r => r.name)
      : ['(member not found)'];
    const heldStr = heldRoles.length ? heldRoles.join(', ') : '(none)';
    const flag = m && heldRoles.length === 1 && heldRoles[0] === expected ? ' ' : '!';
    if (flag === '!') mismatches++;
    console.log(`${flag} ${u.server_username || u.discord_id} xp=${u.xp_points} expected=${expected} held=${heldStr}`);
  }
  console.log(`---\n${users.length} users checked, ${mismatches} mismatch(es).`);
  if (mismatches > 0) console.log('Run: node scripts/resync-ranks.js');
  process.exit(0);
});

client.login(process.env.BOT_TOKEN);
