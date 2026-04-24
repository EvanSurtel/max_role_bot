// Shared handler for "user has registered but not yet completed /setup."
//
// In the post-refactor onboarding flow, new users accept TOS and get a
// setup link but their `wallets` row isn't inserted until they finish
// the passkey ceremony + SpendPermission sign on the web surface and
// the /api/internal/wallet/grant callback lands. During that window —
// which can be minutes, hours, or longer if the user steps away — any
// wallet-dependent Discord button (View Wallet, Deposit, Withdraw,
// Cash Out) has no wallet row to render against.
//
// Rather than show a generic "Wallet not found" error, mint a fresh
// 24-hour setup link and guide the user to complete setup. Same end
// state as the onboarding-complete embed, just accessible from any
// entry point so the user doesn't have to hunt for the original link.

const { EmbedBuilder } = require('discord.js');

async function handleWalletPendingSetup(interaction, user) {
  if (!process.env.WALLET_WEB_BASE_URL) {
    return interaction.reply({
      content: 'Self-custody wallet setup is not configured. An admin needs to set WALLET_WEB_BASE_URL.',
      ephemeral: true,
    });
  }

  let url;
  try {
    const linkNonceService = require('../../services/linkNonceService');
    url = linkNonceService.mintLink({
      userId: user.id,
      purpose: 'setup',
      ttlSeconds: 24 * 60 * 60,
    });
  } catch (err) {
    console.error(`[WalletPendingSetup] mintLink failed for user ${user.id}: ${err.message}`);
    return interaction.reply({
      content: 'Could not generate your setup link right now. Try again in a moment.',
      ephemeral: true,
    });
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
      '• You set a daily match limit you control — like a daily debit-card limit',
      '',
      '_Link valid for 24 hours, single use._',
    ].join('\n'));

  return interaction.reply({
    embeds: [embed],
    ephemeral: true,
  });
}

module.exports = { handleWalletPendingSetup };
