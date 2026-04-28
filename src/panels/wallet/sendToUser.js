// "Send to User" wallet flow — pick a registered Discord user with a
// self-custody wallet, type an amount, sign the USDC.transfer with a
// passkey on the web surface.
//
// Self-custody invariant: the bot CANNOT move user funds. The actual
// transfer is signed by the sender's passkey on /withdraw — this flow
// just pre-fills the recipient address and amount in the link's
// metadata so the sender doesn't have to copy-paste anything.
//
// Three-step UX:
//   1. handleSendUserStart   — UserSelectMenu of registered users
//   2. handleSendUserPick    — modal asks for the amount
//   3. handleSendUserSubmit  — validates + mints /withdraw link with
//                              metadata.preset{Recipient,Amount,Label}
//                              + delivers via DM (ephemeral fallback)

const {
  ActionRowBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const userRepo = require('../../database/repositories/userRepo');
const walletRepo = require('../../database/repositories/walletRepo');
const linkNonceService = require('../../services/linkNonceService');
const { USDC_PER_UNIT } = require('../../config/constants');

// In-memory map of in-flight selections. Discord doesn't pipe state
// through a UserSelect → button → modal chain, so we stash the picked
// recipient between steps. Cleared on submit / abandon (24h TTL).
const _pendingSends = new Map(); // senderDiscordId -> { recipientDiscordId, recipientUserId, ts }
const _PENDING_TTL_MS = 24 * 60 * 60 * 1000;

function _gcPending() {
  const cutoff = Date.now() - _PENDING_TTL_MS;
  for (const [k, v] of _pendingSends.entries()) {
    if (v.ts < cutoff) _pendingSends.delete(k);
  }
}

async function handleSendUserStart(interaction, user, wallet) {
  const balanceUsdc = (Number(wallet.balance_available || 0) / USDC_PER_UNIT).toFixed(2);
  const row = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('wallet_send_user_pick')
      .setPlaceholder('Pick someone in this server')
      .setMinValues(1)
      .setMaxValues(1),
  );
  return interaction.reply({
    content: [
      '**Send USDC to another player**',
      `Available balance: **$${balanceUsdc} USDC**`,
      '',
      'Pick the user you want to send to. They must already be registered with the bot and have set up their wallet.',
      '',
      '_You\'ll confirm the transfer on the next screen — Rank $ never touches your money._',
    ].join('\n'),
    components: [row],
    ephemeral: true,
    _autoDeleteMs: 5 * 60 * 1000,
  });
}

