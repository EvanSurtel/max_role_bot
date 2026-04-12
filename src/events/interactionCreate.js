const challengeCreate = require('../interactions/challengeCreate');
const challengeAccept = require('../interactions/challengeAccept');
const challengeCancel = require('../interactions/challengeCancel');
const teammateResponse = require('../interactions/teammateResponse');
const matchResult = require('../interactions/matchResult');
const disputeCreate = require('../interactions/disputeCreate');
const onboarding = require('../interactions/onboarding');
const languageSwitcher = require('../interactions/languageSwitcher');
const perMessageLanguage = require('../interactions/perMessageLanguage');
const adminWalletViewer = require('../interactions/adminWalletViewer');
const walletPanel = require('../panels/walletPanel');
const leaderboardPanel = require('../panels/leaderboardPanel');
const seasonPanel = require('../panels/seasonPanel');
const escrowPanel = require('../panels/escrowPanel');
const { isWalletChannel, AUTO_DELETE_MS } = require('../utils/ephemeralReply');

// Per-user "current live ephemeral session" tracking. When the user
// triggers a new ephemeral reply (Create Wager, View My Wallet,
// language picker, etc.), we delete their entire previous session —
// the original ephemeral PLUS any follow-up ephemerals on the same
// interaction — so the user only ever sees ONE bot ephemeral session
// at a time.
//
// interaction.update() doesn't open a new ephemeral so it just
// refreshes the tracked interaction. interaction.followUp() ephemerals
// don't replace the session; they're tracked as additional messages
// belonging to the current session, so they get cleaned up together
// the next time the user opens a new session.
//
// We track the interaction object (for deleteReply / webhook access).
// Discord interaction tokens are valid for 15 minutes; after that
// deleteReply() throws and we silently ignore it.
const userLastEphemeral = new Map(); // discordUserId → { interaction, followupMessageIds: [] }

async function _deletePreviousEphemeralSession(userId) {
  const prev = userLastEphemeral.get(userId);
  if (!prev) return;
  userLastEphemeral.delete(userId);

  // Delete every follow-up ephemeral first (via the same interaction's
  // webhook). These are extra messages beyond the @original.
  if (prev.interaction && prev.followupMessageIds && prev.followupMessageIds.length > 0) {
    for (const msgId of prev.followupMessageIds) {
      try {
        await prev.interaction.webhook.deleteMessage(msgId);
      } catch { /* expired/gone */ }
    }
  }

  // Then delete the original ephemeral
  try {
    await prev.interaction.deleteReply();
  } catch { /* expired/gone */ }
}

/**
 * Monkey-patch interaction.reply / deferReply / followUp / update so:
 *
 * 1. Any new ephemeral REPLY auto-deletes the user's previous tracked
 *    ephemeral first, so they only ever see one bot ephemeral at a time.
 * 2. Non-persistent ephemerals still auto-delete after 5 minutes if the
 *    user hasn't dismissed them.
 * 3. interaction.update() refreshes the tracked interaction so deletes
 *    of the "current ephemeral" continue to work after multi-step flows.
 *
 * Exemptions:
 *  - `_persist: true` opts → no 5-min auto-delete (still replaceable)
 *  - Legacy per-user wallet channels → no patching at all
 *
 * The `_persist` flag is stripped from the options before they're
 * passed to Discord, since Discord doesn't know about it.
 */
