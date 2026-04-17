const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { t } = require('../locales/i18n');
const { buildLanguageDropdownRow } = require('../utils/languageButtonHelper');
const neatqueueService = require('../services/neatqueueService');

// ─── Stat type definitions ──────────────────────────────────────
const STAT_TYPES = [
  { value: 'mmr',         label: 'MMR',         field: 'mmr',         format: (v) => v.toLocaleString() },
  { value: 'peak_mmr',    label: 'Peak MMR',    field: 'peak_mmr',    format: (v) => v.toLocaleString() },
  { value: 'games',       label: 'Games',        field: 'games',       format: (v) => v.toLocaleString() },
  { value: 'wins',        label: 'Wins',         field: 'wins',        format: (v) => v.toLocaleString() },
  { value: 'losses',      label: 'Losses',       field: 'losses',      format: (v) => v.toLocaleString() },
  { value: 'winrate',     label: 'Winrate',      field: null,          format: (w, g) => g > 0 ? `${((w / g) * 100).toFixed(1)}%` : '0.0%' },
  { value: 'streak',      label: 'Streak',       field: 'streak',      format: (v) => v.toLocaleString() },
  { value: 'peak_streak', label: 'Peak Streak',  field: 'peak_streak', format: (v) => v.toLocaleString() },
  { value: 'points',      label: 'Points',       field: 'points',      format: (v) => v >= 1000 ? `${(v / 1000).toFixed(2)}K` : v.toLocaleString() },
];

const PER_PAGE = 10;

// ─── Simple LRU cache to avoid hammering NeatQueue on rapid clicks ──
// Keyed by "stat:page", holds { data, fetchedAt }. 30s TTL.
const _cache = new Map();
const CACHE_TTL_MS = 30_000;

function _cacheKey(stat, page) {
  return `${stat}:${page}`;
}

