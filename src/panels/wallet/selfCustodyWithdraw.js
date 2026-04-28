// Smart-wallet withdraw handler.
//
// For users whose wallet_type='coinbase_smart_wallet', the bot cannot
// sign outbound transfers — the user owns the wallet via passkey and
// only their passkey can authorize a USDC transfer out. The only role
// the bot plays here is handing the user a one-time link into the web
// surface, where they connect their wallet and sign the transfer in
// their own browser. The tx goes directly on-chain; the bot does not
// need to be in the signing path at all.

const userRepo = require('../../database/repositories/userRepo');
const linkNonceService = require('../../services/linkNonceService');

async function handleSmartWalletWithdraw(interaction) {
  const user = userRepo.findByDiscordId(interaction.user.id);
  if (!user) {
    return interaction.reply({
      content: 'You need to register first before withdrawing.',
      ephemeral: true,
    });
  }

  if (!process.env.WALLET_WEB_BASE_URL) {
    return interaction.reply({
      content: 'Self-custody withdrawal is not configured yet. Please try again later.',
      ephemeral: true,
    });
  }

  let url;
  try {
    url = linkNonceService.mintLink({
      userId: user.id,
      purpose: 'withdraw',
      ttlSeconds: 600,
    });
  } catch (err) {
    console.error(`[SelfCustodyWithdraw] mintLink failed for user ${user.id}: ${err.message}`);
    return interaction.reply({
      content: 'Could not generate your withdraw link right now. Try again in a moment.',
      ephemeral: true,
    });
  }

  // DM-first, ephemeral fallback — same pattern as setup link delivery.
  // Withdraw links carry no secret value beyond 10 minutes of one-time
  // access; the user's signature at the web surface is what actually
  // authorizes the transfer.
  const message = [
    '**Withdraw USDC**',
    '',
    `Click the link below within **10 minutes** to confirm your withdrawal:`,
    '',
    url,
    '',
    'On that page you\'ll connect your wallet, enter the destination address and amount, and tap **Confirm**. Rank $ never touches your money — only you can confirm.',
  ].join('\n');

  let dmDelivered = false;
  try {
    const dmUser = await interaction.client.users.fetch(interaction.user.id);
    await dmUser.send({ content: message });
    dmDelivered = true;
  } catch (dmErr) {
    console.log(`[SelfCustodyWithdraw] DM blocked for user ${user.id}: ${dmErr.message} — ephemeral fallback`);
  }

  if (dmDelivered) {
    return interaction.reply({
      content: '✅ I just DMed you a one-time withdrawal link. Check your Discord inbox — it expires in 10 minutes.',
      ephemeral: true,
    });
  }
  return interaction.reply({ content: message, ephemeral: true });
}

module.exports = { handleSmartWalletWithdraw };
