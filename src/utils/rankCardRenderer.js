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
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const EMBLEM_DIR = path.join(__dirname, '..', 'public', 'assets', 'emblems');

const WIDTH = 1100;
const HEIGHT = 440;

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
  const EMBLEM_BOX = 340;
  const EMBLEM_X = 50;
  const EMBLEM_Y = (HEIGHT - EMBLEM_BOX) / 2;

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

        // Soft glow under the emblem: draw a translucent scaled-up
        // copy behind the sharp one
        ctx.save();
        ctx.globalAlpha = 0.35;
        const glow = 24;
        ctx.drawImage(img, drawX - glow, drawY - glow, drawW + glow * 2, drawH + glow * 2);
        ctx.restore();

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

  // ─── Right side: text column ──────────────────────────────
  const RIGHT_X = 430;
  const RIGHT_W = WIDTH - RIGHT_X - 40;

  // Player display name — the hero text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 68px "Helvetica Neue", Arial, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  _fitText(ctx, displayName, RIGHT_X, 55, RIGHT_W, 68);

  // IGN subtitle (only if different from display name, to avoid dup)
  let subY = 130;
  if (ign && ign !== displayName) {
    ctx.fillStyle = '#a9a9bc';
    ctx.font = '30px "Helvetica Neue", Arial, sans-serif';
    _fitText(ctx, `IGN: ${ign}`, RIGHT_X, subY, RIGHT_W, 30);
    subY += 42;
  }

  // Tier name — big, in tier color, uppercase, spaced out
  ctx.fillStyle = tierHex;
  ctx.font = 'bold 56px "Helvetica Neue", Arial, sans-serif';
  ctx.fillText(rankName.toUpperCase(), RIGHT_X, Math.max(subY + 10, 175));

  // Thin divider
  const dividerY = 260;
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(RIGHT_X, dividerY);
  ctx.lineTo(WIDTH - 40, dividerY);
  ctx.stroke();

  // ─── Stats row ────────────────────────────────────────────
  const stats = [
    { label: 'SEASON XP', value: points.toLocaleString('en-US') },
    { label: 'RECORD',    value: `${wins}W - ${losses}L` },
  ];
  if (position !== null && position !== undefined) {
    stats.push({ label: 'LEADERBOARD', value: `#${position}` });
  }

  const cellW = RIGHT_W / stats.length;
  const labelY = dividerY + 22;
  const valueY = dividerY + 52;

  stats.forEach((stat, i) => {
    const cellX = RIGHT_X + cellW * i;

    // Label (muted)
    ctx.fillStyle = '#8d8da0';
    ctx.font = '600 22px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(stat.label, cellX, labelY);

    // Value (bright, bold)
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 44px "Helvetica Neue", Arial, sans-serif';
    _fitText(ctx, stat.value, cellX, valueY, cellW - 16, 44);
  });

  // ─── Rank $ watermark (bottom right) ──────────────────────
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = 'bold 22px "Helvetica Neue", Arial, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('RANK $', WIDTH - 30, HEIGHT - 42);

  return canvas.toBuffer('image/png');
}

/**
 * Draw text, shrinking the font until it fits inside `maxWidth`.
 * Prevents long display names from colliding with the right edge.
 */
function _fitText(ctx, text, x, y, maxWidth, basePx) {
  let size = basePx;
  // The caller already set the weight/family in ctx.font; re-parse it
  // so we can change size without losing the weight/family.
  const baseFont = ctx.font;
  const weightFamily = baseFont.replace(/^[\s\d]*(\d+)px\s*/, '');
  while (size > 16) {
    ctx.font = `${size}px ${weightFamily}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  ctx.font = `${size}px ${weightFamily}`;
  ctx.fillText(text, x, y);
}

module.exports = { renderRankCard };