function installEphemeralAutoDelete(interaction) {
  if (isWalletChannel(interaction)) return; // Legacy: old per-user wallet channels

  const origReply = interaction.reply.bind(interaction);
  const origDeferReply = interaction.deferReply.bind(interaction);
  const origFollowUp = interaction.followUp.bind(interaction);
  const origUpdate = interaction.update ? interaction.update.bind(interaction) : null;
  const origDeferUpdate = interaction.deferUpdate ? interaction.deferUpdate.bind(interaction) : null;
  const userId = interaction.user?.id;

  function splitPersist(opts) {
    if (!opts || typeof opts !== 'object') return { clean: opts, persist: false };
    const { _persist, ...clean } = opts;
    return { clean, persist: _persist === true };
  }

  interaction.reply = async function patchedReply(opts) {
    const { clean, persist } = splitPersist(opts);
    const isEphemeral = clean && (clean.ephemeral || (clean.flags && (clean.flags & 64)));

    // Replace previous ephemeral session — wipe original + follow-ups
    if (isEphemeral && userId) {
      await _deletePreviousEphemeralSession(userId);
    }

    const result = await origReply(clean);

    if (isEphemeral && userId) {
      userLastEphemeral.set(userId, { interaction, followupMessageIds: [] });
    }
    if (isEphemeral && !persist) {
      setTimeout(() => interaction.deleteReply().catch(() => {}), AUTO_DELETE_MS);
    }
    return result;
  };

  interaction.deferReply = async function patchedDeferReply(opts) {
    const { clean, persist } = splitPersist(opts);
    const isEphemeral = clean && (clean.ephemeral || (clean.flags && (clean.flags & 64)));

    if (isEphemeral && userId) {
      await _deletePreviousEphemeralSession(userId);
    }

    const result = await origDeferReply(clean);

    if (isEphemeral && userId) {
      userLastEphemeral.set(userId, { interaction, followupMessageIds: [] });
    }
    if (isEphemeral && !persist) {
      setTimeout(() => interaction.deleteReply().catch(() => {}), AUTO_DELETE_MS);
    }
    return result;
  };

  interaction.followUp = async function patchedFollowUp(opts) {
    const { clean, persist } = splitPersist(opts);
    const msg = await origFollowUp(clean);
    const isEphemeral = clean && (clean.ephemeral || (clean.flags && (clean.flags & 64)));

    // Track the followup message so the next ephemeral session can
    // wipe it. Only track if it's part of the user's CURRENT session
    // (i.e. this interaction is the tracked one).
    if (isEphemeral && msg && userId) {
      const tracked = userLastEphemeral.get(userId);
      if (tracked && tracked.interaction === interaction) {
        tracked.followupMessageIds.push(msg.id);
      }
    }

    if (isEphemeral && !persist && msg && typeof msg.delete === 'function') {
      setTimeout(() => msg.delete().catch(() => {}), AUTO_DELETE_MS);
    }
    return msg;
  };

  // interaction.update() — component interactions updating the existing
  // ephemeral. The new interaction becomes the owner of the message,
  // so we transfer tracking to it (preserving the followupMessageIds
  // from the previous tracked interaction so they can still be cleaned).
  if (origUpdate) {
    interaction.update = async function patchedUpdate(opts) {
      const { clean } = splitPersist(opts);
      const result = await origUpdate(clean);
      if (userId) {
        const prev = userLastEphemeral.get(userId);
        const followupIds = (prev && prev.followupMessageIds) || [];
        userLastEphemeral.set(userId, { interaction, followupMessageIds: followupIds });
      }
      return result;
    };
  }

  if (origDeferUpdate) {
    interaction.deferUpdate = async function patchedDeferUpdate(opts) {
      const result = await origDeferUpdate(opts);
      if (userId) {
        const prev = userLastEphemeral.get(userId);
        const followupIds = (prev && prev.followupMessageIds) || [];
        userLastEphemeral.set(userId, { interaction, followupMessageIds: followupIds });
      }
      return result;
    };
  }
}

