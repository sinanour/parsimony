-- Make session revocation exact. app_user.tokens_invalid_before is whole epoch seconds and was compared with
-- the access token's `iat` (also whole seconds), so anything minted in the same second as a revocation
-- survived it. Revocation is now app_user.revoked_at_ms (epoch milliseconds), and every session row records
-- the millisecond it was created: a session (and so every access token bound to it) is valid only if it was
-- created strictly after the user's revocation instant.
--
-- Additive, so older code keeps working after a rollback: tokens_invalid_before stays (and is still written,
-- in seconds) and older inserts simply leave created_ms at 0, which this version treats as revoked.

ALTER TABLE app_user ADD COLUMN revoked_at_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_session ADD COLUMN created_ms INTEGER NOT NULL DEFAULT 0;

UPDATE user_session SET created_ms = CAST(ROUND((julianday(created_at) - 2440587.5) * 86400000) AS INTEGER);

-- An old revocation at second S happened somewhere within that second; treat it as its last millisecond so
-- nothing created in that second (possibly by a sign-in that overtook the revocation) is trusted. At worst
-- a session issued in that second has to sign in again.
UPDATE app_user SET revoked_at_ms = tokens_invalid_before * 1000 + 999 WHERE tokens_invalid_before > 0;

-- Drop sessions that are already unusable: their user is gone, or they predate the user's revocation.
DELETE FROM user_session WHERE NOT EXISTS (SELECT 1 FROM app_user u WHERE u.user_id = user_session.user_id);
DELETE FROM user_session
  WHERE created_ms <= (SELECT u.revoked_at_ms FROM app_user u WHERE u.user_id = user_session.user_id);
