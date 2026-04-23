// "Upgrade to Self-Custody" button handler.
//
// User clicks the button on their wallet ephemeral; bot mints a
// one-time link nonce, DMs them the setup URL on the wallet web
// surface (Vercel), and confirms with an ephemeral reply that the
// DM was sent. From the web surface the user creates a Coinbase
// Smart Wallet via passkey and signs the initial SpendPermission;
// the web's POST to /api/internal/wallet/grant on the bot then
// flips wallet_type to 'coinbase_smart_wallet' and persists the
// new Smart Wallet address.

const { EmbedBuilder } = require('discord.js');
const userRepo = require('../../database/repositories/userRepo');
const linkNonceService = require('../../services/linkNonceService');

async function handleSelfCustodySetup(interaction) {
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({
      content: 'You need to register first before upgrading your wallet.',
      ephemeral: true,
    });
  }

  if (!process.env.WALLET_WEB_BASE_URL) {
    return interaction.reply({
      content: 'Self-custody upgrade is not configured yet. Please try again later.',
      ephemeral: true,
    });
  }

  let url;
  try {
    url = linkNonceService.mintLink({
      userId: user.id,
      purpose: 'setup',
      ttlSeconds: 600, // 10-minute window
    });
  } catch (err) {
    console.error(`[SelfCustodySetup] mintLink failed for user ${user.id}: ${err.message}`);
    return interaction.reply({
      content: 'Could not generate your setup link right now. Try again in a moment.',
      ephemeral: true,
    });
  }

  // Try DM first. Per CLAUDE.md the bot's standing rule is "no DMs"
  // EXCEPT for a few specific cases — wallet setup links are
  // financial-credential adjacent so a private DM is the right channel
  // (matches teammate-invite and rank-promotion DM exceptions). If
  // the user has DMs disabled, we fall back to an ephemeral with the
  // link embedded — same security since the ephemeral is only
  // visible to the clicker.

  const setupEmbed = new EmbedBuilder()
    .setTitle('🔐 Set up your self-custody wallet')
    .setColor(0x2ecc71)
    .setDescription([
      `Click the link below within **10 minutes** to set up your own crypto wallet on Base.`,
      '',
      `**${url}**`,
      '',
      '**What happens next:**',
      '• You create a wallet locked by your phone or computer\'s built-in passkey (Face ID, Touch ID, Windows Hello, security key)',
      '• **Only you can sign with it.** Rank $ never sees your passkey.',
      '• You set a daily match limit you control — like a daily debit-card limit',
      '• **You\'re not paying anything now.** The limit just caps how much can be charged for matches so you don\'t need to approve every match individually',
      '• You can change the limit, send funds anywhere, or turn off Rank $\'s ability to charge you — all anytime',
    ].join('\n'))
    .setFooter({ text: 'Link expires in 10 minutes. Single use.' });

  let dmDelivered = false;
  try {
    const dmUser = await interaction.client.users.fetch(interaction.user.id);
    await dmUser.send({ embeds: [setupEmbed] });
    dmDelivered = true;
    console.log(`[SelfCustodySetup] DM'd setup link to user ${user.id} (${interaction.user.tag})`);
  } catch (dmErr) {
    console.log(`[SelfCustodySetup] DM blocked for user ${user.id} (${dmErr.message}) — falling back to ephemeral`);
  }

  if (dmDelivered) {
    return interaction.reply({
      content: '✅ I just sent you a DM with your one-time setup link. Check your Discord inbox — it expires in 10 minutes.',
      ephemeral: true,
    });
  }

  // DM blocked — embed the link directly in the ephemeral. Only the
  // clicker sees ephemeral replies.
  return interaction.reply({
    embeds: [setupEmbed],
    ephemeral: true,
  });
}

module.exports = { handleSelfCustodySetup };