module.exports = {
  name: 'interactionCreate',
  async execute(interaction) {
    try {
      // Auto-clean ephemeral replies after 5 min (skips wallet channels)
      installEphemeralAutoDelete(interaction);

      // Slash commands (/rank) and user context menu commands
      // (right-click user → View Rank). Route both here — the command
      // registry uses the Discord command name to map back to the
      // module in src/commands/.
      const isSlash = interaction.isChatInputCommand && interaction.isChatInputCommand();
      const isUserContext = interaction.isUserContextMenuCommand && interaction.isUserContextMenuCommand();
      if (isSlash || isUserContext) {
        // Name-to-module map. Slash commands: `rank`. Context menu:
        // Discord reports the display name ("View Rank") which doesn't
        // map 1:1 to a filename, so we handle each one explicitly.
        let modulePath = null;
        if (isSlash && interaction.commandName === 'rank') modulePath = '../commands/rank';
        if (isUserContext && interaction.commandName === 'View Rank') modulePath = '../commands/rank-context';

        if (!modulePath) {
          console.warn(`[Interaction] No handler found for command ${interaction.commandName}`);
          return;
        }

        try {
          const command = require(modulePath);
          if (command && typeof command.execute === 'function') {
            return await command.execute(interaction);
          }
        } catch (err) {
          console.error(`[Interaction] Error executing ${interaction.commandName}:`, err);
          try {
            if (interaction.replied || interaction.deferred) {
              await interaction.followUp({ content: 'Command failed. Please try again.', ephemeral: true });
            } else {
              await interaction.reply({ content: 'Command failed. Please try again.', ephemeral: true });
            }
          } catch { /* give up */ }
        }
        return;
      }

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
        // Acceptance flow teammate review buttons
        if (id.startsWith('accept_remove_tm_')) {
          return await challengeAccept.handleRemoveTeammate(interaction);
        }
        if (id.startsWith('accept_add_more_tm_')) {
          return await challengeAccept.handleAddMoreTeammate(interaction);
        }
        if (id.startsWith('accept_tm_continue_')) {
          return await challengeAccept.handleContinueTeammates(interaction);
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
            id.startsWith('confirm_won_') || id.startsWith('confirm_lost_') ||
            id.startsWith('noshow_report_') || id.startsWith('noshow_confirm_') ||
            id === 'report_cancel' ||
            id.startsWith('admin_resolve_') || id.startsWith('admin_confirm_') ||
            id.startsWith('admin_goback_')) {
          return await matchResult.handleButton(interaction);
        }
        // Create Dispute button from lobby
        if (id === 'create_dispute') {
          return await disputeCreate.handleCreateDispute(interaction);
        }
        // "View My Wallet" button on the public wallet panel
        if (id === 'wallet_view_open') {
          return await walletPanel.handleWalletViewOpen(interaction);
        }
        // "🌐 Language" button — appears on every public bot panel
        if (id === 'show_language_picker') {
          return await languageSwitcher.handleShowLanguagePicker(interaction);
        }
        // Per-message language buttons (each individual challenge / result)
        if (id.startsWith('pml_show_ch_')) {
          return await perMessageLanguage.handleShowLangForChallenge(interaction);
        }
        if (id.startsWith('pml_show_res_')) {
          return await perMessageLanguage.handleShowLangForResult(interaction);
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
        // Onboarding TOS buttons + wallet refresh button
        if (id.startsWith('tos_') || id === 'wallet_refresh') {
          return await onboarding.handleButton(interaction);
        }
        // Wallet action buttons (copy, withdraw, history) — in wallet channel
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
        // Leaderboard admin buttons
        if (id.startsWith('lb_admin_')) {
          return await leaderboardPanel.handleLeaderboardButton(interaction);
        }
        // Admin wallet viewer pagination + back navigation
        if (id.startsWith('admin_wallet_history_')) {
          return await adminWalletViewer.handleAdminWalletHistory(interaction);
        }
        if (id.startsWith('admin_wallet_back_')) {
          return await adminWalletViewer.handleAdminWalletBack(interaction);
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
        // Admin escrow withdraw modals (SOL + USDC)
        if (id === 'escrow_withdraw_sol_modal' || id === 'escrow_withdraw_usdc_modal') {
          return await escrowPanel.handleEscrowModal(interaction);
        }
        // evidence_modal_ removed — evidence posted directly in channel
        if (id.startsWith('lb_admin_')) {
          return await leaderboardPanel.handleAdminModal(interaction);
        }
        if (id === 'season_end_modal') {
          return await seasonPanel.handleSeasonModal(interaction);
        }

        console.warn(`[Interaction] Unhandled modal customId: ${id}`);
        return;
      }

      // String select menus (leaderboard dropdowns + welcome master language picker + wallet language picker)
      if (interaction.isStringSelectMenu()) {
        const id = interaction.customId;
        if (id.startsWith('xplb_') || id.startsWith('earnlb_')) {
          return await leaderboardPanel.handleLeaderboardSelect(interaction);
        }
        // Inline language dropdown placed directly on shared panels.
        // The legacy welcome_lang_master / language_panel_select /
        // lang_picker_select customIds are gone — the inline dropdown
        // handles every case now.
        if (id === 'inline_lang_select') {
          return await languageSwitcher.handleInlineLanguageSelect(interaction);
        }
        // Per-message language picks (challenge / result specific)
        if (id.startsWith('pml_pick_ch_')) {
          return await perMessageLanguage.handlePickLangForChallenge(interaction);
        }
        if (id.startsWith('pml_pick_res_')) {
          return await perMessageLanguage.handlePickLangForResult(interaction);
        }
        console.warn(`[Interaction] Unhandled string select customId: ${id}`);
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
        // Admin wallet viewer — admin picks a user, ephemeral wallet view
        if (id === 'admin_wallet_view_select') {
          return await adminWalletViewer.handleAdminWalletViewSelect(interaction);
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
        // Auto-delete error messages after 15 seconds
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 15000);
      } catch (replyErr) {
        console.error('[Interaction] Failed to send error reply:', replyErr);
      }
    }
  },
};