function _getCached(stat, page) {
  const key = _cacheKey(stat, page);
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function _setCache(stat, page, data) {
  const key = _cacheKey(stat, page);
  _cache.set(key, { data, fetchedAt: Date.now() });
  // Evict old entries if cache grows too large
  if (_cache.size > 100) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

// ─── Fetch + normalize leaderboard data ─────────────────────────

/**
 * Fetch a page of leaderboard data from NeatQueue and normalize it
 * into a consistent array of entry objects.
 *
 * Returns { entries: [...], totalCount, totalPages } or null on error.
 */
async function fetchLeaderboardPage(stat, page) {
  const cached = _getCached(stat, page);
  if (cached) return cached;

  // For most stats we request ALL fields we might need — the API
  // returns whichever it recognises. We always need wins/games for
  // the W-L record and for computing winrate.
  const fields = 'user_id,name,mmr,peak_mmr,games,wins,losses,streak,peak_streak,points';

  const raw = await neatqueueService.getLeaderboardV2({
    page,
    pageSize: PER_PAGE,
    includeFields: fields,
  });

  if (!raw) return null;

  // NeatQueue's v2 response may be shaped as:
  //   { leaderboard: [...], total: N }
  //   { data: [...], total: N }
  //   [...] (plain array — total unknown)
  let entries = [];
  let totalCount = 0;

  if (Array.isArray(raw)) {
    entries = raw;
    totalCount = raw.length;
  } else if (raw.leaderboard && Array.isArray(raw.leaderboard)) {
    entries = raw.leaderboard;
    totalCount = raw.total ?? raw.total_count ?? raw.count ?? entries.length;
  } else if (raw.data && Array.isArray(raw.data)) {
    entries = raw.data;
    totalCount = raw.total ?? raw.total_count ?? raw.count ?? entries.length;
  } else if (raw.players && Array.isArray(raw.players)) {
    entries = raw.players;
    totalCount = raw.total ?? raw.total_count ?? raw.count ?? entries.length;
  } else if (raw.entries && Array.isArray(raw.entries)) {
    entries = raw.entries;
    totalCount = raw.total ?? raw.total_count ?? raw.count ?? entries.length;
  }

  // Normalise each entry to consistent field names
  entries = entries.map(e => ({
    user_id:     String(e.user_id || e.userId || e.id || e.discord_id || e.discordId || ''),
    name:        e.name || e.username || e.display_name || e.displayName || 'Unknown',
    mmr:         Number(e.mmr ?? e.elo ?? e.rating ?? 0),
    peak_mmr:    Number(e.peak_mmr ?? e.peakMmr ?? e.peak_elo ?? e.peak_rating ?? e.mmr ?? 0),
    games:       Number(e.games ?? e.total_games ?? e.matches ?? 0),
    wins:        Number(e.wins ?? 0),
    losses:      Number(e.losses ?? 0),
    streak:      Number(e.streak ?? e.win_streak ?? 0),
    peak_streak: Number(e.peak_streak ?? e.peakStreak ?? e.best_streak ?? e.peak_win_streak ?? 0),
    points:      Number(e.points ?? e.score ?? e.xp ?? 0),
  }));

  // Client-side sort for computed stats (winrate) and for stat views
  // where the API doesn't guarantee ordering by that specific field.
  const statDef = STAT_TYPES.find(s => s.value === stat);
  if (statDef) {
    if (stat === 'winrate') {
      entries.sort((a, b) => {
        const wrA = a.games > 0 ? a.wins / a.games : 0;
        const wrB = b.games > 0 ? b.wins / b.games : 0;
        return wrB - wrA;
      });
    } else if (statDef.field) {
      entries.sort((a, b) => (b[statDef.field] ?? 0) - (a[statDef.field] ?? 0));
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PER_PAGE));
  const result = { entries, totalCount, totalPages };
  _setCache(stat, page, result);
  return result;
}

// ─── Embed builder ──────────────────────────────────────────────

const rankEmoji = (i) => i === 0 ? '\u{1F947}' : i === 1 ? '\u{1F948}' : i === 2 ? '\u{1F949}' : `**${i + 1}.**`;

function buildLeaderboardEmbed(stat, entries, page, totalPages, lang) {
  const statDef = STAT_TYPES.find(s => s.value === stat) || STAT_TYPES[0];
  const offset = (page - 1) * PER_PAGE;
  const title = t('queue_stats.title', lang, { stat: statDef.label });

  let lines;
  if (entries.length === 0) {
    lines = [t('queue_stats.no_data', lang)];
  } else {
    lines = entries.map((e, i) => {
      const pos = offset + i;
      const medal = rankEmoji(pos);

      let statValue;
      if (stat === 'winrate') {
        statValue = statDef.format(e.wins, e.games);
      } else if (stat === 'mmr') {
        // MMR view shows (MMR) (W-L) like NeatQueue
        statValue = `(${statDef.format(e.mmr)}) (${e.wins}-${e.losses})`;
      } else {
        const rawVal = statDef.field ? (e[statDef.field] ?? 0) : 0;
        statValue = statDef.format(rawVal);
      }

      const mention = e.user_id ? `<@${e.user_id}>` : `**${e.name}**`;
      return `${medal} ${mention} — ${statValue}`;
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setColor(0xf1c40f)
    .setFooter({ text: `${t('queue_stats.footer_page', lang, { page, totalPages })} | ${t('queue_stats.footer_source', lang)}` })
    .setTimestamp();

  return embed;
}

// ─── Component builders ─────────────────────────────────────────

function buildComponents(stat, page, totalPages, lang) {
  // Row 1: Stat type dropdown
  const statMenu = new StringSelectMenuBuilder()
    .setCustomId('qs_stat')
    .setPlaceholder(t('queue_stats.select_stat', lang))
    .addOptions(STAT_TYPES.map(s => ({
      label: s.label,
      value: s.value,
      default: s.value === stat,
    })));
  const row1 = new ActionRowBuilder().addComponents(statMenu);

  // Row 2: Navigation buttons (<<, <, Refresh, >, >>)
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`qs_first_${stat}_${page}`)
      .setLabel('\u{AB}')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`qs_prev_${stat}_${page}`)
      .setLabel('\u{25C0}')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`qs_refresh_${stat}_${page}`)
      .setLabel('\u{1F504}')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`qs_next_${stat}_${page}`)
      .setLabel('\u{25B6}')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(`qs_last_${stat}_${page}`)
      .setLabel('\u{BB}')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
  );

  // Row 3+4: Language dropdown (returns 2 rows)
  return [row1, row2, ...buildLanguageDropdownRow(lang)];
}

