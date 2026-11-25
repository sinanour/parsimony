-- Never reuse a user id. With a plain INTEGER PRIMARY KEY, SQLite hands the highest deleted id to the next
-- user, so a write that was in flight for a deleted account (or a stale id in a request) could land on a
-- newly created one, and old sessions/audit rows would point at the wrong person. AUTOINCREMENT ids only grow.
--
-- Rebuild the table keeping every row and id (foreign_keys is OFF, so user_session/audit_log rows that refer
-- to user_id are untouched).

CREATE TABLE app_user_new (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMINISTRATOR', 'EDITOR', 'READ_ONLY')),
  -- Access tokens issued before this instant (epoch seconds) are rejected.
  tokens_invalid_before INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO app_user_new (user_id, email, display_name, password_hash, role, tokens_invalid_before, last_login_at, created_at, updated_at)
  SELECT user_id, email, display_name, password_hash, role, tokens_invalid_before, last_login_at, created_at, updated_at FROM app_user;

DROP TABLE app_user;
ALTER TABLE app_user_new RENAME TO app_user;

-- Start numbering after every id that was ever used: current users, and deleted users that still appear in
-- sessions or the audit log, so history never points at a different person.
DELETE FROM sqlite_sequence WHERE name IN ('app_user', 'app_user_new');
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'app_user', MAX(
    COALESCE((SELECT MAX(user_id) FROM app_user), 0),
    COALESCE((SELECT MAX(user_id) FROM user_session), 0),
    COALESCE((SELECT MAX(user_id) FROM audit_log), 0)
  );
