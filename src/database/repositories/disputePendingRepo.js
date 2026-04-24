// Pending dispute resolutions — see migration 023.
//
// A match resolved via admin dispute flow delays the on-chain
// WagerEscrow.resolveMatch call by 36 hours. During the hold, the
// funds stay in the escrow contract so the winner can't withdraw
// them. At release time, a timer fires and the bot calls
// resolveMatch on-chain, transferring winnings to the winners' own
// Smart Wallets.

const db = require('../db');

const stmts = {
  insert: db.prepare(`
    INSERT INTO dispute_pending_resolutions
      (match_id, challenge_id, winning_player_ids, total_pot_usdc, release_at)
    VALUES
      (@matchId, @challengeId, @winningPlayerIds, @totalPotUsdc, @releaseAt)
    RETURNING *
  `),
  findById: db.prepare('SELECT * FROM dispute_pending_resolutions WHERE id = ?'),
  findByMatchId: db.prepare('SELECT * FROM dispute_pending_resolutions WHERE match_id = ?'),
  findPending: db.prepare(`
    SELECT * FROM dispute_pending_resolutions
    WHERE status = 'pending'
    ORDER BY release_at ASC
  `),
  markReleased: db.prepare(`
    UPDATE dispute_pending_resolutions
    SET status = 'released',
        tx_hash = @txHash,
        updated_at = datetime('now')
    WHERE id = @id
  `),
  markFailed: db.prepare(`
    UPDATE dispute_pending_resolutions
    SET status = 'failed',
        updated_at = datetime('now')
    WHERE id = @id
  `),
  markCancelled: db.prepare(`
    UPDATE dispute_pending_resolutions
    SET status = 'cancelled',
        updated_at = datetime('now')
    WHERE id = @id
  `),
};

const disputePendingRepo = {
  create({ matchId, challengeId, winningPlayerIds, totalPotUsdc, releaseAt }) {
    return stmts.insert.get({
      matchId,
      challengeId,
      winningPlayerIds: JSON.stringify(winningPlayerIds),
      totalPotUsdc: String(totalPotUsdc),
      releaseAt,
    });
  },

  findById(id) {
    return stmts.findById.get(id) || null;
  },

  findByMatchId(matchId) {
    return stmts.findByMatchId.get(matchId) || null;
  },

  /** Rows in 'pending' status, ordered by release_at ascending. Used
   *  by the sweeper to catch any rows whose scheduled timer got lost
   *  to a restart before the persistent-timer system recovered them. */
  findPending() {
    return stmts.findPending.all();
  },

  markReleased(id, txHash) {
    return stmts.markReleased.run({ id, txHash });
  },

  markFailed(id) {
    return stmts.markFailed.run({ id });
  },

  markCancelled(id) {
    return stmts.markCancelled.run({ id });
  },
};

module.exports = disputePendingRepo;
