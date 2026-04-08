const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const SUPPORTED_LANGUAGES = {
  en: { label: 'English', emoji: '🇺🇸' },
  es: { label: 'Español', emoji: '🇪🇸' },
  pt: { label: 'Português', emoji: '🇧🇷' },
};

function getLocale(panel, lang = 'en') {
  if (!SUPPORTED_LANGUAGES[lang]) lang = 'en';
  return require(`./${panel}/${lang}`);
}

function buildLanguageRow(panel) {
  return new ActionRowBuilder().addComponents(
    Object.entries(SUPPORTED_LANGUAGES).map(([code, { label, emoji }]) =>
      new ButtonBuilder()
        .setCustomId(`lang_${panel}_${code}`)
        .setLabel(label)
        .setEmoji(emoji)
        .setStyle(ButtonStyle.Secondary)
    )
  );
}

module.exports = { SUPPORTED_LANGUAGES, getLocale, buildLanguageRow };
