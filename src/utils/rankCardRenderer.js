// Rank card PNG renderer.
//
// Produces a game-style rank card image — big emblem, prominent
// player name, stats row — rendered via @napi-rs/canvas and
// returned as a PNG buffer. Used by the /rank slash command, the
// "View Rank" context menu, and the /rank @user message command.
// All three paths call buildRankCard() which calls renderRankCard()
// here, so there's one place to iterate on the visual design.
//
// Layout (1100×440 px):
//
//   ┌────────────────────────────────────────────────────────┐
//   │                                                        │
//   │   ┌───────────┐    PLAYER NAME                         │
//   │   │           │    (ign subtitle)                      │
//   │   │  EMBLEM   │                                        │
//   │   │           │    TIER NAME (in tier color)           │
//   │   │           │    ────────────────────                │
//   │   └───────────┘    SEASON XP  │  RECORD  │  POSITION   │
//   │                      8,423    │  12W-5L  │    #4       │
//   │                                              RANK $    │
//   └────────────────────────────────────────────────────────┘
//
// The tier.color is used as a left-side accent gradient so Bronze
// cards feel different from Obsidian cards at a glance.

const path = require('path');
const fs = require('fs');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const EMBLEM_DIR = path.join(__dirname, '..', 'public', 'assets', 'emblems');

const WIDTH = 1100;
const HEIGHT = 440;

// ─── Font detection ─────────────────────────────────────────────
//
// @napi-rs/canvas doesn't ship with any bundled fonts — text only
// renders if the family we name in ctx.font matches a font that's
// already on the system. On macOS "Helvetica Neue" / "Arial" exist
// by default; on Ubuntu servers they usually don't, and canvas
// silently drops the text instead of throwing. That's why the first
// version of this card showed the emblem but no name.
//
// Fix: load system fonts at module require time, log what's there,
// and pick the first family from a known-good preference list.
// If NOTHING is available we log a loud warning with the exact apt
// command to install a font package, and text falls back to whatever
// canvas does by default (usually still nothing, but at least the
// operator knows why).
try {
  GlobalFonts.loadSystemFonts();
} catch (err) {
  console.warn('[RankCard] GlobalFonts.loadSystemFonts() failed:', err.message);
}

const _availableFamilies = (() => {
  try {
    return (GlobalFonts.families || []).map(f => f.family);
  } catch { return []; }
})();

const FONT_FAMILY = (() => {
  const prefs = [
    'DejaVu Sans',      // fonts-dejavu-core on Ubuntu (almost always present)
    'Liberation Sans',  // fonts-liberation
    'Noto Sans',        // fonts-noto-core
    'Ubuntu',           // fonts-ubuntu
    'Helvetica Neue',   // macOS dev
    'Arial',            // Windows / macOS
    'Helvetica',
  ];
  for (const name of prefs) {
    if (_availableFamilies.includes(name)) return name;
  }
  return 'sans-serif';
})();

if (_availableFamilies.length === 0) {
  console.warn('[RankCard] ⚠️  No system fonts detected. Rank card text will NOT render.');
  console.warn('[RankCard]    Fix on Ubuntu:  sudo apt install fonts-dejavu-core');
  console.warn('[RankCard]    Then restart the bot.');
} else {
  console.log(`[RankCard] ${_availableFamilies.length} font families available. Using "${FONT_FAMILY}".`);
}

function _hexFromTierColor(n) {
  return '#' + n.toString(16).padStart(6, '0');
}

