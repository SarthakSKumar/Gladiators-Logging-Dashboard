-- auth.db — Baileys credentials + Signal key store. Kept separate from messages.db so restoring
-- message history never rolls back keys. Values are BufferJSON-serialised (binary-safe).
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE auth_creds (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, format_version INTEGER NOT NULL);
-- type is free text: every v7 key type (and any future one) is stored without code changes
CREATE TABLE auth_keys (
  type           TEXT NOT NULL,
  id             TEXT NOT NULL,
  value          TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  PRIMARY KEY (type, id)
) WITHOUT ROWID;
-- Monotonic: bumped on every auth write and never reset (also not on wipe) — used for rollback fencing.
INSERT INTO meta (key, value) VALUES ('auth_write_counter', '0');
