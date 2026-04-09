require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');

// Create the Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Load event files
const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'));

for (const file of eventFiles) {
  const event = require(path.join(eventsPath, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
  console.log(`[Events] Loaded: ${event.name}${event.once ? ' (once)' : ''}`);
}

// On ready: initialize database, Solana connection, and services
client.once('ready', async () => {
  try {
    // Initialize database (runs migrations on require)
    require('./database/db');
    console.log('[DB] Database initialized');

    // Register timer handlers and load pending timers from DB
    const timerService = require('./services/timerService');
    const timerHandlers = require('./services/timerHandlers');
    timerHandlers.registerAll(client);
    timerService.loadPendingTimers();

    // Initialize transaction feed
    const { setClient: setTxFeedClient } = require('./utils/transactionFeed');
    setTxFeedClient(client);

    // Initialize Solana connection
    const { getConnection } = require('./solana/connection');
    getConnection();

    // Start deposit detection polling
    const depositService = require('./services/depositService');
    depositService.startPolling();

    // Start periodic balance reconciliation
    const reconciliationService = require('./services/reconciliationService');
    reconciliationService.startReconciliation();

    // Start escrow health monitoring
    const healthService = require('./services/healthService');
    healthService.startHealthChecks(client);

    // Schedule daily health summary (every 24h)
    setInterval(() => {
      healthService.postDailySummary(client).catch(err => {
        console.error('[Health] Failed to post daily summary:', err.message);
      });
    }, 24 * 60 * 60 * 1000);

    // Load the bot's last-set display language so all shared panels post
    // in that language on startup. Defaults to 'en' if never changed.
    const { getBotDisplayLanguage } = require('./utils/languageRefresh');
    const displayLang = getBotDisplayLanguage();
    console.log(`[Boot] Bot display language: ${displayLang}`);

    // Post panels in their channels
    const { postWelcomePanel } = require('./panels/welcomePanel');
    await postWelcomePanel(client, displayLang);

    const { postLobbyPanel } = require('./panels/lobbyPanel');
    await postLobbyPanel(client, displayLang);

    const { postPublicWalletPanel } = require('./panels/publicWalletPanel');
    await postPublicWalletPanel(client, displayLang);

    const { postXpMatchPanel } = require('./panels/xpMatchPanel');
    await postXpMatchPanel(client, displayLang);

    const leaderboardPanel = require('./panels/leaderboardPanel');
    await leaderboardPanel.postAllLeaderboardPanels(client, displayLang);

    const { postSeasonPanel } = require('./panels/seasonPanel');
    await postSeasonPanel(client, displayLang);

    const { postEscrowPanel } = require('./panels/escrowPanel');
    await postEscrowPanel(client, displayLang);

    const { postRulesPanel } = require('./panels/rulesPanel');
    await postRulesPanel(client, displayLang);

    const { postHowItWorksPanel } = require('./panels/howItWorksPanel');
    await postHowItWorksPanel(client, displayLang);

    const { postLanguagePanel } = require('./panels/languagePanel');
    await postLanguagePanel(client, displayLang);

    console.log('[Boot] All systems ready');
  } catch (err) {
    console.error('[Boot] Startup error:', err);
    process.exit(1);
  }
});

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}, shutting down...`);

  try {
    const depositService = require('./services/depositService');
    depositService.stopPolling();
  } catch (err) {
    console.error('[Shutdown] Error stopping deposit polling:', err.message || err);
  }

  try {
    const reconciliationService = require('./services/reconciliationService');
    reconciliationService.stopReconciliation();
  } catch (err) {
    console.error('[Shutdown] Error stopping reconciliation:', err.message || err);
  }

  try {
    const healthService = require('./services/healthService');
    healthService.stopHealthChecks();
  } catch (err) {
    console.error('[Shutdown] Error stopping health checks:', err.message || err);
  }

  client.destroy();
  console.log('[Shutdown] Discord client destroyed');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Login
client.login(process.env.BOT_TOKEN);