// ─── Build the full panel payload ───────────────────────────────

function buildUnavailablePayload(lang) {
  const embed = new EmbedBuilder()
    .setTitle(t('queue_stats.unavailable_title', lang))
    .setDescription(t('queue_stats.unavailable_desc', lang))
    .setColor(0xed4245)
    .setTimestamp();

  return { embeds: [embed], components: [...buildLanguageDropdownRow(lang)] };
}

async function buildQueueStatsPayload(stat = 'mmr', page = 1, lang = 'en') {
  const result = await fetchLeaderboardPage(stat, page);
  if (!result) return buildUnavailablePayload(lang);

  const { entries, totalPages } = result;
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const embed = buildLeaderboardEmbed(stat, entries, clampedPage, totalPages, lang);
  const components = buildComponents(stat, clampedPage, totalPages, lang);

  return { embeds: [embed], components };
}

// ─── Panel posting (startup) ────────────────────────────────────

async function postQueueStatsPanel(client, lang = 'en') {
  const channelId = process.env.QUEUE_STATS_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] QUEUE_STATS_CHANNEL_ID not set — skipping queue stats panel');
    return;
  }

  try {
    const ch = client.channels.cache.get(channelId);
    if (!ch) {
      console.warn(`[Panel] Queue stats channel ${channelId} not found in cache`);
      return;
    }

    // Clear old bot messages
    const messages = await ch.messages.fetch({ limit: 20 });
    for (const [, m] of messages) {
      if (m.author.id === client.user.id) {
        try { await m.delete(); } catch { /* */ }
      }
    }

    const payload = await buildQueueStatsPayload('mmr', 1, lang);
    await ch.send(payload);
    console.log(`[Panel] Posted queue stats panel (${lang})`);
  } catch (err) {
    console.error('[Panel] Queue stats panel failed:', err.message);
  }
}

// ─── Interaction handlers ───────────────────────────────────────

/**
 * Handle the stat type dropdown change.
 */
async function handleQueueStatsSelect(interaction) {
  const { getBotDisplayLanguage } = require('../utils/languageRefresh');
  const lang = getBotDisplayLanguage();
  const selected = interaction.values[0];

  const payload = await buildQueueStatsPayload(selected, 1, lang);
  return interaction.update(payload);
}

/**
 * Parse stat + page from a navigation/refresh button customId.
 * Format: qs_{action}_{stat}_{currentPage}
 */
function _parseNavId(customId) {
  const parts = customId.split('_');
  // qs_prev_mmr_1 → ['qs', 'prev', 'mmr', '1']
  // qs_refresh_peak_mmr_2 → ['qs', 'refresh', 'peak', 'mmr', '2']
  // qs_first_peak_streak_3 → ['qs', 'first', 'peak', 'streak', '3']
  const action = parts[1]; // prev, next, first, last, refresh
  const currentPage = parseInt(parts[parts.length - 1], 10) || 1;
  // stat is everything between action and page
  const stat = parts.slice(2, parts.length - 1).join('_');
  return { action, stat, currentPage };
}

/**
 * Handle navigation button clicks (<<, <, >, >>, refresh).
 */
async function handleQueueStatsNav(interaction) {
  const { getBotDisplayLanguage } = require('../utils/languageRefresh');
  const lang = getBotDisplayLanguage();
  const { action, stat, currentPage } = _parseNavId(interaction.customId);

  let newPage;
  if (action === 'first') {
    newPage = 1;
  } else if (action === 'prev') {
    newPage = Math.max(1, currentPage - 1);
  } else if (action === 'next') {
    newPage = currentPage + 1;
  } else if (action === 'last') {
    // Fetch to discover totalPages, then go to it
    const peek = await fetchLeaderboardPage(stat, currentPage);
    newPage = peek ? peek.totalPages : currentPage;
  } else {
    // refresh
    newPage = currentPage;
  }

  // For refresh, bust the cache so we get fresh data
  if (action === 'refresh') {
    const key = _cacheKey(stat, newPage);
    _cache.delete(key);
  }

  const payload = await buildQueueStatsPayload(stat, newPage, lang);
  return interaction.update(payload);
}

module.exports = {
  postQueueStatsPanel,
  handleQueueStatsSelect,
  handleQueueStatsNav,
};
