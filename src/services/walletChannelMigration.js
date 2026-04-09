// One-time migration: delete old per-user wallet channels.
//
// Before the public wallet channel refactor, each registered user had a
// private wallet channel created during onboarding. Those channels eat
// slots against Discord's 500-channel cap and blocked scaling past a
// few hundred users.
//
// This migration runs on every bot startup (idempotent): it finds all
// users with a `wallet_channel_id` set, deletes the channel if it still
// exists, and nulls the column. Wallet balances, addresses, history,
// and all other DB data are preserved — only the Discord channel goes
// away. Users interact with their wallet via the new public #wallet
// channel from now on.

const userRepo = require('../database/repositories/userRepo');

async function migratePerUserWalletChannels(client) {
  const db = require('../database/db');

  const users = db
    .prepare('SELECT id, discord_id, wallet_channel_id FROM users WHERE wallet_channel_id IS NOT NULL')
    .all();

  if (users.length === 0) {
    return; // Nothing to migrate
  }

  console.log(`[Migration] Deleting ${users.length} legacy per-user wallet channel(s)...`);

  let deleted = 0;
  let alreadyGone = 0;
  let failed = 0;

  for (const u of users) {
    try {
      let channel = client.channels.cache.get(u.wallet_channel_id);
      if (!channel) {
        try {
          channel = await client.channels.fetch(u.wallet_channel_id);
        } catch (fetchErr) {
          // Channel doesn't exist anymore — already deleted manually
          alreadyGone++;
          db.prepare('UPDATE users SET wallet_channel_id = NULL WHERE id = ?').run(u.id);
          continue;
        }
      }
      if (!channel) {
        alreadyGone++;
        db.prepare('UPDATE users SET wallet_channel_id = NULL WHERE id = ?').run(u.id);
        continue;
      }
      await channel.delete('Migration: switching to public wallet channel');
      db.prepare('UPDATE users SET wallet_channel_id = NULL WHERE id = ?').run(u.id);
      deleted++;
    } catch (err) {
      failed++;
      console.error(`[Migration] Failed to delete wallet channel for user ${u.discord_id}:`, err.message);
    }
  }

  console.log(
    `[Migration] Wallet channel migration complete: ${deleted} deleted, ${alreadyGone} already gone, ${failed} failed`
  );
}

module.exports = { migratePerUserWalletChannels };
