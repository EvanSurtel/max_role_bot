// Deploy (register) slash commands with Discord for the bot's guild.
//
// Run this WHENEVER you add or change a slash command definition:
//   npm run deploy-commands
//
// Slash commands are the only user-facing commands in the bot — every
// other user interaction happens via button panels. Currently we only
// have /rank; add more by dropping files into src/commands/.

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');

if (!fs.existsSync(commandsPath)) {
  console.warn('[Deploy] No commands directory — nothing to register.');
  process.exit(0);
}

const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command && command.data) {
    commands.push(command.data.toJSON());
    console.log(`[Deploy] Loaded command: ${command.data.name}`);
  } else {
    console.warn(`[Deploy] Skipping ${file} — missing "data" export`);
  }
}

if (commands.length === 0) {
  console.warn('[Deploy] No commands to register.');
  process.exit(0);
}

const token = process.env.BOT_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error('[Deploy] BOT_TOKEN, CLIENT_ID, and GUILD_ID must be set in .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log(`[Deploy] Registering ${commands.length} command(s) to guild ${guildId}...`);
    const data = await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      { body: commands },
    );
    console.log(`[Deploy] Successfully registered ${data.length} command(s)`);
  } catch (err) {
    console.error('[Deploy] Error registering commands:', err);
    process.exit(1);
  }
})();
