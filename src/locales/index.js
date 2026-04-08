const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');

// All languages supported by the bot. Add a new entry here to enable a new language.
// `nativeName` is shown in the UI so users can find their language easily.
const SUPPORTED_LANGUAGES = {
  en: { label: 'English',     nativeName: 'English',     emoji: '🇺🇸' },
  es: { label: 'Spanish',     nativeName: 'Español',     emoji: '🇪🇸' },
  pt: { label: 'Portuguese',  nativeName: 'Português',   emoji: '🇧🇷' },
  fr: { label: 'French',      nativeName: 'Français',    emoji: '🇫🇷' },
  de: { label: 'German',      nativeName: 'Deutsch',     emoji: '🇩🇪' },
  it: { label: 'Italian',     nativeName: 'Italiano',    emoji: '🇮🇹' },
  ru: { label: 'Russian',     nativeName: 'Русский',     emoji: '🇷🇺' },
  tr: { label: 'Turkish',     nativeName: 'Türkçe',      emoji: '🇹🇷' },
  ar: { label: 'Arabic',      nativeName: 'العربية',     emoji: '🇸🇦' },
  ja: { label: 'Japanese',    nativeName: '日本語',       emoji: '🇯🇵' },
  ko: { label: 'Korean',      nativeName: '한국어',       emoji: '🇰🇷' },
  zh: { label: 'Chinese',     nativeName: '中文',         emoji: '🇨🇳' },
  pl: { label: 'Polish',      nativeName: 'Polski',      emoji: '🇵🇱' },
  nl: { label: 'Dutch',       nativeName: 'Nederlands',  emoji: '🇳🇱' },
  id: { label: 'Indonesian',  nativeName: 'Indonesia',   emoji: '🇮🇩' },
  vi: { label: 'Vietnamese',  nativeName: 'Tiếng Việt',  emoji: '🇻🇳' },
  hi: { label: 'Hindi',       nativeName: 'हिन्दी',      emoji: '🇮🇳' },
  th: { label: 'Thai',        nativeName: 'ไทย',         emoji: '🇹🇭' },
  ms: { label: 'Malay',       nativeName: 'Melayu',      emoji: '🇲🇾' },
  fil: { label: 'Filipino',   nativeName: 'Filipino',    emoji: '🇵🇭' },
};

const DEFAULT_LANGUAGE = 'en';

// Resolve a panel locale file (rules / howItWorks). Falls back to English if missing.
function getLocale(panel, lang = DEFAULT_LANGUAGE) {
  if (!SUPPORTED_LANGUAGES[lang]) lang = DEFAULT_LANGUAGE;
  try {
    return require(`./${panel}/${lang}`);
  } catch {
    return require(`./${panel}/${DEFAULT_LANGUAGE}`);
  }
}

// Build a row of language buttons (used by panels with ≤5 supported langs).
function buildLanguageRow(panel) {
  return new ActionRowBuilder().addComponents(
    Object.entries(SUPPORTED_LANGUAGES).slice(0, 5).map(([code, { nativeName, emoji }]) =>
      new ButtonBuilder()
        .setCustomId(`lang_${panel}_${code}`)
        .setLabel(nativeName)
        .setEmoji(emoji)
        .setStyle(ButtonStyle.Secondary)
    )
  );
}

// Build a select menu for choosing a language. Used everywhere we have many languages.
// customIdPrefix lets the handler know what context to apply the language choice to.
function buildLanguageSelect(customIdPrefix, currentLang = DEFAULT_LANGUAGE) {
  const options = Object.entries(SUPPORTED_LANGUAGES).slice(0, 25).map(([code, { label, nativeName, emoji }]) => ({
    label: nativeName,
    description: label,
    value: code,
    emoji,
    default: code === currentLang,
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`langsel_${customIdPrefix}`)
      .setPlaceholder('🌐 Language / Idioma / Idioma')
      .addOptions(options)
  );
}

module.exports = {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  getLocale,
  buildLanguageRow,
  buildLanguageSelect,
};
