-- Stop the access token from revealing the refresh cookie's session id, and remember superseded refresh
-- secrets so reuse detection no longer has to guess.
--
-- access_key: a random, per-session value that the access token's `sk` claim carries instead of the raw
-- session id (which is the first half of the refresh cookie). It has no relation to session_id, so a leaked
-- access token, even an expired one, can't be turned into a cookie value. Existing sessions have none yet;
-- they get one on their next refresh, and their old access tokens (which carried the raw id) are refused,
-- which the SPA answers with a transparent refresh.
--
-- user_session_superseded: hashes of refresh secrets a session has rotated away from (a bounded number per
-- session). Presenting one of those is the only thing treated as token theft; any other wrong secret is
-- simply refused, without touching the session.
--
-- Additive, so older code keeps working after a rollback (it ignores both).

ALTER TABLE user_session ADD COLUMN access_key TEXT;
CREATE UNIQUE INDEX user_session_access_key_IDX ON user_session (access_key);

CREATE TABLE user_session_superseded (
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  superseded_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, token_hash)
);

INSERT OR IGNORE INTO user_session_superseded (session_id, token_hash, superseded_at)
  SELECT session_id, prev_token_hash, COALESCE(rotated_at, 0) FROM user_session WHERE prev_token_hash IS NOT NULL;

-- foreign_keys is OFF, so clean up with a trigger: however a session row goes (sign-out, revocation, user
-- deletion, the users CLI, startup sweep), its history goes with it.
CREATE TRIGGER user_session_superseded_cleanup AFTER DELETE ON user_session
BEGIN
  DELETE FROM user_session_superseded WHERE session_id = OLD.session_id;
END;