function _darken(hex, amount) {
  // hex: '#rrggbb', amount: 0..1, returns darkened hex
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.floor(((n >> 16) & 0xff) * (1 - amount)));
  const g = Math.max(0, Math.floor(((n >> 8) & 0xff) * (1 - amount)));
  const b = Math.max(0, Math.floor((n & 0xff) * (1 - amount)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/**
 * Render the rank card as a PNG.
 *
 * @param {object} data
 * @param {string} data.displayName
 * @param {string} [data.ign]
 * @param {number} data.points
 * @param {number} data.wins
 * @param {number} data.losses
 * @param {number|null} data.position  - 1-based leaderboard position, null if unknown
 * @param {object} data.tier           - RANK_TIERS entry (needs .color and .emblem)
 * @param {string} data.rankName       - localized display name ("Obsidian")
 * @returns {Promise<Buffer>} PNG buffer
 */
async function renderRankCard(data) {
  const {
    displayName,
    ign,
    points,
    wins,
    losses,
    position,
    tier,
    rankName,
  } = data;

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  const tierHex = _hexFromTierColor(tier.color);
  const tierDark = _darken(tierHex, 0.75);

  // ─── Background ────────────────────────────────────────────
  // Deep near-black base
  ctx.fillStyle = '#0d0d14';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Left-side tier-color gradient wash that fades into the dark.
  // Acts as an accent band behind the emblem.
  const wash = ctx.createLinearGradient(0, 0, WIDTH, 0);
  wash.addColorStop(0, tierHex);
  wash.addColorStop(0.35, tierDark);
  wash.addColorStop(0.7, '#0d0d14');
  wash.addColorStop(1, '#0d0d14');
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.globalAlpha = 1;

  // Top + bottom dark bars for a "framed" card feel
  const barH = 6;
  ctx.fillStyle = tierHex;
  ctx.fillRect(0, 0, WIDTH, barH);
  ctx.fillRect(0, HEIGHT - barH, WIDTH, barH);

  // ─── Emblem (left side, big) ──────────────────────────────
  // Non-Crowned cards get a vertically centered emblem. Crowned
  // cards shift the emblem up so the big "#N" position label can
  // sit underneath without getting clipped or overlapping the
  // bottom bar.
  const EMBLEM_BOX = 320;
  const EMBLEM_X = 50;
  const hasPositionLabel = tier.topN && position !== null && position !== undefined;
  const EMBLEM_Y = hasPositionLabel ? 30 : Math.floor((HEIGHT - EMBLEM_BOX) / 2);

  let emblemDrawn = false;
  if (tier.emblem) {
    try {
      const emblemPath = path.join(EMBLEM_DIR, tier.emblem);
      if (fs.existsSync(emblemPath)) {
        const img = await loadImage(emblemPath);
        // Fit the emblem into the box preserving aspect ratio
        const scale = Math.min(EMBLEM_BOX / img.width, EMBLEM_BOX / img.height);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        const drawX = EMBLEM_X + (EMBLEM_BOX - drawW) / 2;
        const drawY = EMBLEM_Y + (EMBLEM_BOX - drawH) / 2;

        ctx.drawImage(img, drawX, drawY, drawW, drawH);
        emblemDrawn = true;
      }
    } catch (err) {
      console.warn('[RankCard] Emblem render failed:', err.message);
    }
  }

  // If the emblem was missing, draw a colored placeholder circle so
  // the card still looks composed
  if (!emblemDrawn) {
    ctx.fillStyle = tierHex;
    ctx.beginPath();
    ctx.arc(EMBLEM_X + EMBLEM_BOX / 2, EMBLEM_Y + EMBLEM_BOX / 2, EMBLEM_BOX / 2 - 20, 0, Math.PI * 2);
    ctx.fill();
  }

  // ─── Position label under the emblem (Crowned only) ──────
  // Crowned is top-N by leaderboard position — for those players
  // the raw position number is more informative than "CROWNED" so
  // we render it big and centered right below the emblem. Gives
  // every Crowned card a distinct "#1 / #4 / #10" identity.
  //
  // The offset is negative because the emblem PNGs have transparent
  // padding at the bottom of their bounding box — anchoring the
  // number a bit above EMBLEM_Y + EMBLEM_BOX pulls it visually up
  // against the crown art instead of leaving dead air in between.
  if (tier.topN && position !== null && position !== undefined) {
    const emblemCenterX = EMBLEM_X + EMBLEM_BOX / 2;
    const posY = EMBLEM_Y + EMBLEM_BOX - 20;
    ctx.fillStyle = tierHex;
    ctx.font = `bold 64px "${FONT_FAMILY}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`#${position}`, emblemCenterX, posY);
    // reset alignment so the right-column text draws from x=RIGHT_X
    ctx.textAlign = 'left';
  }

  // ─── Right side: text column ──────────────────────────────
  const RIGHT_X = 430;
  const RIGHT_W = WIDTH - RIGHT_X - 40;

  // Player display name — the hero text
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 68px "${FONT_FAMILY}"`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  _fitText(ctx, displayName, RIGHT_X, 55, RIGHT_W, 68);

  // IGN subtitle — always show if the user has an IGN on file, even
  // if it matches their display name. IGN is the identifier people
  // want visible on their rank card regardless of what their Discord
  // name happens to be.
  //
  // Pushed well below the display name so the two lines don't kiss —
  // canvas bounding boxes are tight and a bold 68px name sitting on a
  // 30px subtitle looked crowded otherwise.
  let subY = 150;
  if (ign) {
    ctx.fillStyle = '#a9a9bc';
    ctx.font = `30px "${FONT_FAMILY}"`;
    _fitText(ctx, `IGN: ${ign}`, RIGHT_X, subY, RIGHT_W, 30);
    subY += 50;
  }

  // Tier name — big, in tier color, uppercase, spaced out
  ctx.fillStyle = tierHex;
  ctx.font = `bold 56px "${FONT_FAMILY}"`;
  ctx.fillText(rankName.toUpperCase(), RIGHT_X, Math.max(subY + 12, 195));

  // Thin divider
  const dividerY = 285;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(RIGHT_X, dividerY);
  ctx.lineTo(WIDTH - 40, dividerY);
  ctx.stroke();

  // ─── Stats row ────────────────────────────────────────────
  // Position is intentionally NOT a stat cell — for Crowned cards
  // it's already rendered huge under the emblem, and non-Crowned
  // players don't get a position assigned at all.
  const stats = [
    { label: 'SEASON XP', value: points.toLocaleString('en-US') },
    { label: 'RECORD',    value: `${wins}W - ${losses}L` },
  ];

  const cellW = RIGHT_W / stats.length;
  const labelY = dividerY + 22;
  const valueY = dividerY + 52;

  stats.forEach((stat, i) => {
    const cellX = RIGHT_X + cellW * i;

    // Label (muted)
    ctx.fillStyle = '#8d8da0';
    ctx.font = `bold 22px "${FONT_FAMILY}"`;
    ctx.fillText(stat.label, cellX, labelY);

    // Value (bright, bold)
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 44px "${FONT_FAMILY}"`;
    _fitText(ctx, stat.value, cellX, valueY, cellW - 16, 44);
  });

  // ─── Rank $ watermark (bottom right) ──────────────────────
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = `bold 22px "${FONT_FAMILY}"`;
  ctx.textAlign = 'right';
  ctx.fillText('RANK $', WIDTH - 30, HEIGHT - 42);

  return canvas.toBuffer('image/png');
}

/**
 * Draw text, shrinking the font until it fits inside `maxWidth`.
 * Prevents long display names from colliding with the right edge.
 *
 * Extracts the weight (bold / normal) from the caller's ctx.font,
 * keeps that weight constant, and only varies the size. The
 * family name is always FONT_FAMILY (module-level constant).
 */
function _fitText(ctx, text, x, y, maxWidth, basePx) {
  const weightMatch = ctx.font.match(/^(bold|normal|\d{3})\b/i);
  const weight = weightMatch ? weightMatch[1] : 'normal';
  let size = basePx;
  while (size > 16) {
    ctx.font = `${weight} ${size}px "${FONT_FAMILY}"`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  ctx.font = `${weight} ${size}px "${FONT_FAMILY}"`;
  ctx.fillText(text, x, y);
}

module.exports = { renderRankCard };
