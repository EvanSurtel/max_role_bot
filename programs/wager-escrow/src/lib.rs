use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("11111111111111111111111111111111");

#[program]
pub mod wager_escrow {
    use super::*;

    /// One-time program initialization. Sets the authority and fee configuration.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let state = &mut ctx.accounts.program_state;
        state.authority = ctx.accounts.authority.key();
        state.bump = ctx.bumps.program_state;
        Ok(())
    }

    /// Create a new match escrow. Only callable by the program authority.
    pub fn create_match(
        ctx: Context<CreateMatch>,
        match_id: u64,
        entry_amount: u64,
        player_count: u8,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == ctx.accounts.program_state.authority,
            WagerError::Unauthorized
        );

        let escrow = &mut ctx.accounts.match_escrow;
        escrow.match_id = match_id;
        escrow.entry_amount = entry_amount;
        escrow.player_count = player_count;
        escrow.deposits_count = 0;
        escrow.total_deposited = 0;
        escrow.is_resolved = false;
        escrow.is_cancelled = false;
        escrow.bump = ctx.bumps.match_escrow;

        msg!("Match escrow created: id={}, entry={}, players={}", match_id, entry_amount, player_count);
        Ok(())
    }

    /// Deposit a player's USDC entry into the match escrow.
    /// The bot signs as authority (custodial model — bot holds player keys).
    pub fn deposit_to_escrow(ctx: Context<DepositToEscrow>, match_id: u64) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;

        require!(!escrow.is_resolved, WagerError::AlreadyResolved);
        require!(!escrow.is_cancelled, WagerError::AlreadyCancelled);
        require!(
            escrow.deposits_count < escrow.player_count,
            WagerError::AllDepositsReceived
        );

        let amount = escrow.entry_amount;

        // Transfer USDC from player's token account to escrow vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.player_token_account.to_account_info(),
                    to: ctx.accounts.escrow_token_account.to_account_info(),
                    authority: ctx.accounts.player.to_account_info(),
                },
            ),
            amount,
        )?;

        escrow.deposits_count = escrow.deposits_count.checked_add(1).ok_or(WagerError::Overflow)?;
        escrow.total_deposited = escrow.total_deposited.checked_add(amount).ok_or(WagerError::Overflow)?;

        msg!(
            "Deposit to match {}: player={}, amount={}, total={}",
            match_id,
            ctx.accounts.player.key(),
            amount,
            escrow.total_deposited
        );
        Ok(())
    }

    /// Resolve a match — distribute full pot USDC to winners.
    /// Winner token accounts are passed via remaining_accounts.
    pub fn resolve_match(
        ctx: Context<ResolveMatch>,
        match_id: u64,
        winner_amounts: Vec<u64>,
    ) -> Result<()> {
        let escrow = &ctx.accounts.match_escrow;

        require!(!escrow.is_resolved, WagerError::AlreadyResolved);
        require!(!escrow.is_cancelled, WagerError::AlreadyCancelled);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.program_state.authority,
            WagerError::Unauthorized
        );

        // Validate payout totals
        let total_payouts: u64 = winner_amounts
            .iter()
            .try_fold(0u64, |acc, &x| acc.checked_add(x))
            .ok_or(WagerError::Overflow)?;
        require!(total_payouts <= escrow.total_deposited, WagerError::InsufficientEscrow);

        // Validate remaining accounts match winner count
        let remaining = &ctx.remaining_accounts;
        require!(
            remaining.len() == winner_amounts.len(),
            WagerError::WinnerCountMismatch
        );

        // PDA signer seeds for the escrow account
        let match_id_bytes = match_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"escrow", match_id_bytes.as_ref(), &[escrow.bump]];
        let signer_seeds = &[seeds];

        // Transfer to each winner
        for (i, &amount) in winner_amounts.iter().enumerate() {
            if amount == 0 {
                continue;
            }
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_token_account.to_account_info(),
                        to: remaining[i].to_account_info(),
                        authority: ctx.accounts.match_escrow.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount,
            )?;
        }

        // Mark as resolved
        let escrow = &mut ctx.accounts.match_escrow;
        escrow.is_resolved = true;

        msg!("Match {} resolved: {} winners", match_id, winner_amounts.len());
        Ok(())
    }

    /// Cancel a match — refund USDC to players.
    /// Player token accounts are passed via remaining_accounts.
    pub fn cancel_match(
        ctx: Context<CancelMatch>,
        match_id: u64,
        refund_amounts: Vec<u64>,
    ) -> Result<()> {
        let escrow = &ctx.accounts.match_escrow;

        require!(!escrow.is_resolved, WagerError::AlreadyResolved);
        require!(!escrow.is_cancelled, WagerError::AlreadyCancelled);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.program_state.authority,
            WagerError::Unauthorized
        );

        let total_refund: u64 = refund_amounts
            .iter()
            .try_fold(0u64, |acc, &x| acc.checked_add(x))
            .ok_or(WagerError::Overflow)?;
        require!(total_refund <= escrow.total_deposited, WagerError::InsufficientEscrow);

        let remaining = &ctx.remaining_accounts;
        require!(
            remaining.len() == refund_amounts.len(),
            WagerError::RefundCountMismatch
        );

        let match_id_bytes = match_id.to_le_bytes();
        let seeds: &[&[u8]] = &[b"escrow", match_id_bytes.as_ref(), &[escrow.bump]];
        let signer_seeds = &[seeds];

        for (i, &amount) in refund_amounts.iter().enumerate() {
            if amount == 0 {
                continue;
            }
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_token_account.to_account_info(),
                        to: remaining[i].to_account_info(),
                        authority: ctx.accounts.match_escrow.to_account_info(),
                    },
                    signer_seeds,
                ),
                amount,
            )?;
        }

        let escrow = &mut ctx.accounts.match_escrow;
        escrow.is_cancelled = true;

        msg!("Match {} cancelled: {} refunds", match_id, refund_amounts.len());
        Ok(())
    }
}

