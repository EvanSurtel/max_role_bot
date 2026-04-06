const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Keypair } = require('@solana/web3.js');
const { getSolBalance, getUsdcBalance } = require('../solana/walletManager');
const { LAMPORTS_PER_SOL, USDC_PER_UNIT } = require('../config/constants');

function getEscrowAddress() {
  const secretKeyJson = process.env.ESCROW_WALLET_SECRET;
  if (!secretKeyJson) return null;
  try {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyJson)));
    return kp.publicKey.toBase58();
  } catch {
    return null;
  }
}

async function buildEscrowPanel() {
  const address = getEscrowAddress();
  if (!address) {
    return {
      embeds: [new EmbedBuilder().setTitle('Escrow Wallet').setColor(0xe74c3c).setDescription('ESCROW_WALLET_SECRET not configured.')],
      components: [],
    };
  }

  let solBalance = '0';
  let usdcBalance = '0';
  try { solBalance = await getSolBalance(address); } catch { /* */ }
  try { usdcBalance = await getUsdcBalance(address); } catch { /* */ }

  const solFormatted = (Number(solBalance) / LAMPORTS_PER_SOL).toFixed(6);
  const usdcFormatted = (Number(usdcBalance) / USDC_PER_UNIT).toFixed(2);

  const db = require('../database/db');
  const activeMatches = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status IN ('active', 'voting')").get()?.c || 0;
  const disputedMatches = db.prepare("SELECT COUNT(*) as c FROM matches WHERE status = 'disputed'").get()?.c || 0;
  const totalUsers = db.prepare("SELECT COUNT(*) as c FROM users WHERE accepted_tos = 1").get()?.c || 0;
  const activatedWallets = db.prepare("SELECT COUNT(*) as c FROM wallets WHERE is_activated = 1").get()?.c || 0;

  const embed = new EmbedBuilder()
    .setTitle('Escrow Wallet')
    .setColor(0x2ecc71)
    .setDescription(`**Address:**\n${address}`)
    .addFields(
      { name: 'SOL Balance', value: `${solFormatted} SOL`, inline: true },
      { name: 'USDC Balance', value: `$${usdcFormatted} USDC`, inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: 'Active Matches', value: `${activeMatches}`, inline: true },
      { name: 'Disputed Matches', value: `${disputedMatches}`, inline: true },
      { name: 'Registered Users', value: `${totalUsers}`, inline: true },
      { name: 'Activated Wallets', value: `${activatedWallets}`, inline: true },
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('escrow_refresh')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('escrow_copy_address')
      .setLabel('Copy Address')
      .setStyle(ButtonStyle.Success),
  );

  return { embeds: [embed], components: [row] };
}

async function postEscrowPanel(client) {
  const channelId = process.env.ESCROW_CHANNEL_ID;
  if (!channelId) {
    console.warn('[Panel] ESCROW_CHANNEL_ID not set — skipping escrow panel');
    return;
  }

  const channel = client.channels.cache.get(channelId);
  if (!channel) return;

  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    for (const [, m] of messages) {
      if (m.author.id === client.user.id) {
        try { await m.delete(); } catch { /* */ }
      }
    }
    const panel = await buildEscrowPanel();
    await channel.send(panel);
    console.log('[Panel] Posted escrow panel');
  } catch (err) {
    console.error('[Panel] Failed to post escrow panel:', err.message);
  }
}

async function handleEscrowButton(interaction) {
  const id = interaction.customId;

  // Admin only
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (adminRoleId && !interaction.member.roles.cache.has(adminRoleId)) {
    return interaction.reply({ content: 'Admin only.', ephemeral: true });
  }

  if (id === 'escrow_refresh') {
    const panel = await buildEscrowPanel();
    return interaction.update(panel);
  }

  if (id === 'escrow_copy_address') {
    const address = getEscrowAddress();
    return interaction.reply({ content: address || 'Not configured', ephemeral: true });
  }
}

module.exports = { postEscrowPanel, handleEscrowButton };
