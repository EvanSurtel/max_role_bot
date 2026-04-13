// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title WagerEscrow
 * @notice Match escrow for USDC wagers on Base. Ported from the Anchor
 *         (Solana) contract at programs/wager-escrow/src/lib.rs.
 *
 * Architecture:
 *   - Each user has their own wallet. The bot signs on their behalf.
 *   - Before any match, each user's wallet must have approved this
 *     contract to spend their USDC via ERC-20 approve().
 *   - createMatch: bot creates a match record on-chain.
 *   - depositToEscrow: bot calls transferFrom to pull each player's
 *     entry amount into this contract.
 *   - resolveMatch: bot (owner) distributes the pot to winners.
 *   - cancelMatch: bot (owner) refunds all locked USDC to players.
 *
 * Every state change emits an event with the matchId so the full
 * history is queryable on BaseScan.
 */
contract WagerEscrow is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    struct Match {
        uint256 entryAmount;     // USDC per player (6 decimals)
        uint8   playerCount;     // expected total players
        uint8   depositsCount;   // how many have deposited so far
        uint256 totalDeposited;  // running total USDC in escrow for this match
        bool    resolved;
        bool    cancelled;
    }

    // matchId → Match
    mapping(uint256 => Match) public matches;

    // matchId → player address → whether they deposited
    mapping(uint256 => mapping(address => bool)) public hasDeposited;

    // ─── Events ─────────────────────────────────────────────────

    event MatchCreated(uint256 indexed matchId, uint256 entryAmount, uint8 playerCount);
    event Deposited(uint256 indexed matchId, address indexed player, uint256 amount);
    event MatchResolved(uint256 indexed matchId, address[] winners, uint256[] amounts);
    event MatchCancelled(uint256 indexed matchId, address[] players, uint256[] refunds);

    // ─── Constructor ────────────────────────────────────────────

    /**
     * @param _usdc The native USDC contract on Base.
     *              Mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
     */
    constructor(address _usdc) Ownable(msg.sender) {
        require(_usdc != address(0), "USDC address cannot be zero");
        usdc = IERC20(_usdc);
    }

    // ─── Create Match ───────────────────────────────────────────

    /**
     * @notice Create a new match escrow. Only callable by the bot (owner).
     * @param matchId   Unique match identifier (maps to the DB match ID).
     * @param entryAmount USDC per player in smallest units (6 decimals).
     * @param playerCount Total expected player deposits.
     */
    function createMatch(
        uint256 matchId,
        uint256 entryAmount,
        uint8 playerCount
    ) external onlyOwner {
        require(matches[matchId].entryAmount == 0, "Match already exists");
        require(entryAmount > 0, "Entry must be > 0");
        require(playerCount >= 2, "Need at least 2 players");

        matches[matchId] = Match({
            entryAmount: entryAmount,
            playerCount: playerCount,
            depositsCount: 0,
            totalDeposited: 0,
            resolved: false,
            cancelled: false
        });

        emit MatchCreated(matchId, entryAmount, playerCount);
    }

    // ─── Deposit ────────────────────────────────────────────────

    /**
     * @notice Pull a player's USDC entry into escrow via transferFrom.
     *         The player's wallet must have previously approved this
     *         contract for at least entryAmount on the USDC contract.
     *         Called by the bot (owner) on behalf of the player.
     * @param matchId The match to deposit into.
     * @param player  The player's wallet address.
     */
    function depositToEscrow(
        uint256 matchId,
        address player
    ) external onlyOwner nonReentrant {
        Match storage m = matches[matchId];
        require(m.entryAmount > 0, "Match does not exist");
        require(!m.resolved, "Match already resolved");
        require(!m.cancelled, "Match already cancelled");
        require(m.depositsCount < m.playerCount, "All deposits received");
        require(!hasDeposited[matchId][player], "Player already deposited");

        uint256 amount = m.entryAmount;

        // Pull USDC from the player's wallet into this contract.
        // Requires prior ERC-20 approve() from the player's wallet.
        usdc.safeTransferFrom(player, address(this), amount);

        m.depositsCount += 1;
        m.totalDeposited += amount;
        hasDeposited[matchId][player] = true;

        emit Deposited(matchId, player, amount);
    }

    // ─── Resolve ────────────────────────────────────────────────

    /**
     * @notice Distribute the pot to winners. Only callable by owner.
     *         Total payouts must not exceed totalDeposited.
     * @param matchId  The match to resolve.
     * @param winners  Array of winner wallet addresses.
     * @param amounts  Array of USDC amounts (same length as winners).
     */
    function resolveMatch(
        uint256 matchId,
        address[] calldata winners,
        uint256[] calldata amounts
    ) external onlyOwner nonReentrant {
        Match storage m = matches[matchId];
        require(m.entryAmount > 0, "Match does not exist");
        require(!m.resolved, "Already resolved");
        require(!m.cancelled, "Already cancelled");
        require(winners.length == amounts.length, "Length mismatch");
        require(winners.length > 0, "No winners");

        uint256 totalPayout;
        for (uint256 i = 0; i < amounts.length; i++) {
            totalPayout += amounts[i];
        }
        require(totalPayout <= m.totalDeposited, "Payout exceeds escrow");

        m.resolved = true;

        for (uint256 i = 0; i < winners.length; i++) {
            if (amounts[i] > 0) {
                usdc.safeTransfer(winners[i], amounts[i]);
            }
        }

        emit MatchResolved(matchId, winners, amounts);
    }

    // ─── Cancel ─────────────────────────────────────────────────

    /**
     * @notice Refund all locked USDC to players. Only callable by owner.
     * @param matchId  The match to cancel.
     * @param players  Array of player wallet addresses to refund.
     * @param refunds  Array of USDC amounts to refund (same length).
     */
    function cancelMatch(
        uint256 matchId,
        address[] calldata players,
        uint256[] calldata refunds
    ) external onlyOwner nonReentrant {
        Match storage m = matches[matchId];
        require(m.entryAmount > 0, "Match does not exist");
        require(!m.resolved, "Already resolved");
        require(!m.cancelled, "Already cancelled");
        require(players.length == refunds.length, "Length mismatch");

        uint256 totalRefund;
        for (uint256 i = 0; i < refunds.length; i++) {
            totalRefund += refunds[i];
        }
        require(totalRefund <= m.totalDeposited, "Refund exceeds escrow");

        m.cancelled = true;

        for (uint256 i = 0; i < players.length; i++) {
            if (refunds[i] > 0) {
                usdc.safeTransfer(players[i], refunds[i]);
            }
        }

        emit MatchCancelled(matchId, players, refunds);
    }

    // ─── Emergency Withdraw ────────────────────────────────────

    /**
     * @notice Emergency withdraw any USDC stuck in the contract.
     *         Only callable by owner. Use this if a match gets stuck
     *         (never resolved or cancelled) and USDC is stranded.
     * @param to     Address to send the USDC to.
     * @param amount Amount of USDC to withdraw.
     */
    function emergencyWithdraw(
        address to,
        uint256 amount
    ) external onlyOwner nonReentrant {
        require(to != address(0), "Cannot send to zero address");
        require(amount > 0, "Amount must be > 0");
        require(amount <= usdc.balanceOf(address(this)), "Exceeds contract balance");
        usdc.safeTransfer(to, amount);
        emit EmergencyWithdraw(to, amount);
    }

    event EmergencyWithdraw(address indexed to, uint256 amount);

    // ─── View Helpers ───────────────────────────────────────────

    function getMatch(uint256 matchId) external view returns (Match memory) {
        return matches[matchId];
    }

    function getContractUsdcBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}
