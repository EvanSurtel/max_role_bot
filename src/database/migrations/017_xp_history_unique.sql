-- UNIQUE constraint on xp_history to prevent double-awarding XP.
--
-- Prior to this migration, xp_history had indexes but no uniqueness
-- guarantee. Two paths could (in theory) insert duplicate rows for the
-- same (user_id, match_id, match_type):
--   - queue resolveMatch (matchLifecycle.js) if called twice
--   - wager awardStats   (match/helpers.js) if resolveMatch re-ran
--
-- resolveMatch now has atomic status claims that make double-resolve
-- extremely unlikely, but the DB-level UNIQUE is the belt-and-suspenders
-- defense: if somehow both run, the INSERT throws, the per-player
-- db.transaction wraps roll back atomically, and the leaderboard
-- (which sums xp_history) is never double-counted.
--
-- match_id is NULL for admin_adjust rows — admins can repeatedly adjust
-- a user's XP, so those must remain non-unique. The partial WHERE
-- clause excludes them from the constraint.
--
-- If dedupe is ever needed (existing prod data already has dupes), run
-- the cleanup below manually before this index will create. For a
-- fresh DB the cleanup is a no-op.

-- Remove any pre-existing duplicates: keep the lowest id per
-- (user_id, match_id, match_type) tuple with non-null match_id.
DELETE FROM xp_history
WHERE match_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id) FROM xp_history
    WHERE match_id IS NOT NULL
    GROUP BY user_id, match_id, match_type
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_history_unique_match
  ON xp_history(user_id, match_id, match_type)
  WHERE match_id IS NOT NULL;
