-- Users, sessions and audit log for multi-user access.

CREATE TABLE app_user (
  user_id INTEGER PRIMARY KEY,
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

CREATE TABLE user_session (
  session_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES app_user (user_id),
  -- SHA-256 of the current refresh-token secret; rotated on every refresh.
  token_hash TEXT NOT NULL,
  -- The previous hash stays acceptable for a few seconds after rotation, so two tabs that
  -- refresh at the same moment don't trip reuse detection.
  prev_token_hash TEXT,
  rotated_at INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX user_session_user_IDX ON user_session (user_id);

CREATE TABLE audit_log (
  audit_idx INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_id INTEGER,
  user_email TEXT,
  action TEXT NOT NULL,
  method TEXT,
  path TEXT,
  status INTEGER,
  ip TEXT,
  details TEXT
);
CREATE INDEX audit_log_at_IDX ON audit_log (at);

-- Lets statement imports pick an account from the uploaded file's name
-- (for bank formats that don't include account numbers).
ALTER TABLE account ADD COLUMN statement_file_pattern TEXT;
