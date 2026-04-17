const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { t } = require('../locales/i18n');
const { buildLanguageDropdownRow } = require('../utils/languageButtonHelper');

// ─── Stat type definitions ──────────────────────────────────────
const STAT_TYPES = [
  { value: 'season_xp',  label: 'Season XP',          sortField: 'season_xp',  format: (v) => v.toLocaleString() },
  { value: 'alltime_xp', label: 'All-Time XP',        sortField: 'xp_points',  format: (v) => v.toLocaleString() },
  { value: 'earnings',   label: 'Earnings ($)',        sortField: 'earnings',   format: (v) => `$${(v / 1_000_000).toFixed(2)}` },
  { value: 'wagered',    label: 'Amount Wagered ($)',  sortField: 'entered',    format: (v) => `$${(v / 1_000_000).toFixed(2)}` },
  { value: 'wins',       label: 'Wins',               sortField: 'total_wins', format: (v) => v.toLocaleString() },
  { value: 'losses',     label: 'Losses',             sortField: 'total_losses', format: (v) => v.toLocaleString() },
  { value: 'games',      label: 'Games',              sortField: 'games',      format: (v) => v.toLocaleString() },
  { value: 'winrate',    label: 'Winrate',            sortField: 'winrate',    format: (v) => `${v.toFixed(1)}%` },
];

const PER_PAGE = 10;

// ─── Simple LRU cache to avoid hammering DB on rapid clicks ─────
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

// ─── Fetch leaderboard data from local DB ───────────────────────

/**
 * Fetch a page of wager leaderboard data from the local SQLite DB.
 *
 * Returns { entries: [...], totalCount, totalPages } or null on error.
 */
