import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { openDb } from "../src/db/index.js";
import { Journal } from "../src/ingest/journal.js";
import { createCounters } from "../src/ingest/counters.js";
import { createIntake } from "../src/ingest/intake.js";
import { createCommitter } from "../src/ingest/committer.js";
import { createGroups } from "../src/wa/groups.js";

export const silent = pino({ level: "silent" });
export const tmpDir = () => mkdtempSync(join(tmpdir(), "walog-"));
export const G1 = "120363000000000001@g.us";
export const G2 = "120363000000000002@g.us";
export const OTHER = "120363000000000099@g.us";

let n = 0;
export const msg = ({
  chat = G1,
  id = `ID${++n}`,
  participant = "919000000001@s.whatsapp.net",
  text = "hello",
  ts = 1_790_000_000,
  pushName = "Alice",
  fromMe = false,
  message,
  ...rest
} = {}) => ({
  key: { remoteJid: chat, id, participant, fromMe },
  messageTimestamp: ts,
  pushName,
  message: message === undefined ? { conversation: text } : message,
  ...rest,
});
export const upsert = (messages, type = "notify") => ({
  "messages.upsert": { messages, type },
});

export const LIMITS = {
  intakeMaxBatches: 4,
  intakeMaxRecords: 20000,
  chunkSize: 500,
  chunkRetryMs: 200,
  unappliedHighWater: 200000,
  diskMinFreeBytes: 0,
  diskMinFreeRatio: 0,
  sseMaxBufferBytes: 1 << 20,
};

/** Seed the selected-groups table (rows without jid behave like legacy groups.json entries). */
const seedGroups = (db, cfg) => {
  if (db.prepare("SELECT count(*) FROM groups").pluck().get()) return;
  const ins = db.prepare(
    `INSERT INTO groups (config_key, label, jid, subject_current, status, pinned, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 0)`,
  );
  for (const g of cfg)
    ins.run(g.key, g.label, g.jid || null, g.jid ? g.label : null, g.jid ? "resolved" : "unresolved", g.jid ? 1 : 0);
};

/** Full ingestion pipeline on a temp dir with two pinned target groups (+ optional unresolved one). */
export const makePipeline = ({
  dir = tmpDir(),
  groupsConfig,
  journalHooks,
  limits = LIMITS,
  epoch = "test-epoch",
  onDurable,
  onUndecryptable,
} = {}) => {
  mkdirSync(join(dir, "journal"), { recursive: true });
  const db = openDb(join(dir, "messages.db"), "messages");
  const journal = new Journal({
    dir: join(dir, "journal"),
    epoch,
    hooks: journalHooks,
    log: silent,
  });
  journal.open();
  const counters = createCounters();
  seedGroups(
    db,
    groupsConfig ?? [
      { key: "g1", label: "Gladiators Test Group", jid: G1 },
      { key: "g2", label: "Gladiators Test Group 2 🏇", jid: G2 },
    ],
  );
  const groups = createGroups({ db, log: silent });
  const committer = createCommitter({
    db,
    journal,
    groups,
    counters,
    log: silent,
  });
  counters.c.replay_backlog_at_start = committer.pendingApply();
  counters.c.pending_scope_open_at_start = committer.pendingScopeOpen();
  const pressure = [];
  const durable = [];
  const intake = createIntake({
    journal,
    groups,
    counters,
    limits,
    log: silent,
    onDurable: (chunk) => {
      onDurable ? onDurable(chunk) : durable.push(...chunk);
      committer.tick();
    },
    onPressure: (on, reason) => pressure.push({ on, reason }),
    onUndecryptable,
  });
  const check = () =>
    counters.check({
      pending_apply: committer.pendingApply(),
      pending_scope_open: committer.pendingScopeOpen(),
    });
  const close = () => {
    journal.close();
    db.close();
  };
  return {
    dir,
    db,
    journal,
    counters,
    groups,
    committer,
    intake,
    pressure,
    durable,
    check,
    close,
  };
};
