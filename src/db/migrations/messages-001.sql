-- messages.db — captured history, sessions, gaps, web auth. Never auto-purged (retention: forever).
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE groups (
  id              INTEGER PRIMARY KEY,
  config_key      TEXT NOT NULL UNIQUE,
  label           TEXT NOT NULL,
  jid             TEXT UNIQUE,
  subject_current TEXT,
  status          TEXT NOT NULL DEFAULT 'unresolved'
                  CHECK (status IN ('unresolved','resolved','ambiguous','missing','inaccessible')),
  candidates_json TEXT,
  action          TEXT,
  pinned          INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 1,
  resolved_at     INTEGER,
  last_message_at INTEGER,
  updated_at      INTEGER NOT NULL
);

-- Original rows are immutable; edits/revokes/late decryption are appended to message_events.
CREATE TABLE messages (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,   -- ingest order: stream + future export cursor
  jseq             INTEGER NOT NULL,                    -- journal position it was applied from
  group_id         INTEGER NOT NULL REFERENCES groups(id),
  chat_jid         TEXT NOT NULL,
  wa_msg_id        TEXT NOT NULL,
  from_me          INTEGER NOT NULL DEFAULT 0,
  sender_jid       TEXT,
  sender_pn        TEXT,
  push_name        TEXT,
  wa_timestamp     INTEGER NOT NULL,                    -- ms UTC, sender-claimed send time (whole seconds)
  received_at      INTEGER NOT NULL,                    -- ms UTC, our clock at journal write
  skew_flag        INTEGER NOT NULL DEFAULT 0,
  source           TEXT NOT NULL CHECK (source IN ('live','offline','history','resend')),
  msg_type         TEXT NOT NULL,
  body             TEXT,
  quoted_wa_msg_id TEXT,
  quoted_body      TEXT,
  raw_json         TEXT NOT NULL,
  parse_version    INTEGER NOT NULL,
  UNIQUE (chat_jid, wa_msg_id)                          -- idempotency key (deliberately sender-free: LID/PN)
);
CREATE INDEX messages_group_ts  ON messages (group_id, wa_timestamp, seq);
CREATE INDEX messages_group_seq ON messages (group_id, seq);

CREATE TABLE message_events (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  jseq             INTEGER NOT NULL,
  group_id         INTEGER NOT NULL REFERENCES groups(id),
  chat_jid         TEXT NOT NULL,
  target_wa_msg_id TEXT NOT NULL,                       -- no FK: an edit may arrive before its original
  event_type       TEXT NOT NULL CHECK (event_type IN ('edit','revoke','content_resolved')),
  new_body         TEXT,
  actor_jid        TEXT,
  event_ts         INTEGER NOT NULL,
  received_at      INTEGER NOT NULL,
  raw_json         TEXT,
  event_key        TEXT NOT NULL UNIQUE
);
CREATE INDEX events_target ON message_events (chat_jid, target_wa_msg_id);

-- Group messages journaled while a configured group was unresolved (never silently dropped).
CREATE TABLE pending_scope (
  jseq        INTEGER PRIMARY KEY,
  chat_jid    TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  record_json TEXT NOT NULL
);
CREATE INDEX pending_scope_chat ON pending_scope (chat_jid);

CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY,
  group_id     INTEGER NOT NULL REFERENCES groups(id),
  label        TEXT NOT NULL CHECK (length(trim(label)) > 0),
  race_number  INTEGER CHECK (race_number IS NULL OR race_number BETWEEN 1 AND 10),
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  started_by   TEXT,
  ended_by     TEXT,
  ended_reason TEXT,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX sessions_one_active ON sessions (group_id) WHERE ended_at IS NULL;

CREATE TABLE connection_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, state TEXT NOT NULL, code INTEGER, detail TEXT);

CREATE TABLE capture_gaps (
  id                 INTEGER PRIMARY KEY,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  cause              TEXT NOT NULL,
  recovered_messages INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL CHECK (status IN ('open','recovered','unverified')),
  note               TEXT
);

CREATE TABLE contacts (jid TEXT PRIMARY KEY, push_name TEXT, pn_jid TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE member_tags (group_jid TEXT NOT NULL, participant TEXT NOT NULL, label TEXT, updated_at INTEGER NOT NULL,
                          PRIMARY KEY (group_jid, participant));

CREATE TABLE web_sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL,
                           expires_at INTEGER NOT NULL, ip TEXT, ua TEXT);
CREATE TABLE otps (email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
                   attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE auth_events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, email TEXT, event TEXT NOT NULL, ip TEXT, detail TEXT);
