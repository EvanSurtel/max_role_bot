-- Add UNIQUE constraint on cod_uid to prevent duplicate COD Mobile accounts.
-- The application already checks for duplicates at registration time, but
-- this DB-level constraint is the belt-and-suspenders defense against any
-- theoretical race condition in the check-then-insert pattern.
-- NULL values are allowed (users who haven't completed registration yet).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cod_uid_unique ON users(cod_uid) WHERE cod_uid IS NOT NULL AND cod_uid != '';
