const { SlashCommandBuilder } = require('discord.js');
const userRepo = require('../database/repositories/userRepo');
const walletRepo = require('../database/repositories/walletRepo');
const transactionRepo = require('../database/repositories/transactionRepo');
const walletManager = require('../xrp/walletManager');
const transactionService = require('../xrp/transactionService');
const { walletEmbed } = require('../utils/embeds');
const { XRP_DROPS_PER_XRP, TRANSACTION_TYPE } = require('../config/constants');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Manage your XRP wallet')
    .addSubcommand(sub =>
      sub.setName('balance').setDescription('Check your wallet balance'),
    )
    .addSubcommand(sub =>
      sub.setName('deposit').setDescription('Get your deposit address'),
    )
    .addSubcommand(sub =>
      sub
        .setName('withdraw')
        .setDescription('Withdraw XRP to an external address')
        .addStringOption(opt =>
          opt.setName('address').setDescription('Destination XRP address').setRequired(true),
        )
        .addNumberOption(opt =>
          opt.setName('amount').setDescription('Amount in XRP to withdraw').setRequired(true),
        ),
    )
    .addSubcommand(sub =>
      sub.setName('history').setDescription('View recent transactions'),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // Look up user
    const user = userRepo.findByDiscordId(interaction.user.id);
    if (!user) {
      return interaction.reply({
        content: 'You need to complete onboarding first. A wallet will be created when you join the server and accept the Terms of Service.',
        ephemeral: true,
      });
    }

    const wallet = walletRepo.findByUserId(user.id);
    if (!wallet) {
      return interaction.reply({
        content: 'Your wallet has not been set up yet. Please contact an administrator.',
        ephemeral: true,
      });
    }

    switch (sub) {
      case 'balance': {
        const embed = walletEmbed(wallet, interaction.user);
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      case 'deposit': {
        return interaction.reply({
          content: `**Your XRP Deposit Address:**\n\`\`\`\n${wallet.xrp_address}\n\`\`\`\nSend XRP to this address to fund your wager wallet. Deposits are detected automatically.\n\n⚠️ **Important:** Only send XRP on the XRP Ledger. Do not send other tokens.`,
          ephemeral: true,
        });
      }

      case 'withdraw': {
        const address = interaction.options.getString('address');
        const amountXrp = interaction.options.getNumber('amount');

        // Validate address
        if (!walletManager.isAddressValid(address)) {
          return interaction.reply({
            content: 'Invalid XRP address. Please check the address and try again.',
            ephemeral: true,
          });
        }

        // Validate amount
        if (amountXrp <= 0) {
          return interaction.reply({
            content: 'Withdrawal amount must be greater than 0.',
            ephemeral: true,
          });
        }

        const amountDrops = Math.floor(amountXrp * XRP_DROPS_PER_XRP);
        const availableDrops = Number(wallet.balance_available);

        if (amountDrops > availableDrops) {
          const availableXrp = (availableDrops / XRP_DROPS_PER_XRP).toFixed(6).replace(/\.?0+$/, '');
          return interaction.reply({
            content: `Insufficient balance. You have **${availableXrp} XRP** available.`,
            ephemeral: true,
          });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
          // Get the user's wallet for signing
          const senderWallet = walletManager.getWalletFromSeed(
            wallet.encrypted_seed,
            wallet.encryption_iv,
            wallet.encryption_tag,
          );

          // Send payment
          const { txHash } = await transactionService.sendPayment(
            senderWallet,
            address,
            amountDrops.toString(),
            `Withdrawal by ${interaction.user.tag}`,
          );

          // Update balance in DB
          const newAvailable = (availableDrops - amountDrops).toString();
          walletRepo.updateBalance(user.id, {
            balanceAvailable: newAvailable,
            balanceHeld: wallet.balance_held,
          });

          // Record transaction
          transactionRepo.create({
            type: TRANSACTION_TYPE.WITHDRAWAL,
            userId: user.id,
            amountDrops: amountDrops.toString(),
            xrplTxHash: txHash,
            fromAddress: wallet.xrp_address,
            toAddress: address,
            status: 'completed',
            memo: `Withdrawal of ${amountXrp} XRP`,
          });

          const xrpFormatted = (amountDrops / XRP_DROPS_PER_XRP).toFixed(6).replace(/\.?0+$/, '');
          return interaction.editReply({
            content: `**Withdrawal successful!**\n\nSent **${xrpFormatted} XRP** to \`${address}\`\nTransaction: \`${txHash}\``,
          });
        } catch (err) {
          console.error('[Wallet] Withdrawal error:', err);
          return interaction.editReply({
            content: 'Withdrawal failed. Please try again later or contact support.',
          });
        }
      }

      case 'history': {
        const transactions = transactionRepo.findByUserId(user.id);
        const recent = transactions.slice(-10).reverse();

        if (recent.length === 0) {
          return interaction.reply({
            content: 'No transactions found.',
            ephemeral: true,
          });
        }

        const lines = recent.map((tx, i) => {
          const amountXrp = (Number(tx.amount_drops) / XRP_DROPS_PER_XRP).toFixed(6).replace(/\.?0+$/, '');
          const date = tx.created_at ? tx.created_at.slice(0, 10) : 'N/A';
          const icon = tx.type === 'deposit' ? '📥' : tx.type === 'withdrawal' ? '📤' : '🔄';
          return `${i + 1}. ${icon} **${tx.type}** — ${amountXrp} XRP — ${tx.status} — ${date}`;
        });

        return interaction.reply({
          content: `**Recent Transactions:**\n\n${lines.join('\n')}`,
          ephemeral: true,
        });
      }
    }
  },
};
