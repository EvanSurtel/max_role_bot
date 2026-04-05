const { createCanvas, loadImage } = require('@napi-rs/canvas');

/**
 * Render a leaderboard image with avatars, usernames, XP, and W-L records.
 *
 * @param {string} title - Leaderboard title
 * @param {Array} entries - Array of { discord_id, username, cod_ign, points, wins, losses, avatarUrl }
 * @returns {Promise<Buffer>} PNG image buffer
 */
async function renderLeaderboard(title, entries) {
  const width = 900;
  const rowHeight = 70;
  const headerHeight = 80;
  const padding = 20;
  const height = headerHeight + (entries.length * rowHeight) + padding * 2;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, 0, width, height);

  // Title bar
  ctx.fillStyle = '#1e1f22';
  ctx.fillRect(0, 0, width, headerHeight);

  // Title text
  ctx.fillStyle = '#5865f2';
  ctx.font = 'bold 32px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, padding, headerHeight / 2);

  // Rows
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const y = headerHeight + padding + (i * rowHeight);
    const rowMidY = y + rowHeight / 2;

    // Row background (alternating)
    ctx.fillStyle = i % 2 === 0 ? '#313338' : '#2b2d31';
    ctx.fillRect(padding, y, width - padding * 2, rowHeight - 4);

    // Rank color bar (left side)
    let rankColor = '#5865f2';
    if (i === 0) rankColor = '#ffd700'; // gold
    else if (i === 1) rankColor = '#c0c0c0'; // silver
    else if (i === 2) rankColor = '#cd7f32'; // bronze
    ctx.fillStyle = rankColor;
    ctx.fillRect(padding, y, 6, rowHeight - 4);

    // Rank number
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(`#${i + 1}`, padding + 20, rowMidY);

    // Avatar (circular)
    const avatarSize = 48;
    const avatarX = padding + 80;
    const avatarY = y + (rowHeight - avatarSize) / 2;

    try {
      if (entry.avatarUrl) {
        const avatar = await loadImage(entry.avatarUrl);
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
        ctx.restore();
      } else {
        // Placeholder circle
        ctx.fillStyle = '#5865f2';
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    } catch {
      ctx.fillStyle = '#5865f2';
      ctx.beginPath();
      ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Username
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px sans-serif';
    const displayName = entry.username || 'Unknown';
    ctx.fillText(displayName, avatarX + avatarSize + 15, rowMidY - 10);

    // IGN (if set)
    if (entry.cod_ign) {
      ctx.fillStyle = '#b5bac1';
      ctx.font = '16px sans-serif';
      ctx.fillText(entry.cod_ign, avatarX + avatarSize + 15, rowMidY + 14);
    }

    // XP (right side)
    ctx.fillStyle = '#5865f2';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'right';
    const xpText = `${entry.points.toLocaleString()} XP`;
    ctx.fillText(xpText, width - padding - 20 - 120, rowMidY);

    // Record
    ctx.fillStyle = '#b5bac1';
    ctx.font = '20px sans-serif';
    const record = `(${entry.wins}W - ${entry.losses}L)`;
    ctx.fillText(record, width - padding - 20, rowMidY);

    ctx.textAlign = 'left';
  }

  return canvas.encode('png');
}

/**
 * Render an earnings leaderboard image (similar but shows $ instead of XP).
 */
async function renderEarningsLeaderboard(title, entries) {
  const width = 900;
  const rowHeight = 70;
  const headerHeight = 80;
  const padding = 20;
  const height = headerHeight + (entries.length * rowHeight) + padding * 2;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#2b2d31';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#1e1f22';
  ctx.fillRect(0, 0, width, headerHeight);

  ctx.fillStyle = '#57f287';
  ctx.font = 'bold 32px sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, padding, headerHeight / 2);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const y = headerHeight + padding + (i * rowHeight);
    const rowMidY = y + rowHeight / 2;

    ctx.fillStyle = i % 2 === 0 ? '#313338' : '#2b2d31';
    ctx.fillRect(padding, y, width - padding * 2, rowHeight - 4);

    let rankColor = '#57f287';
    if (i === 0) rankColor = '#ffd700';
    else if (i === 1) rankColor = '#c0c0c0';
    else if (i === 2) rankColor = '#cd7f32';
    ctx.fillStyle = rankColor;
    ctx.fillRect(padding, y, 6, rowHeight - 4);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(`#${i + 1}`, padding + 20, rowMidY);

    const avatarSize = 48;
    const avatarX = padding + 80;
    const avatarY = y + (rowHeight - avatarSize) / 2;

    try {
      if (entry.avatarUrl) {
        const avatar = await loadImage(entry.avatarUrl);
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
        ctx.restore();
      } else {
        ctx.fillStyle = '#57f287';
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    } catch {
      ctx.fillStyle = '#57f287';
      ctx.beginPath();
      ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(entry.username || 'Unknown', avatarX + avatarSize + 15, rowMidY - 10);

    if (entry.cod_ign) {
      ctx.fillStyle = '#b5bac1';
      ctx.font = '16px sans-serif';
      ctx.fillText(entry.cod_ign, avatarX + avatarSize + 15, rowMidY + 14);
    }

    ctx.fillStyle = '#57f287';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`$${entry.earnings.toFixed(2)}`, width - padding - 20 - 120, rowMidY);

    ctx.fillStyle = '#b5bac1';
    ctx.font = '20px sans-serif';
    ctx.fillText(`(${entry.wins}W - ${entry.losses}L)`, width - padding - 20, rowMidY);

    ctx.textAlign = 'left';
  }

  return canvas.encode('png');
}

module.exports = { renderLeaderboard, renderEarningsLeaderboard };
