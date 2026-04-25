// Shared handler for "user has registered but not yet completed /setup."
//
// In the post-refactor onboarding flow, new users accept TOS and get a
// setup link but their `wallets` row isn't inserted until they finish
// the passkey ceremony + SpendPermission sign on the web surface and
// the on-chain `approveWithSignature` UserOp confirms.
//
// SELF-HEAL ON CLICK
// ------------------
// Before showing the "finish setting up" panel, this handler checks
// for a `pending` spend_permission row for the user. If one exists,
// the user already signed in the browser but the bot's background
// approveOnChain failed silently (transient CDP/RPC hiccup, lock
// contention, etc.). We retry it inline here so a single click on
// "View My Wallet" recovers the stuck state — no operator needed.
//
// On success, _flipWalletToSelfCustody runs as a side effect and
// creates the wallets row, so we then re-route to the normal wallet
// view. On failure, we surface the error to ADMIN_ALERTS_CHANNEL_ID
// so the operator sees the problem instead of it being buried in a
// log file, and fall through to the pending-setup panel as before.
//
// If there's no pending permission, the user really does need to go
// through /setup — mint a fresh link and show the panel.

const { EmbedBuilder } = require('discord.js');

async function handleWalletPendingSetup(interaction, user) {
  if (!process.env.WALLET_WEB_BASE_URL) {
    return interaction.reply({
      content: 'Self-custody wallet setup is not configured. An admin needs to set WALLET_WEB_BASE_URL.',
      ephemeral: true,
    });
  }

  // Self-heal path: if the user has a pending permission, the
  // browser-side sign succeeded but the bot's background
  // approveWithSignature didn't land. Retry inline.
  try {
    const spendPermissionRepo = require('../../database/repositories/spendPermissionRepo');
    const pending = spendPermissionRepo.findAllForUser(user.id).find(r => r.status === 'pending');
    if (pending) {
      // Defer so the retry can take a few seconds without timing out
      // the interaction (Discord allows 15 minutes after defer).
      await interaction.deferReply({ ephemeral: true });

      console.log(`[WalletPendingSetup] User ${user.id} has pending permission #${pending.id} — retrying approveOnChain inline`);
      const walletRepo = require('../../database/repositories/walletRepo');
      const spendPermissionService = require('../../services/spendPermissionService');

      const locked = walletRepo.acquireLock(user.id);
      if (!locked) {
        return interaction.editReply({
          content: 'Your wallet setup is finishing up — try **View My Wallet** again in 30 seconds.',
        });
      }
      try {
        await spendPermissionService.approveOnChain(pending.id);
        // Success — the wallets row is now created via the
        // _flipWalletToSelfCustody side effect inside approveOnChain.
        // Re-route the click into the normal wallet view path.
        const freshWallet = walletRepo.findByUserId(user.id);
        if (freshWallet) {
          const { buildWalletView } = require('../walletPanelView');
          const { langFor } = require('../../locales/i18n');
          const view = buildWalletView(freshWallet, user, langFor(interaction));
          return interaction.editReply({
            ...view,
            _persist: true,
          });
        }
        // approveOnChain returned but no wallet row appeared — log loudly
        // and fall through to the setup-link panel below.
        console.error(`[WalletPendingSetup] approveOnChain succeeded for user ${user.id} but wallets row still missing — falling through to setup panel.`);
      } catch (retryErr) {
        console.error(`[WalletPendingSetup] inline approveOnChain retry failed for user ${user.id} permission #${pending.id}: ${retryErr.message}`);
        // Fire-and-forget admin alert so the operator can see the
        // failure instead of it being buried in stdout. Best effort —
        // never let a missing channel break the user-facing reply.
        try {
          const alertChannelId = process.env.ADMIN_ALERTS_CHANNEL_ID;
          if (alertChannelId) {
            const ch = interaction.client.channels.cache.get(alertChannelId);
            if (ch) {
              ch.send({
                content:
                  `🚨 **Stuck wallet setup** — user <@${user.discord_id}> (id=${user.id}, perm #${pending.id})\n` +
                  `Inline approveOnChain retry failed: \`${retryErr.message}\`\n` +
                  `Likely causes: CDP Paymaster allowlist missing \`approveWithSignature\` on SpendPermissionManager (\`0xf85210B21cC50302F477BA56686d2019dC9b67Ad\`), or transient RPC. Manual retry: \`node -e "require('dotenv').config(); require('./src/database/db'); require('./src/services/spendPermissionService').approveOnChain(${pending.id}).then(()=>console.log('ok')).catch(e=>console.error(e))"\``,
                allowedMentions: { users: [] },
              }).catch(() => {});
            }
          }
        } catch { /* swallow */ }
        // Fall through to the setup-link panel below so the user sees something.
      } finally {
        walletRepo.releaseLock(user.id);
      }
    }
  } catch (selfHealErr) {
    console.error(`[WalletPendingSetup] self-heal pre-check failed for user ${user.id}: ${selfHealErr.message}`);
    // Continue to the setup panel.
  }

  let url;
  try {
    const linkNonceService = require('../../services/linkNonceService');
    url = linkNonceService.mintLink({
      userId: user.id,
      purpose: 'setup',
      ttlSeconds: 2 * 60 * 60,
    });
  } catch (err) {
    console.error(`[WalletPendingSetup] mintLink failed for user ${user.id}: ${err.message}`);
    const reply = interaction.deferred
      ? interaction.editReply({ content: 'Could not generate your setup link right now. Try again in a moment.' })
      : interaction.reply({ content: 'Could not generate your setup link right now. Try again in a moment.', ephemeral: true });
    return reply;
  }

  const embed = new EmbedBuilder()
    .setTitle('🔐 Finish setting up your wallet')
    .setColor(0x2ecc71)
    .setDescription([
      'You haven\'t set up your self-custody wallet yet. Click the link below to create it — takes about 30 seconds.',
      '',
      `**${url}**`,
      '',
      '**What happens:**',
      '• You enter an email once on Coinbase\'s wallet tool (not a Coinbase.com account — just anchors your passkey)',
      '• Your phone or computer\'s built-in passkey (Face ID / Touch ID / Windows Hello / security key) becomes the signer',
      '• **Only you can sign.** Rank $ never sees your passkey and can never move funds without your permission.',
      '• You set your own daily spending limit on cash matches (like a daily budget you set for yourself)',
      '',
      '_Link valid for 2 hours, single use. Click **View My Wallet** again if it expires._',
    ].join('\n'));

  // If we deferred earlier (self-heal attempt), use editReply; otherwise reply.
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ embeds: [embed] });
  }
  return interaction.reply({
    embeds: [embed],
    ephemeral: true,
  });
}

module.exports = { handleWalletPendingSetup };
