-- Google Sheets call log: one row per request to the Apps Script endpoint (every attempt, success or not),
-- with the exact request body and the script's answer. Kept for good (like messages); the dashboard reads it.
CREATE TABLE sheet_calls (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  outbox_id   INTEGER NOT NULL,
  target      TEXT NOT NULL,
  session_id  INTEGER NOT NULL,
  row_id      INTEGER NOT NULL,
  attempt     INTEGER NOT NULL,
  request     TEXT NOT NULL,                       -- exact JSON body that was POSTed
  http_status INTEGER,                             -- final status after the 302 redirect (NULL if no response)
  redirected  INTEGER NOT NULL DEFAULT 0,
  host        TEXT,
  duration_ms INTEGER,
  result      TEXT NOT NULL CHECK (result IN ('sent','rejected','config_error','network_error')),
  error       TEXT,
  response    TEXT                                 -- script's reply (first 2000 chars)
);
CREATE INDEX sheet_calls_outbox ON sheet_calls (outbox_id);
