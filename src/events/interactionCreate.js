const challengeCreate = require('../interactions/challengeCreate');
const challengeAccept = require('../interactions/challengeAccept');
const challengeCancel = require('../interactions/challengeCancel');
const teammateResponse = require('../interactions/teammateResponse');
const matchResult = require('../interactions/matchResult');
const onboarding = require('../interactions/onboarding');
const walletPanel = require('../panels/walletPanel');
const leaderboardPanel = require('../panels/leaderboardPanel');

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
        if (id.startsWith('challenge_accept')) {
          return await challengeAccept.handleButton(interaction);
        }
        // Challenge cancel button
        if (id.startsWith('challenge_cancel_')) {
          return await challengeCancel.handleButton(interaction);
        }
        // Teammate accept/decline buttons
        if (id.startsWith('teammate_')) {
          return await teammateResponse.handleButton(interaction);
        }
        // Match result flow (report win, accept, confirm, dispute, evidence, admin)
        if (id.startsWith('report_win_') || id.startsWith('result_') ||
            id.startsWith('submit_evidence_') || id.startsWith('admin_resolve_') ||
            id.startsWith('admin_confirm_') || id.startsWith('admin_goback_')) {
          return await matchResult.handleButton(interaction);
        }
        // Onboarding TOS buttons
        if (id.startsWith('tos_')) {
          return await onboarding.handleButton(interaction);
        }
        // Panel: My Wallet button
        if (id === 'panel_wallet') {
          return await walletPanel.handleWalletButton(interaction);
        }
        // Wallet sub-buttons (deposit, withdraw, history)
        if (id.startsWith('wallet_')) {
          return await walletPanel.handleWalletSubButton(interaction);
        }
        // Panel: Leaderboard button
        if (id === 'panel_leaderboard') {
          return await leaderboardPanel.handleLeaderboardButton(interaction);
        }
        // Leaderboard sub-buttons (xp, earnings, wins)
        if (id.startsWith('lb_')) {
          return await leaderboardPanel.handleLeaderboardSubButton(interaction);
        }
        console.warn(`[Interaction] Unhandled button customId: ${id}`);
        return;
      }

      // Modal submissions
      if (interaction.isModalSubmit()) {
        const id = interaction.customId;

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
