-- 010: Add ISO country code column for Changelly API
ALTER TABLE users ADD COLUMN country_code TEXT DEFAULT '';
