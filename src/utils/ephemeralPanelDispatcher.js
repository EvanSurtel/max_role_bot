// Ephemeral panel dispatcher.
//
// When a user changes their language from a channel, the bot can't
// modify the SHARED panel in that channel (Discord doesn't allow
// per-viewer rendering). Instead, this dispatcher detects which
// channel the user was in when they changed language, builds the
// equivalent panel content rendered in their NEW language, and sends
// it as one or more ephemeral follow-up messages — visible only to
// them, with the same functional buttons as the public panel.
//
// So when a user in the lobby changes language to Spanish, they get
// an ephemeral lobby in Spanish with the Create Wager / XP Match
// buttons functional. Same for welcome (TOS + Accept/Decline), rules,
// howItWorks, wallet, and the leaderboard channels.

const { ActionRowBuilder } = require('discord.js');

// Same chunking logic as the howItWorks/rules posting functions —
// stay under Discord's per-message limits.
const CHUNK_CHAR_CAP = 5500;
const CHUNK_EMBED_CAP = 10;

function _embedChars(embed) {
  const data = embed.data || embed;
  let chars = (data.title || '').length + (data.description || '').length;
  if (Array.isArray(data.fields)) {
    for (const f of data.fields) {
      chars += (f.name || '').length + (f.value || '').length;
    }
  }
  if (data.footer && data.footer.text) chars += data.footer.text.length;
  return chars;
}

function _packEmbeds(embeds) {
  const groups = [];
  let current = [];
  let chars = 0;
  for (const e of embeds) {
    const ec = _embedChars(e);
    if (current.length > 0 && (current.length >= CHUNK_EMBED_CAP || chars + ec > CHUNK_CHAR_CAP)) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(e);
    chars += ec;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Send an ephemeral version of the panel that lives in the given
 * channel, rendered in the user's NEW language. Uses interaction
 * follow-ups so this can be called after another reply has already
 * been sent.
 *
 * The dispatcher checks `interaction.channel.id` against every known
 * panel-hosting env var and dispatches to the matching panel builder.
 * If the channel doesn't host a known panel, nothing is sent (the
 * earlier confirmation message is enough).
 *
 * @param {import('discord.js').Interaction} interaction - the language picker interaction
 * @param {string} newLang - the language the user just picked
 */
async function sendEphemeralPanelForCurrentChannel(interaction, newLang) {
  const channelId = interaction.channel?.id;
  if (!channelId) return;

  try {
    // Welcome channel → TOS + Accept/Decline buttons
    if (channelId === process.env.WELCOME_CHANNEL_ID) {
      const { buildWelcomePanel } = require('../panels/welcomePanel');
      const view = buildWelcomePanel(newLang);
      return _sendPersistentFollowUp(interaction, view);
    }

    // Lobby (wager channel) → Create Wager / Create Dispute / Language buttons
    if (channelId === process.env.WAGER_CHANNEL_ID) {
      const { buildLobbyPanel } = require('../panels/lobbyPanel');
      return _sendPersistentFollowUp(interaction, buildLobbyPanel(newLang));
    }

    // XP match channel → Create XP Match button
    if (channelId === process.env.XP_MATCH_CHANNEL_ID) {
      const { buildXpMatchPanel } = require('../panels/xpMatchPanel');
      return _sendPersistentFollowUp(interaction, buildXpMatchPanel(newLang));
    }

    // Public wallet channel → View My Wallet button
    if (channelId === process.env.WALLET_CHANNEL_ID) {
      const { buildPublicWalletPanel } = require('../panels/publicWalletPanel');
      return _sendPersistentFollowUp(interaction, buildPublicWalletPanel(newLang));
    }

    // Rules channel → multi-message ephemeral with all rules embeds
    if (channelId === process.env.RULES_CHANNEL_ID) {
      const { buildRulesEmbeds } = require('../panels/rulesPanel');
      const embeds = buildRulesEmbeds(newLang);
      return _sendPackedEphemeral(interaction, embeds);
    }

    // How It Works channel → multi-message ephemeral
    if (channelId === process.env.HOW_IT_WORKS_CHANNEL_ID) {
      const { buildHowItWorksEmbeds } = require('../panels/howItWorksPanel');
      const embeds = buildHowItWorksEmbeds(newLang);
      return _sendPackedEphemeral(interaction, embeds);
    }

    // XP leaderboard channel → ephemeral leaderboard in their language
    if (channelId === process.env.XP_LEADERBOARD_CHANNEL_ID) {
      const { buildXpPanel } = require('../panels/leaderboardPanel');
      const view = await buildXpPanel('global', 'season', null, newLang);
      return _sendPersistentFollowUp(interaction, view);
    }

    // Earnings leaderboard channel → ephemeral leaderboard
    if (channelId === process.env.EARNINGS_LEADERBOARD_CHANNEL_ID) {
      const { buildEarningsPanel } = require('../panels/leaderboardPanel');
      const view = await buildEarningsPanel('global', newLang);
      return _sendPersistentFollowUp(interaction, view);
    }

    // Dedicated language channel → ephemeral language picker re-rendered
    // (the user already picked, so just show a confirmation — handled by
    // the caller via the original interaction.reply)
    if (channelId === process.env.LANGUAGE_CHANNEL_ID) {
      return; // No follow-up needed; caller already replied with confirmation
    }
  } catch (err) {
    console.error('[EphPanel] Failed to send ephemeral panel:', err.message);
  }
}

async function _sendPersistentFollowUp(interaction, view) {
  return interaction.followUp({
    ...view,
    ephemeral: true,
    _persist: true,
  });
}

/**
 * Send a multi-message ephemeral by packing embeds into Discord-safe
 * chunks. Each chunk is its own follow-up. Works for rules and
 * howItWorks panels which have many embeds.
 */
async function _sendPackedEphemeral(interaction, embeds) {
  const groups = _packEmbeds(embeds);
  for (let i = 0; i < groups.length; i++) {
    await interaction.followUp({
      embeds: groups[i],
      ephemeral: true,
      _persist: true,
    });
  }
}

module.exports = { sendEphemeralPanelForCurrentChannel };
