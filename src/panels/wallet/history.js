// Transaction history with pagination.
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const transactionRepo = require('../../database/repositories/transactionRepo');
const { USDC_PER_UNIT } = require('../../config/constants');
const { t } = require('../../locales/i18n');

/**
 * Show paginated transaction history for the user's wallet.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} user - DB user row.
 * @param {string} lang - Locale code.
 */
async function handleHistory(interaction, user, lang) {
  const id = interaction.customId;
  const transactions = transactionRepo.findByUserId(user.id).reverse(); // newest first
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(transactions.length / pageSize));

  let page = 0;
  if (id.startsWith('wallet_history_page_')) {
    page = parseInt(id.replace('wallet_history_page_', ''), 10) || 0;
  }
  if (page < 0) page = 0;
  if (page >= totalPages) page = totalPages - 1;

  if (transactions.length === 0) {
    return interaction.reply({ content: t('wallet.history_empty', lang), ephemeral: true });
  }

  const pageItems = transactions.slice(page * pageSize, (page + 1) * pageSize);
  const lines = pageItems.map((tx, i) => {
    const num = page * pageSize + i + 1;
    const amountUsdc = (Number(tx.amount_usdc) / USDC_PER_UNIT).toFixed(2);
    const date = tx.created_at ? tx.created_at.slice(0, 10) : 'N/A';
    const icon = tx.type === 'deposit' ? '\u{1F4E5}' : tx.type === 'withdrawal' || tx.type === 'sol_withdrawal' ? '\u{1F4E4}' : '\u{1F504}';
    const typeLabel = t(`tx_type.${tx.type}`, lang);
    return `${num}. ${icon} **${typeLabel}** \u2014 $${amountUsdc} USDC \u2014 ${date}`;
  });

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wallet_history_page_${page - 1}`)
      .setLabel(t('common.previous', lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`wallet_history_page_${page + 1}`)
      .setLabel(t('common.next', lang))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );

  const header = `**${t('wallet.history_title', lang)}** (${t('wallet.history_page', lang, { page: page + 1, total: totalPages, count: transactions.length })})`;
  const content = `${header}\n\n${lines.join('\n')}`;

  if (id === 'wallet_history') {
    return interaction.reply({ content, components: [navRow], ephemeral: true });
  } else {
    return interaction.update({ content, components: [navRow] });
  }
}

module.exports = { handleHistory };
