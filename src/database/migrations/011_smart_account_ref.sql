-- 011: Add smart_account_ref column for CDP Smart Account name.
-- With Smart Accounts (ERC-4337):
--   account_ref      = owner EOA account name (for getOrCreateAccount)
--   smart_account_ref = Smart Account name (for getOrCreateSmartAccount)
-- For legacy EOA-only wallets, smart_account_ref is NULL.
ALTER TABLE wallets ADD COLUMN smart_account_ref TEXT DEFAULT NULL;
