// Shared helper for adding a "🌐 Language" button to any bot panel.
//
// Every public bot panel includes this button. Clicking it sends an
// ephemeral language picker in the clicker's current language. When they
// pick a new language, their preference is saved to the DB and they get
// an ephemeral confirmation in the new language.
//
// The interface ephemerals from THAT point on (wallet view, wager flow,
// etc.) will all be in the new language because they look up the user's
// saved language via langFor(interaction) at interaction time.

const { ButtonBuilder, ButtonStyle } = require('discord.js');
const { t } = require('../locales/i18n');

/**
 * Build a "🌐 Language" ButtonBuilder that any panel can add to its
 * action row. The customId is `show_language_picker` — see
 * src/interactions/languageSwitcher.js for the handler.
 *
 * @param {string} lang - the panel's display language, used for the button label
 */
function buildLanguageButton(lang = 'en') {
  return new ButtonBuilder()
    .setCustomId('show_language_picker')
    .setEmoji('🌐')
    .setLabel(t('common.btn_language', lang))
    .setStyle(ButtonStyle.Secondary);
}

module.exports = { buildLanguageButton };
