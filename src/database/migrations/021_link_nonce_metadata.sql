-- Adds a free-form JSON metadata column to discord_link_nonces so a
-- single nonce can carry purpose-specific context (e.g. for CDP Onramp
-- minting on the web surface, the desired USDC amount + country need
-- to ride alongside the user identity, but we don't want them in the
-- query string where the user could tamper with the value before it
-- ever hits CDP).
--
-- Stored as TEXT (SQLite has no native JSON type); callers are
-- responsible for JSON.stringify on write and JSON.parse on read.

ALTER TABLE discord_link_nonces ADD COLUMN metadata TEXT;
