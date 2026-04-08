const { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } = require('./index');

// Lazy cache of loaded message bundles
const _bundleCache = new Map();

function _loadBundle(lang) {
  if (_bundleCache.has(lang)) return _bundleCache.get(lang);
  let bundle;
  try {
    bundle = require(`./messages/${lang}`);
  } catch {
    bundle = null;
  }
  _bundleCache.set(lang, bundle);
  return bundle;
}

// Resolve a dot-path key against a bundle (e.g. "wallet.title" → bundle.wallet.title)
function _lookup(bundle, key) {
  if (!bundle) return undefined;
  return key.split('.').reduce((obj, k) => (obj && typeof obj === 'object' ? obj[k] : undefined), bundle);
}

// Substitute {var} placeholders with values from `vars`
function _interpolate(str, vars) {
  if (typeof str !== 'string' || !vars) return str;
  return str.replace(/\{(\w+)\}/g, (_, name) => (vars[name] !== undefined ? String(vars[name]) : `{${name}}`));
}

/**
 * Translate a message key into the requested language.
 * Falls back to English, then to the key itself if not found.
 *
 * @param {string} key - dot-path like "wallet.title" or "tx_type.deposit"
 * @param {string} lang - language code (en, es, pt, ...). Defaults to English.
 * @param {object} vars - optional placeholder values to interpolate
 */
function t(key, lang = DEFAULT_LANGUAGE, vars = {}) {
  if (!SUPPORTED_LANGUAGES[lang]) lang = DEFAULT_LANGUAGE;

  // Try requested language
  const bundle = _loadBundle(lang);
  let value = _lookup(bundle, key);

  // Fallback to default language
  if (value === undefined && lang !== DEFAULT_LANGUAGE) {
    value = _lookup(_loadBundle(DEFAULT_LANGUAGE), key);
  }

  // Last resort: return the key so missing translations are visible
  if (value === undefined) return key;

  return _interpolate(value, vars);
}

/**
 * Get the language code stored for a Discord user. Falls back to:
 *   1) the user's saved DB preference
 *   2) the Discord interaction locale (if available)
 *   3) DEFAULT_LANGUAGE
 *
 * Pass either a Discord user ID string OR an interaction object.
 */
function getLang(discordIdOrInteraction) {
  if (!discordIdOrInteraction) return DEFAULT_LANGUAGE;

  // Interaction object: try DB, then interaction.locale
  if (typeof discordIdOrInteraction === 'object' && discordIdOrInteraction.user) {
    const interaction = discordIdOrInteraction;
    const discordId = interaction.user.id;
    const stored = _lookupUserLang(discordId);
    if (stored) return stored;

    // Map Discord locale (e.g. "en-US", "es-ES", "pt-BR") to a supported short code
    const dl = interaction.locale || '';
    const short = dl.toLowerCase().split('-')[0];
    if (SUPPORTED_LANGUAGES[short]) return short;
    return DEFAULT_LANGUAGE;
  }

  // Plain Discord ID
  return _lookupUserLang(discordIdOrInteraction) || DEFAULT_LANGUAGE;
}

function _lookupUserLang(discordId) {
  try {
    // Lazy require to avoid circular dependency
    const userRepo = require('../database/repositories/userRepo');
    const user = userRepo.findByDiscordId(discordId);
    return user && user.language && SUPPORTED_LANGUAGES[user.language] ? user.language : null;
  } catch {
    return null;
  }
}

// Convenience alias for clarity at call sites
const langFor = getLang;

module.exports = { t, getLang, langFor, DEFAULT_LANGUAGE };
