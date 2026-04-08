// Language refresh utility — when a user picks a new language from the welcome
// panel or the dedicated language channel, this updates ALL visible bot panels
// so the user immediately sees the change without having to manually refresh.
//
// Some panels are PRIVATE (wallet channel) and only the affected user sees them.
// Other panels are SHARED (lobby, xpMatch, welcome) — updating these means
// everyone in the channel sees the new language. The user has accepted this
// trade-off (Discord can't show different content per-viewer in one message).

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
 * Update the SHARED lobby + XP match panels to the given language.
 * These are shared channels — everyone sees the language change.
 */
async function refreshSharedPanels(client, lang) {
  try {
    const { buildLobbyPanel } = require('../panels/lobbyPanel');
    const { buildXpMatchPanel } = require('../panels/xpMatchPanel');

    // Lobby panel (wager channel)
    if (process.env.WAGER_CHANNEL_ID) {
      await _updatePanelInChannel(client, process.env.WAGER_CHANNEL_ID, buildLobbyPanel(lang));
    }

    // XP match panel
    if (process.env.XP_MATCH_CHANNEL_ID) {
      await _updatePanelInChannel(client, process.env.XP_MATCH_CHANNEL_ID, buildXpMatchPanel(lang));
    }
  } catch (err) {
    console.error('[LangRefresh] Failed to refresh shared panels:', err.message);
  }
}

/**
 * Apply a language change everywhere — call this from the welcome master
 * switch handler and the dedicated language channel handler.
 *
 * Updates:
 *  - The user's private wallet channel (their language)
 *  - The shared lobby panel (everyone sees the change)
 *  - The shared XP match panel (everyone sees the change)
 *
 * Does NOT update:
 *  - Welcome panel (already updated by the welcome handler in place)
 *  - Language panel (updated by its own handler in place)
 *  - Rules / How It Works panels (huge multi-message panels — too disruptive
 *    to refresh on every language change)
 */
async function applyLanguageChange(client, discordId, newLang) {
  // Run wallet + shared panel updates in parallel
  await Promise.all([
    refreshWalletForUser(client, discordId),
    refreshSharedPanels(client, newLang),
  ]);
}

module.exports = { applyLanguageChange, refreshWalletForUser, refreshSharedPanels };
