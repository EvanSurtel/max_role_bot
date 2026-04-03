require('dotenv').config();
const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data) {
    commands.push(command.data.toJSON());
    console.log(`[Deploy] Loaded command: ${command.data.name}`);
  } else {
    console.warn(`[Deploy] Skipping ${file} — missing "data" export`);
  }
}

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
  try {
    console.log(`[Deploy] Registering ${commands.length} command(s) to guild ${process.env.GUILD_ID}...`);

    const data = await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands },
    );

    console.log(`[Deploy] Successfully registered ${data.length} command(s)`);
  } catch (err) {
    console.error('[Deploy] Error registering commands:', err);
    process.exit(1);
  }
})();
