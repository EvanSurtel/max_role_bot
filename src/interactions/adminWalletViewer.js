// Admin wallet viewer handler.
//
// Triggered when an admin picks a user from the UserSelectMenu in the
// admin wallet viewer channel. Verifies the clicker is an admin, looks
// up the selected user's wallet, and replies with an ephemeral showing
// that wallet's full details (balance, address, transaction history
// link). The selected user does not see this — only the admin who
// triggered it.

const userRepo = require('../database/repositories/userRepo');
const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('../base/walletManager');
const { USDC_PER_UNIT } = require('../config/constants');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { t, langFor } = require('../locales/i18n');

function isAdmin(member) {
  if (!member) return false;
  // Ads, CEO, and owner roles are treated as admin-equivalent everywhere.
  const adsRoleId = process.env.ADS_ROLE_ID;
  const ceoRoleId = process.env.CEO_ROLE_ID;
  const ownerRoleId = process.env.OWNER_ROLE_ID;
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (adsRoleId && member.roles.cache.has(adsRoleId)) return true;
  if (ceoRoleId && member.roles.cache.has(ceoRoleId)) return true;
  if (ownerRoleId && member.roles.cache.has(ownerRoleId)) return true;
  if (adminRoleId && member.roles.cache.has(adminRoleId)) return true;
  return false;
}

/**
 * Build an embed showing the target user's wallet details. Used for the
 * admin viewer ephemeral. Shows more than the regular wallet view —
 * includes the user's Discord ID, COD IGN, country, region, and recent
 * transaction count, since the admin needs the full picture.
 */
function buildAdminWalletViewEmbed(targetUser, wallet, solBalance, lang) {
  const availableUsdc = (Number(wallet.balance_available) / USDC_PER_UNIT).toFixed(2);
  const heldUsdc = (Number(wallet.balance_held) / USDC_PER_UNIT).toFixed(2);
  const solFormatted = (Number(solBalance) / 1_000_000_000).toFixed(8);
  const txCount = transactionRepo.findByUserId(targetUser.id).length;

  const username = targetUser.server_username || targetUser.cod_ign || 'Unknown';

  const embed = new EmbedBuilder()
    .setTitle(t('admin_wallet_viewer.user_wallet_title', lang, { username }))
    .setColor(0xe67e22)
    .setDescription([
      `**Discord:** <@${targetUser.discord_id}> (\`${targetUser.discord_id}\`)`,
      targetUser.cod_ign ? `**COD IGN:** ${targetUser.cod_ign}` : null,
      targetUser.cod_uid ? `**COD UID:** \`${targetUser.cod_uid}\`` : null,
      targetUser.region ? `**Region:** ${targetUser.region.toUpperCase()}` : null,
      targetUser.country_flag ? `**Country:** ${targetUser.country_flag}` : null,
      targetUser.language ? `**Language:** ${targetUser.language}` : null,
      '',
      `**Wallet Address:**\n\`\`\`\n${wallet.solana_address}\n\`\`\``,
    ].filter(Boolean).join('\n'))
    .addFields(
      { name: t('wallet_embed.available', lang), value: `$${availableUsdc} USDC`, inline: true },
      { name: t('wallet_embed.held', lang), value: `$${heldUsdc} USDC`, inline: true },
      { name: t('wallet.sol_balance', lang), value: `${solFormatted} SOL`, inline: true },
      { name: t('admin_wallet_viewer.tx_count', lang), value: `${txCount}`, inline: true },
      { name: t('admin_wallet_viewer.activated', lang), value: wallet.is_activated ? '✅' : '❌', inline: true },
    )
    .setTimestamp();

  return embed;
}

/**
 * Handle the admin's user selection. Validates admin permissions, then
 * sends an ephemeral with the target user's wallet details + a "View
 * Transactions" button so the admin can drill into the user's full
 * transaction history.
 */