// ─── Account Structs ─────────────────────────────────────────────

/// Global program state — stores authority.
#[account]
pub struct ProgramState {
    pub authority: Pubkey,
    pub bump: u8,
}

impl ProgramState {
    pub const SIZE: usize = 8 + 32 + 1; // discriminator + fields
}

/// Per-match escrow account.
#[account]
pub struct MatchEscrow {
    pub match_id: u64,
    pub entry_amount: u64,
    pub player_count: u8,
    pub deposits_count: u8,
    pub total_deposited: u64,
    pub is_resolved: bool,
    pub is_cancelled: bool,
    pub bump: u8,
}

impl MatchEscrow {
    pub const SIZE: usize = 8 + 8 + 8 + 1 + 1 + 8 + 1 + 1 + 1; // discriminator + fields
}

// ─── Instruction Contexts ────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = ProgramState::SIZE,
        seeds = [b"state"],
        bump,
    )]
    pub program_state: Account<'info, ProgramState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: u64, entry_amount: u64, player_count: u8)]
pub struct CreateMatch<'info> {
    #[account(
        init,
        payer = authority,
        space = MatchEscrow::SIZE,
        seeds = [b"escrow", match_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub match_escrow: Account<'info, MatchEscrow>,

    #[account(seeds = [b"state"], bump = program_state.bump)]
    pub program_state: Account<'info, ProgramState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct DepositToEscrow<'info> {
    #[account(
        mut,
        seeds = [b"escrow", match_id.to_le_bytes().as_ref()],
        bump = match_escrow.bump,
    )]
    pub match_escrow: Account<'info, MatchEscrow>,

    /// The player's USDC token account (source).
    #[account(mut)]
    pub player_token_account: Account<'info, TokenAccount>,

    /// The escrow's USDC token account (destination).
    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// The player signs the transfer (bot holds the key).
    pub player: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct ResolveMatch<'info> {
    #[account(
        mut,
        seeds = [b"escrow", match_id.to_le_bytes().as_ref()],
        bump = match_escrow.bump,
    )]
    pub match_escrow: Account<'info, MatchEscrow>,

    #[account(seeds = [b"state"], bump = program_state.bump)]
    pub program_state: Account<'info, ProgramState>,

    /// The escrow's USDC token account.
    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// Authority must match program_state.authority.
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(match_id: u64)]
pub struct CancelMatch<'info> {
    #[account(
        mut,
        seeds = [b"escrow", match_id.to_le_bytes().as_ref()],
        bump = match_escrow.bump,
    )]
    pub match_escrow: Account<'info, MatchEscrow>,

    #[account(seeds = [b"state"], bump = program_state.bump)]
    pub program_state: Account<'info, ProgramState>,

    /// The escrow's USDC token account.
    #[account(mut)]
    pub escrow_token_account: Account<'info, TokenAccount>,

    /// Authority must match program_state.authority.
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ─── Error Codes ─────────────────────────────────────────────────

#[error_code]
pub enum WagerError {
    #[msg("Match has already been resolved")]
    AlreadyResolved,
    #[msg("Match has already been cancelled")]
    AlreadyCancelled,
    #[msg("All player deposits have been received")]
    AllDepositsReceived,
    #[msg("Deposit amount does not match entry amount")]
    InvalidAmount,
    #[msg("Insufficient funds in escrow")]
    InsufficientEscrow,
    #[msg("Winner count does not match amounts provided")]
    WinnerCountMismatch,
    #[msg("Refund count does not match amounts provided")]
    RefundCountMismatch,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Unauthorized: caller is not the program authority")]
    Unauthorized,
}
