// Match result — re-exports + main handleButton router.
// Backward-compatible: require('../interactions/matchResult') still works.
const { langFor } = require('../../locales/i18n');
const { t } = require('../../locales/i18n');

const { handleNoShowReport } = require('./noShow');
const { showReportConfirm, handleReport } = require('./reporting');
const { triggerDispute } = require('./dispute');
const { handleAdminResolve, handleAdminConfirm, handleAdminConfirmNoWinner, handleAdminGoBack } = require('./adminResolve');

/**
 * Handle all match result button interactions.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleButton(interaction) {
  const id = interaction.customId;

  // No-show report + confirmation
  if (id.startsWith('noshow_report_') || id.startsWith('noshow_confirm_')) return handleNoShowReport(interaction);

  // Both captains report: "We Won" or "We Lost" -- show confirmation first
  if (id.startsWith('report_won_')) return showReportConfirm(interaction, 'won');
  if (id.startsWith('report_lost_')) return showReportConfirm(interaction, 'lost');

  // Confirmed report
  if (id.startsWith('confirm_won_')) return handleReport(interaction, 'won');
  if (id.startsWith('confirm_lost_')) return handleReport(interaction, 'lost');

  // Cancel report
  if (id === 'report_cancel') {
    const lang = langFor(interaction);
    try {
      return await interaction.update({ content: t('match_result.report_cancelled', lang), embeds: [], components: [] });
    } catch {
      return interaction.reply({ content: t('match_result.report_cancelled', lang), ephemeral: true });
    }
  }

  // Admin resolve
  if (id.startsWith('admin_resolve_team1_') || id.startsWith('admin_resolve_team2_') || id.startsWith('admin_resolve_nowinner_')) return handleAdminResolve(interaction);
  if (id.startsWith('admin_confirm_nowinner_')) return handleAdminConfirmNoWinner(interaction);
  if (id.startsWith('admin_confirm_')) return handleAdminConfirm(interaction);
  if (id.startsWith('admin_goback_')) return handleAdminGoBack(interaction);
}

/**
 * Handle modal submissions (evidence -- currently unused, kept for compat).
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleModal(interaction) {
  // Evidence modals were removed -- evidence is posted directly in channel.
  // This stub is kept so interactionCreate doesn't crash on stale cached modals.
}

module.exports = { handleButton, handleModal, triggerDispute };