async function handleSendUserPick(interaction) {
  const senderDiscordId = interaction.user.id;
  const recipientDiscordId = interaction.values[0];

  if (recipientDiscordId === senderDiscordId) {
    return interaction.reply({
      content: 'You can\'t send to yourself. Pick someone else.',
      ephemeral: true,
      _autoDeleteMs: 30_000,
    });
  }

  const sender = userRepo.findByDiscordId(senderDiscordId);
  const recipient = userRepo.findByDiscordId(recipientDiscordId);
  if (!recipient) {
    return interaction.reply({
      content: 'That user isn\'t registered with the bot — they need to accept TOS in the welcome channel first.',
      ephemeral: true,
      _autoDeleteMs: 60_000,
    });
  }
  const recipientWallet = walletRepo.findByUserId(recipient.id);
  if (!recipientWallet) {
    return interaction.reply({
      content: `<@${recipientDiscordId}> hasn't set up their wallet yet, so they don't have an address to receive USDC. Ask them to click **View My Wallet** in **#my-wallet** and finish setup.`,
      ephemeral: true,
      _autoDeleteMs: 60_000,
    });
  }

  // Stash the pick so the modal-submit handler knows who's the
  // recipient (Discord doesn't carry state through Modal interactions).
  _gcPending();
  _pendingSends.set(senderDiscordId, {
    recipientDiscordId,
    recipientUserId: recipient.id,
    recipientAddress: recipientWallet.address,
    recipientLabel: recipient.server_username || recipientDiscordId,
    senderUserId: sender?.id,
    ts: Date.now(),
  });

  const modal = new ModalBuilder()
    .setCustomId('wallet_send_user_amount')
    .setTitle(`Send to ${(recipient.server_username || 'user').slice(0, 30)}`);
  const amountInput = new TextInputBuilder()
    .setCustomId('amount')
    .setLabel('Amount in USDC (e.g. 1.50)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setPlaceholder('1.00')
    .setMinLength(1)
    .setMaxLength(12);
  modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
  return interaction.showModal(modal);
}

async function handleSendUserSubmit(interaction) {
  const senderDiscordId = interaction.user.id;
  _gcPending();
  const pending = _pendingSends.get(senderDiscordId);
  if (!pending) {
    return interaction.reply({
      content: 'Send session expired — click **Send to User** again to start over.',
      ephemeral: true,
      _autoDeleteMs: 30_000,
    });
  }

  const amountStr = interaction.fields.getTextInputValue('amount').trim();
  // Accept "1", "1.5", "$1.50", "1.50 USDC" — strip non-numeric.
  const cleaned = amountStr.replace(/[^0-9.]/g, '');
  if (!cleaned || isNaN(Number(cleaned)) || Number(cleaned) <= 0) {
    return interaction.reply({
      content: `"${amountStr}" isn't a valid amount. Enter a number greater than 0 (e.g. \`1.50\`).`,
      ephemeral: true,
      _autoDeleteMs: 60_000,
    });
  }

  // Convert to USDC smallest units (6 decimals). Round down to avoid
  // "you don't have $1.0000001" off-by-1 from float math.
  const dotParts = cleaned.split('.');
  const whole = dotParts[0] || '0';
  const frac = (dotParts[1] || '').padEnd(6, '0').slice(0, 6);
  const amountUsdcSmallest = (BigInt(whole) * BigInt(USDC_PER_UNIT) + BigInt(frac)).toString();

  // Re-validate sender's balance before minting the link. They could
  // have raced a match accept that locked their funds between
  // clicking the button and submitting the modal.
  const sender = userRepo.findByDiscordId(senderDiscordId);
  if (!sender) {
    _pendingSends.delete(senderDiscordId);
    return interaction.reply({ content: 'Not registered.', ephemeral: true });
  }
  const senderWallet = walletRepo.findByUserId(sender.id);
  if (!senderWallet) {
    _pendingSends.delete(senderDiscordId);
    return interaction.reply({
      content: 'You don\'t have a wallet yet. Click **View My Wallet** to set one up.',
      ephemeral: true,
    });
  }
  if (BigInt(senderWallet.balance_available || '0') < BigInt(amountUsdcSmallest)) {
    const haveStr = (Number(senderWallet.balance_available || 0) / USDC_PER_UNIT).toFixed(2);
    return interaction.reply({
      content: `Insufficient balance. You're trying to send **$${cleaned}** but have **$${haveStr}** available.`,
      ephemeral: true,
      _autoDeleteMs: 60_000,
    });
  }

  // Mint a /withdraw link with the recipient + amount baked into
  // metadata. The web surface (WithdrawClient) reads the metadata,
  // pre-fills the destination + amount fields, and shows a
  // "Sending $X to @Username" banner so the sender knows exactly
  // what they're signing.
  let url;
  try {
    url = linkNonceService.mintLink({
      userId: sender.id,
      purpose: 'withdraw',
      ttlSeconds: 30 * 60, // 30 min — enough for a calm sign, short enough that a leaked DM link doesn't sit forever
      metadata: {
        flow: 'send-to-user',
        presetRecipient: pending.recipientAddress,
        presetRecipientLabel: pending.recipientLabel,
        presetAmountUsdcSmallest: amountUsdcSmallest,
        presetAmountUsdcDisplay: cleaned,
      },
    });
  } catch (err) {
    console.error(`[SendToUser] mintLink failed for sender ${sender.id}: ${err.message}`);
    _pendingSends.delete(senderDiscordId);
    return interaction.reply({
      content: 'Could not generate your send link. Try again in a moment.',
      ephemeral: true,
    });
  }

  _pendingSends.delete(senderDiscordId);

  const dmContent = [
    `**Send $${cleaned} USDC to <@${pending.recipientDiscordId}>**`,
    '',
    `Click the link below to confirm the transfer. Rank $ never touches your money — only you can confirm.`,
    '',
    `🔐 **${url}**`,
    '',
    `_Link valid for 30 minutes, single use._`,
  ].join('\n');

  // DM-first (link is credential-adjacent) with ephemeral fallback if
  // the user has DMs off — same policy as the existing /withdraw flow.
  try {
    const dmUser = await interaction.client.users.fetch(senderDiscordId);
    await dmUser.send({ content: dmContent });
    return interaction.reply({
      content: 'Check your DMs — I sent you the signing link.',
      ephemeral: true,
      _autoDeleteMs: 60_000,
    });
  } catch (dmErr) {
    console.log(`[SendToUser] DM blocked for sender ${sender.id}: ${dmErr.message} — using ephemeral fallback`);
    return interaction.reply({
      content: dmContent,
      ephemeral: true,
      _autoDeleteMs: 5 * 60 * 1000,
    });
  }
}

module.exports = {
  handleSendUserStart,
  handleSendUserPick,
  handleSendUserSubmit,
};
