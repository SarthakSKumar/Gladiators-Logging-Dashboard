-- Google Sheets forwarding (custom integration for the two Gladiators groups, src/integrations/sheets.js).
-- One row per logged message that must reach an Apps Script endpoint. `row_id` is the per-session,
-- arrival-ordered number sent as "id": the script writes it to row id + 2 of sheet "RACE <raceNumber>",
-- so a retry rewrites the same row instead of adding a duplicate.
CREATE TABLE sheet_outbox (
  id              INTEGER PRIMARY KEY,
  message_seq     INTEGER NOT NULL UNIQUE REFERENCES messages(seq),
  session_id      INTEGER NOT NULL REFERENCES sessions(id),
  target          TEXT NOT NULL,                 -- key of the target in config/sheets.json
  row_id          INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,                 -- exactly what is POSTed (Android app format)
  status          TEXT NOT NULL CHECK (status IN ('pending','sent','failed','skipped')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  response        TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  UNIQUE (session_id, row_id)
);
CREATE INDEX sheet_outbox_due ON sheet_outbox (status, next_attempt_at);
