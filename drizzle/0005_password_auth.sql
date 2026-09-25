-- Password-login foundation. Passwords are scrypt hashes; seeded users are
-- deliberately left without a password until an administrator provisions one.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
