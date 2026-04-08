-- User language preference for full bot translation
ALTER TABLE users ADD COLUMN language TEXT NOT NULL DEFAULT 'en';
