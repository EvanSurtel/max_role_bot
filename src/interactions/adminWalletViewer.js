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
const walletManager = require('../solana/walletManager');
const { USDC_PER_UNIT } = require('../config/constants');
const { EmbedBuilder } = require('discord.js');
const { t, langFor } = require('../locales/i18n');

function isAdmin(member) {
  if (!member) return false;
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  return adminRoleId && member.roles.cache.has(adminRoleId);
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
 * sends an ephemeral with the target user's wallet details.
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

  await interaction.reply({
    embeds: [embed],
    ephemeral: true,
    _persist: true,
  });
}

module.exports = { handleAdminWalletViewSelect };
