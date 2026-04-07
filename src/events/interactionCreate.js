const challengeCreate = require('../interactions/challengeCreate');
const challengeAccept = require('../interactions/challengeAccept');
const challengeCancel = require('../interactions/challengeCancel');
const teammateResponse = require('../interactions/teammateResponse');
const matchResult = require('../interactions/matchResult');
const disputeCreate = require('../interactions/disputeCreate');
const onboarding = require('../interactions/onboarding');
const walletPanel = require('../panels/walletPanel');
const leaderboardPanel = require('../panels/leaderboardPanel');
const seasonPanel = require('../panels/seasonPanel');
const escrowPanel = require('../panels/escrowPanel');

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    try {
      // Button interactions
      if (interaction.isButton()) {
        const id = interaction.customId;

        // Wager creation flow buttons
        if (id.startsWith('wager_')) {
          return await challengeCreate.handleButton(interaction);
        }
        // Challenge board accept button
        if (id.startsWith('challenge_accept_')) {
          return await challengeAccept.handleButton(interaction);
        }
        // Challenge accept confirmation (1v1)
        if (id.startsWith('challenge_confirm_') && !id.startsWith('challenge_confirm_cancel_')) {
          return await challengeAccept.handleConfirmedAccept(interaction);
        }
        // Challenge team accept confirmation (after teammate selection)
        if (id.startsWith('challenge_team_confirm_')) {
          return await challengeAccept.handleTeamConfirmedAccept(interaction);
        }
        // Challenge nevermind (cancel confirmation)
        if (id.startsWith('challenge_nevermind_')) {
          return interaction.update({ content: 'No problem. Challenge not accepted.', embeds: [], components: [] });
        }
        // Challenge cancel + confirm cancel
        if (id === 'challenge_cancel_nevermind') {
          return interaction.update({ content: 'Cancel aborted.', embeds: [], components: [] });
        }
        if (id.startsWith('challenge_cancel_') || id.startsWith('challenge_confirm_cancel_')) {
          return await challengeCancel.handleButton(interaction);
        }
        // Teammate accept/decline buttons
        if (id.startsWith('teammate_')) {
          return await teammateResponse.handleButton(interaction);
        }
        // Match result flow (report won/lost, no-show, evidence, admin)
        if (id.startsWith('report_won_') || id.startsWith('report_lost_') ||
            id.startsWith('noshow_report_') || id.startsWith('submit_evidence_') ||
            id.startsWith('admin_resolve_') || id.startsWith('admin_confirm_') ||
            id.startsWith('admin_goback_')) {
          return await matchResult.handleButton(interaction);
        }
        // Create Dispute button from lobby
        if (id === 'create_dispute') {
          return await disputeCreate.handleCreateDispute(interaction);
        }
        // Dispute match selection
        if (id.startsWith('dispute_select_')) {
          return await disputeCreate.handleDisputeSelect(interaction);
        }
        // Dispute confirmation
        if (id.startsWith('dispute_confirm_')) {
          return await disputeCreate.handleDisputeConfirm(interaction);
        }
        // Dispute nevermind
        if (id === 'dispute_nevermind') {
          return interaction.update({ content: 'Dispute cancelled.', embeds: [], components: [] });
        }
        // Onboarding TOS buttons + wallet refresh
        if (id.startsWith('tos_') || id === 'wallet_refresh') {
          return await onboarding.handleButton(interaction);
        }
        // Wallet action buttons (withdraw, history) — in wallet channel
        if (id.startsWith('wallet_')) {
          return await walletPanel.handleWalletSubButton(interaction);
        }
        // Escrow panel buttons
        if (id.startsWith('escrow_')) {
          return await escrowPanel.handleEscrowButton(interaction);
        }
        // Season management buttons
        if (id.startsWith('season_')) {
          return await seasonPanel.handleSeasonButton(interaction);
        }
        // Leaderboard buttons (all-time, season, refresh, admin)
        if (id.startsWith('xplb_') || id.startsWith('earnlb_') || id.startsWith('lb_admin_')) {
          return await leaderboardPanel.handleLeaderboardButton(interaction);
        }
        console.warn(`[Interaction] Unhandled button customId: ${id}`);
        return;
      }

      // Modal submissions
      if (interaction.isModalSubmit()) {
        const id = interaction.customId;

        if (id === 'registration_modal') {
          return await onboarding.handleRegistrationModal(interaction);
        }
        if (id === 'entry_amount') {
          return await challengeCreate.handleModal(interaction);
        }
        if (id === 'wallet_withdraw_modal') {
          return await walletPanel.handleWithdrawModal(interaction);
        }
        if (id === 'wallet_withdraw_sol_modal') {
          return await walletPanel.handleWithdrawSolModal(interaction);
        }
        if (id.startsWith('evidence_modal_')) {
          return await matchResult.handleModal(interaction);
        }
        if (id.startsWith('lb_admin_')) {
          return await leaderboardPanel.handleAdminModal(interaction);
        }
        if (id === 'season_end_modal') {
          return await seasonPanel.handleSeasonModal(interaction);
        }

        console.warn(`[Interaction] Unhandled modal customId: ${id}`);
        return;
      }

      // User select menus
      if (interaction.isUserSelectMenu()) {
        const id = interaction.customId;

        if (id.startsWith('select_teammates')) {
          return await challengeCreate.handleUserSelect(interaction);
        }
        if (id.startsWith('select_opponents')) {
          return await challengeAccept.handleUserSelect(interaction);
        }

        console.warn(`[Interaction] Unhandled user select customId: ${id}`);
        return;
      }
    } catch (err) {
      console.error('[Interaction] Error handling interaction:', err);

      const reply = {
        content: 'Something went wrong. Please try again later.',
        ephemeral: true,
      };

      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply);
        } else {
          await interaction.reply(reply);
        }
      } catch (replyErr) {
        console.error('[Interaction] Failed to send error reply:', replyErr);
      }
    }
  },
};
