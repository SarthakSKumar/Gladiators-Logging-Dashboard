-- Typed operator events: every error/warning that matters to an operator is stored here and pushed
-- live to the dashboard (SSE "opevent"). Repeats of the same code+message within a minute are
-- coalesced into one row (count/last_ts) so the UI is not spammed.
CREATE TABLE ops_events (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  last_ts      INTEGER NOT NULL,
  level        TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  code         TEXT NOT NULL,
  message      TEXT NOT NULL,
  context_json TEXT,
  noise        INTEGER NOT NULL DEFAULT 0,   -- expected/benign (e.g. 515 restart): logged, never toasted
  count        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX ops_events_ts ON ops_events (ts);
CREATE INDEX ops_events_code ON ops_events (code, last_ts);

-- Every group the linked account participates in (cache of groupFetchAllParticipating), so the
-- dashboard can list and select groups without a live socket. The selection itself stays in `groups`.
CREATE TABLE account_groups (
  jid        TEXT PRIMARY KEY,
  subject    TEXT,
  size       INTEGER,
  creation   INTEGER,
  updated_at INTEGER NOT NULL
);
