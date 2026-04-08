// Language refresh utility — when a user picks a new language from the welcome
// panel or the dedicated language channel, this updates ALL visible bot panels
// so the user immediately sees the change without having to manually refresh.
//
// Some panels are PRIVATE (wallet channel) and only the affected user sees them.
// Other panels are SHARED (lobby, xpMatch, rules, howItWorks, welcome) — updating
// these means everyone in those channels sees the new language. The user has
// accepted this trade-off (Discord can't show different content per-viewer in
// one message).

const walletRepo = require('../database/repositories/walletRepo');
const userRepo = require('../database/repositories/userRepo');
const walletManager = require('../solana/walletManager');

/**
 * Find the most-recent bot panel message in a channel and edit it with new content.
 * Returns true if a panel was found and updated.
 */
async function _updatePanelInChannel(client, channelId, payload) {
  if (!channelId) return false;
  try {
    const channel = client.channels.cache.get(channelId);
    if (!channel) return false;
    const messages = await channel.messages.fetch({ limit: 20 });
    const botMessage = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0);
    if (!botMessage) return false;
    await botMessage.edit(payload);
    return true;
  } catch (err) {
    console.error(`[LangRefresh] Failed to update panel in ${channelId}:`, err.message);
    return false;
  }
}

/**
 * Update the user's PRIVATE wallet channel embed to reflect their new language.
 * This only affects the user — wallet channels are private per-user.
 */
async function refreshWalletForUser(client, discordId) {
  try {
    const user = userRepo.findByDiscordId(discordId);
    if (!user || !user.wallet_channel_id) return;

    const wallet = walletRepo.findByUserId(user.id);
    if (!wallet) return;

    const lang = user.language || 'en';
    const { buildWalletView } = require('../panels/walletPanelView');

    let solBalance = '0';
    try { solBalance = await walletManager.getSolBalance(wallet.solana_address); } catch { /* */ }

    const view = buildWalletView(wallet, user, lang, solBalance);
    await _updatePanelInChannel(client, user.wallet_channel_id, view);
  } catch (err) {
    console.error(`[LangRefresh] Failed to refresh wallet for ${discordId}:`, err.message);
  }
}

/**
 * Update ALL shared bot panels to the given language. These are shared channels —
 * everyone sees the language change. Includes:
 *  - Lobby panel (single message, edit in place)
 *  - XP match panel (single message, edit in place)
 *  - Welcome panel (2 messages, delete + repost)
 *  - Rules panel (1-2 messages, delete + repost)
 *  - How It Works panel (1-3 messages depending on language, delete + repost)
 *  - Language panel (single message, edit in place — but this should already
 *    be updated by the panel's own click handler)
 */
async function refreshSharedPanels(client, lang) {
  // Run all the small in-place edits first (fast, no flicker)
  try {
    const { buildLobbyPanel } = require('../panels/lobbyPanel');
    const { buildXpMatchPanel } = require('../panels/xpMatchPanel');

    if (process.env.WAGER_CHANNEL_ID) {
      await _updatePanelInChannel(client, process.env.WAGER_CHANNEL_ID, buildLobbyPanel(lang));
    }
    if (process.env.XP_MATCH_CHANNEL_ID) {
      await _updatePanelInChannel(client, process.env.XP_MATCH_CHANNEL_ID, buildXpMatchPanel(lang));
    }
  } catch (err) {
    console.error('[LangRefresh] Failed to refresh small shared panels:', err.message);
  }

  // Then the multi-message panels (delete + repost — brief flicker)
  try {
    const { postWelcomePanel } = require('../panels/welcomePanel');
    const { postRulesPanel } = require('../panels/rulesPanel');
    const { postHowItWorksPanel } = require('../panels/howItWorksPanel');

    // Run these in parallel since they target different channels
    await Promise.all([
      postWelcomePanel(client, lang).catch(e => console.error('[LangRefresh] welcome:', e.message)),
      postRulesPanel(client, lang).catch(e => console.error('[LangRefresh] rules:', e.message)),
      postHowItWorksPanel(client, lang).catch(e => console.error('[LangRefresh] howItWorks:', e.message)),
    ]);
  } catch (err) {
    console.error('[LangRefresh] Failed to refresh multi-message panels:', err.message);
  }
}

/**
 * Apply a language change everywhere — call this from the welcome master
 * switch handler and the dedicated language channel handler.
 *
 * Updates:
 *  - The user's private wallet channel (their language)
 *  - The shared lobby panel
 *  - The shared XP match panel
 *  - The shared welcome panel (re-posted in new language)
 *  - The shared rules panel (re-posted in new language)
 *  - The shared How It Works panel (re-posted in new language)
 */
async function applyLanguageChange(client, discordId, newLang) {
  // Run wallet + shared panel updates in parallel
  await Promise.all([
    refreshWalletForUser(client, discordId),
    refreshSharedPanels(client, newLang),
  ]);
}

module.exports = { applyLanguageChange, refreshWalletForUser, refreshSharedPanels };