function fetchLeaderboardPage(stat, page) {
  const cached = _getCached(stat, page);
  if (cached) return cached;

  const db = require('../database/db');
  const offset = (page - 1) * PER_PAGE;
  let entries = [];
  let totalCount = 0;

  try {
    if (stat === 'season_xp') {
      const { getCurrentSeason } = require('./leaderboardPanel');
      const season = getCurrentSeason();

      totalCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM (
          SELECT u.id, COALESCE(SUM(xh.xp_amount), 0) as season_xp
          FROM users u LEFT JOIN xp_history xh ON xh.user_id = u.id AND xh.season = ?
          WHERE u.accepted_tos = 1
          GROUP BY u.id HAVING season_xp > 0
        )
      `).get(season).cnt;

      const rows = db.prepare(`
        SELECT u.discord_id, u.server_username, u.cod_ign,
               u.total_wins, u.total_losses,
               COALESCE(SUM(xh.xp_amount), 0) as season_xp
        FROM users u LEFT JOIN xp_history xh ON xh.user_id = u.id AND xh.season = ?
        WHERE u.accepted_tos = 1
        GROUP BY u.id HAVING season_xp > 0
        ORDER BY season_xp DESC LIMIT ? OFFSET ?
      `).all(season, PER_PAGE, offset);

      entries = rows.map(r => ({
        discord_id: r.discord_id,
        name: r.server_username || r.cod_ign || 'Unknown',
        total_wins: r.total_wins,
        total_losses: r.total_losses,
        stat_value: r.season_xp,
      }));

    } else if (stat === 'alltime_xp') {
      totalCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM users WHERE accepted_tos = 1 AND xp_points > 0`
      ).get().cnt;

      const rows = db.prepare(
        `SELECT discord_id, server_username, cod_ign, total_wins, total_losses, xp_points
         FROM users WHERE accepted_tos = 1 AND xp_points > 0
         ORDER BY xp_points DESC LIMIT ? OFFSET ?`
      ).all(PER_PAGE, offset);

      entries = rows.map(r => ({
        discord_id: r.discord_id,
        name: r.server_username || r.cod_ign || 'Unknown',
        total_wins: r.total_wins,
        total_losses: r.total_losses,
        stat_value: r.xp_points,
      }));

    } else if (stat === 'earnings') {
      totalCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM users WHERE accepted_tos = 1 AND CAST(total_earnings_usdc AS INTEGER) > 0`
      ).get().cnt;

      const rows = db.prepare(
        `SELECT discord_id, server_username, cod_ign, total_wins, total_losses,
                CAST(total_earnings_usdc AS INTEGER) as earnings
         FROM users WHERE accepted_tos = 1 AND CAST(total_earnings_usdc AS INTEGER) > 0
         ORDER BY CAST(total_earnings_usdc AS INTEGER) DESC LIMIT ? OFFSET ?`
      ).all(PER_PAGE, offset);

      entries = rows.map(r => ({
        discord_id: r.discord_id,
        name: r.server_username || r.cod_ign || 'Unknown',
        total_wins: r.total_wins,
        total_losses: r.total_losses,
        stat_value: r.earnings,
      }));

    } else if (stat === 'wagered') {
      totalCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM users WHERE accepted_tos = 1 AND CAST(total_entered_usdc AS INTEGER) > 0`
      ).get().cnt;

      const rows = db.prepare(
        `SELECT discord_id, server_username, cod_ign, total_wins, total_losses,
                CAST(total_entered_usdc AS INTEGER) as entered
         FROM users WHERE accepted_tos = 1 AND CAST(total_entered_usdc AS INTEGER) > 0
         ORDER BY CAST(total_entered_usdc AS INTEGER) DESC LIMIT ? OFFSET ?`
      ).all(PER_PAGE, offset);

      entries = rows.map(r => ({
        discord_id: r.discord_id,
        name: r.server_username || r.cod_ign || 'Unknown',
        total_wins: r.total_wins,
        total_losses: r.total_losses,
        stat_value: r.entered,
      }));

    } else if (stat === 'wins') {
      totalCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM users WHERE accepted_tos = 1 AND total_wins > 0`
      ).get().cnt;

      const rows = db.prepare(
        `SELECT discord_id, server_username, cod_ign, total_wins, total_losses
         FROM users WHERE accepted_tos = 1 AND total_wins > 0
         ORDER BY total_wins DESC LIMIT ? OFFSET ?`
      ).all(PER_PAGE, offset);

      entries = rows.map(r => ({
        discord_id: r.discord_id,
        name: r.server_username || r.cod_ign || 'Unknown',
        total_wins: r.total_wins,
        total_losses: r.total_losses,
        stat_value: r.total_wins,
      }));

    } else if (stat === 'losses') {
      totalCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM users WHERE accepted_tos = 1 AND total_losses > 0`
      ).get().cnt;

      const rows = db.prepare(
        `SELECT discord_id, server_username, cod_ign, total_wins, total_losses
         FROM users WHERE accepted_tos = 1 AND total_losses > 0
         ORDER BY total_losses DESC LIMIT ? OFFSET ?`
      ).all(PER_PAGE, offset);

      entries = rows.map(r => ({
        discord_id: r.discord_id,
        name: r.server_username || r.cod_ign || 'Unknown',
        total_wins: r.total_wins,
        total_losses: r.total_losses,
        stat_value: r.total_losses,
      }));

    } else if (stat === 'games') {
      totalCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM users WHERE accepted_tos = 1 AND (total_wins + total_losses) > 0`
      ).get().cnt;

      const rows = db.prepare(
        `SELECT discord_id, server_username, cod_ign, total_wins, total_losses,
                (total_wins + total_losses) as games
         FROM users WHERE accepted_tos = 1 AND (total_wins + total_losses) > 0
         ORDER BY games DESC LIMIT ? OFFSET ?`
      ).all(PER_PAGE, offset);

      entries = rows.map(r => ({
        discord_id: r.discord_id,
        name: r.server_username || r.cod_ign || 'Unknown',
        total_wins: r.total_wins,
        total_losses: r.total_losses,
        stat_value: r.games,
      }));

    } else if (stat === 'winrate') {
      // Filter to players with at least 5 games to avoid inflated winrates
      totalCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM users WHERE accepted_tos = 1 AND (total_wins + total_losses) >= 5`
      ).get().cnt;

      const rows = db.prepare(
        `SELECT discord_id, server_username, cod_ign, total_wins, total_losses,
                CAST(total_wins AS REAL) / (total_wins + total_losses) * 100.0 as winrate
         FROM users WHERE accepted_tos = 1 AND (total_wins + total_losses) >= 5
         ORDER BY winrate DESC LIMIT ? OFFSET ?`
      ).all(PER_PAGE, offset);

      entries = rows.map(r => ({
        discord_id: r.discord_id,
        name: r.server_username || r.cod_ign || 'Unknown',
        total_wins: r.total_wins,
        total_losses: r.total_losses,
        stat_value: r.winrate,
      }));
    }
  } catch (err) {
    console.error(`[WagerStats] DB query failed for stat=${stat} page=${page}:`, err.message);
    return null;
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
  const title = t('wager_stats.title', lang, { stat: statDef.label });

  let lines;
  if (entries.length === 0) {
    lines = [t('wager_stats.no_data', lang)];
  } else {
    lines = entries.map((e, i) => {
      const pos = offset + i;
      const medal = rankEmoji(pos);
      const mention = e.discord_id ? `<@${e.discord_id}>` : `**${e.name}**`;
      const record = `(${e.total_wins}W-${e.total_losses}L)`;

      let statDisplay;
      if (stat === 'season_xp' || stat === 'alltime_xp') {
        statDisplay = `**${statDef.format(e.stat_value)} XP** ${record}`;
      } else if (stat === 'earnings' || stat === 'wagered') {
        statDisplay = `**${statDef.format(e.stat_value)}** earned ${record}`;
      } else if (stat === 'winrate') {
        statDisplay = `**${statDef.format(e.stat_value)}** ${record}`;
      } else {
        statDisplay = `**${statDef.format(e.stat_value)}** ${record}`;
      }

      return `${medal} ${mention} — ${statDisplay}`;
    });
  }

  // Add season label for season_xp view
  let description = lines.join('\n');
  if (stat === 'season_xp') {
    const { getCurrentSeason } = require('./leaderboardPanel');
    const season = getCurrentSeason();
    description = `${t('wager_stats.season_label', lang, { season })}\n\n${description}`;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(0xf1c40f)
    .setFooter({ text: `${t('wager_stats.footer_page', lang, { page, total: totalPages })} | ${t('wager_stats.footer_source', lang)}` })
    .setTimestamp();

  return embed;
}

// ─── Component builders ─────────────────────────────────────────

function buildComponents(stat, page, totalPages, lang) {
  // Row 1: Stat type dropdown
  const statMenu = new StringSelectMenuBuilder()
    .setCustomId('ws_stat')
    .setPlaceholder(t('wager_stats.select_stat', lang))
    .addOptions(STAT_TYPES.map(s => ({
      label: s.label,
      value: s.value,
      default: s.value === stat,
    })));
  const row1 = new ActionRowBuilder().addComponents(statMenu);

  // Row 2: Navigation buttons (<<, <, Refresh, >, >>)
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ws_first_${stat}_${page}`)
      .setLabel('\u{AB}')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`ws_prev_${stat}_${page}`)
      .setLabel('\u{25C0}')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(`ws_refresh_${stat}_${page}`)
      .setLabel('\u{1F504}')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`ws_next_${stat}_${page}`)
      .setLabel('\u{25B6}')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
    new ButtonBuilder()
      .setCustomId(`ws_last_${stat}_${page}`)
      .setLabel('\u{BB}')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
  );

  // Row 3+4: Language dropdown (returns 2 rows)
  return [row1, row2, ...buildLanguageDropdownRow(lang)];
}

// ─── Build the full panel payload ───────────────────────────────

function buildWagerStatsPayload(stat = 'season_xp', page = 1, lang = 'en') {
  const result = fetchLeaderboardPage(stat, page);
  if (!result) {
    // DB error fallback
    const embed = new EmbedBuilder()
      .setTitle(t('wager_stats.title', lang, { stat: 'Wager Stats' }))
      .setDescription(t('wager_stats.no_data', lang))
      .setColor(0xed4245)
      .setTimestamp();
    return { embeds: [embed], components: [...buildLanguageDropdownRow(lang)] };
  }

  const { entries, totalPages } = result;
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const embed = buildLeaderboardEmbed(stat, entries, clampedPage, totalPages, lang);
  const components = buildComponents(stat, clampedPage, totalPages, lang);

  return { embeds: [embed], components };
}

// ─── Panel posting (startup) ────────────────────────────────────

async function postWagerStatsPanel(client, lang = 'en') {
  const channelId = process.env.WAGER_STATS_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] WAGER_STATS_CHANNEL_ID not set — skipping wager stats panel');
    return;
  }

  try {
    const ch = client.channels.cache.get(channelId);
    if (!ch) {
      console.warn(`[Panel] Wager stats channel ${channelId} not found in cache`);
      return;
    }

    // Clear old bot messages
    const messages = await ch.messages.fetch({ limit: 20 });
    for (const [, m] of messages) {
      if (m.author.id === client.user.id) {
        try { await m.delete(); } catch { /* */ }
      }
    }

    const payload = buildWagerStatsPayload('season_xp', 1, lang);
    await ch.send(payload);
    console.log(`[Panel] Posted wager stats panel (${lang})`);
  } catch (err) {
    console.error('[Panel] Wager stats panel failed:', err.message);
  }
}

// ─── Interaction handlers ───────────────────────────────────────

/**
 * Handle the stat type dropdown change.
 */
async function handleWagerStatsSelect(interaction) {
  const { getBotDisplayLanguage } = require('../utils/languageRefresh');
  const lang = getBotDisplayLanguage();
  const selected = interaction.values[0];

  const payload = buildWagerStatsPayload(selected, 1, lang);
  return interaction.update(payload);
}

/**
 * Parse stat + page from a navigation/refresh button customId.
 * Format: ws_{action}_{stat}_{currentPage}
 */
function _parseNavId(customId) {
  const parts = customId.split('_');
  // ws_prev_season_xp_1 → ['ws', 'prev', 'season', 'xp', '1']
  // ws_refresh_alltime_xp_2 → ['ws', 'refresh', 'alltime', 'xp', '2']
  // ws_first_earnings_3 → ['ws', 'first', 'earnings', '3']
  const action = parts[1]; // prev, next, first, last, refresh
  const currentPage = parseInt(parts[parts.length - 1], 10) || 1;
  // stat is everything between action and page
  const stat = parts.slice(2, parts.length - 1).join('_');
  return { action, stat, currentPage };
}

/**
 * Handle navigation button clicks (<<, <, >, >>, refresh).
 */
async function handleWagerStatsNav(interaction) {
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
    const peek = fetchLeaderboardPage(stat, currentPage);
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

  const payload = buildWagerStatsPayload(stat, newPage, lang);
  return interaction.update(payload);
}

module.exports = {
  postWagerStatsPanel,
  handleWagerStatsSelect,
  handleWagerStatsNav,
};