async function handleAdminWalletViewSelect(interaction) {
  const lang = langFor(interaction);

  if (!isAdmin(interaction.member)) {
    return interaction.reply({
      content: t('admin_wallet_viewer.admin_only', lang),
      ephemeral: true,
    });
  }

  const targetDiscordId = interaction.values[0];
  const targetUser = userRepo.findByDiscordId(targetDiscordId);
  if (!targetUser) {
    return interaction.reply({
      content: t('admin_wallet_viewer.user_not_registered', lang, { id: targetDiscordId }),
      ephemeral: true,
    });
  }

  const wallet = walletRepo.findByUserId(targetUser.id);
  if (!wallet) {
    return interaction.reply({
      content: t('admin_wallet_viewer.no_wallet', lang),
      ephemeral: true,
    });
  }

  let solBalance = '0';
  try { solBalance = await walletManager.getSolBalance(wallet.solana_address); } catch { /* */ }

  const embed = buildAdminWalletViewEmbed(targetUser, wallet, solBalance, lang);

  // "View Transactions" button — encodes the target user's discord ID
  // so the handler knows whose history to fetch.
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_wallet_history_${targetDiscordId}_0`)
      .setEmoji('📜')
      .setLabel(t('admin_wallet_viewer.btn_view_transactions', lang))
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.reply({
    embeds: [embed],
    components: [actionRow],
    ephemeral: true,
    _persist: true,
  });
}

/**
 * Show the target user's transaction history as an ephemeral. Paginated
 * (10 per page). Encodes the target Discord ID + page in the customId
 * so admins can paginate without losing context.
 *
 * customId format: admin_wallet_history_{targetDiscordId}_{page}
 */
async function handleAdminWalletHistory(interaction) {
  const lang = langFor(interaction);

  if (!isAdmin(interaction.member)) {
    return interaction.reply({
      content: t('admin_wallet_viewer.admin_only', lang),
      ephemeral: true,
    });
  }

  // Parse: admin_wallet_history_{discordId}_{page}
  const rest = interaction.customId.replace('admin_wallet_history_', '');
  const lastUnderscore = rest.lastIndexOf('_');
  const targetDiscordId = rest.slice(0, lastUnderscore);
  const page = parseInt(rest.slice(lastUnderscore + 1), 10) || 0;

  const targetUser = userRepo.findByDiscordId(targetDiscordId);
  if (!targetUser) {
    return interaction.reply({
      content: t('admin_wallet_viewer.user_not_registered', lang, { id: targetDiscordId }),
      ephemeral: true,
    });
  }

  const transactions = transactionRepo.findByUserId(targetUser.id).reverse();
  if (transactions.length === 0) {
    return interaction.update({
      content: t('admin_wallet_viewer.no_transactions', lang),
      embeds: [],
      components: [],
    });
  }

  const pageSize = 10;
  const totalPages = Math.ceil(transactions.length / pageSize);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageItems = transactions.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const username = targetUser.server_username || targetUser.cod_ign || 'Unknown';
  const lines = pageItems.map((tx, i) => {
    const num = safePage * pageSize + i + 1;
    const amountUsdc = (Number(tx.amount_usdc) / USDC_PER_UNIT).toFixed(2);
    const date = tx.created_at ? tx.created_at.slice(0, 16).replace('T', ' ') : 'N/A';
    const icon = tx.type === 'deposit' ? '📥'
      : (tx.type === 'withdrawal' || tx.type === 'sol_withdrawal') ? '📤'
      : '🔄';
    const typeLabel = t(`tx_type.${tx.type}`, lang);
    const sigShort = tx.solana_tx_signature ? ` \`${tx.solana_tx_signature.slice(0, 12)}...\`` : '';
    return `${num}. ${icon} **${typeLabel}** — $${amountUsdc} USDC — ${date}${sigShort}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(t('admin_wallet_viewer.tx_history_title', lang, { username }))
    .setColor(0xe67e22)
    .setDescription(lines.join('\n'))
    .setFooter({
      text: t('admin_wallet_viewer.tx_history_footer', lang, {
        page: safePage + 1,
        total: totalPages,
        count: transactions.length,
      }),
    });

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_wallet_history_${targetDiscordId}_${safePage - 1}`)
      .setLabel(t('common.previous', lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage === 0),
    new ButtonBuilder()
      .setCustomId(`admin_wallet_history_${targetDiscordId}_${safePage + 1}`)
      .setLabel(t('common.next', lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
    new ButtonBuilder()
      .setCustomId(`admin_wallet_back_${targetDiscordId}`)
      .setLabel(t('admin_wallet_viewer.btn_back_to_wallet', lang))
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.update({ embeds: [embed], components: [navRow] });
}

/**
 * "Back to wallet" — re-shows the admin wallet view embed for the
 * target user. customId: admin_wallet_back_{targetDiscordId}
 */
async function handleAdminWalletBack(interaction) {
  const lang = langFor(interaction);
  if (!isAdmin(interaction.member)) {
    return interaction.reply({ content: t('admin_wallet_viewer.admin_only', lang), ephemeral: true });
  }

  const targetDiscordId = interaction.customId.replace('admin_wallet_back_', '');
  const targetUser = userRepo.findByDiscordId(targetDiscordId);
  if (!targetUser) {
    return interaction.reply({ content: t('admin_wallet_viewer.user_not_registered', lang, { id: targetDiscordId }), ephemeral: true });
  }
  const wallet = walletRepo.findByUserId(targetUser.id);
  if (!wallet) {
    return interaction.reply({ content: t('admin_wallet_viewer.no_wallet', lang), ephemeral: true });
  }
  let solBalance = '0';
  try { solBalance = await walletManager.getSolBalance(wallet.solana_address); } catch { /* */ }

  const embed = buildAdminWalletViewEmbed(targetUser, wallet, solBalance, lang);
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_wallet_history_${targetDiscordId}_0`)
      .setEmoji('📜')
      .setLabel(t('admin_wallet_viewer.btn_view_transactions', lang))
      .setStyle(ButtonStyle.Primary),
  );

  return interaction.update({ embeds: [embed], components: [actionRow] });
}

module.exports = {
  handleAdminWalletViewSelect,
  handleAdminWalletHistory,
  handleAdminWalletBack,
};
