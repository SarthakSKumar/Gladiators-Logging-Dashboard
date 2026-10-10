import { test } from "node:test";
import assert from "node:assert/strict";
import { createSheetsForwarder } from "../src/integrations/sheets.js";
import { G1, G2, makePipeline, msg, silent, upsert } from "./helpers.js";

const TARGETS = [{ key: "indian", groupJid: G1, groupName: "Gladiators Indian Racing 🏇", url: "https://script.google.com/macros/s/TEST/exec" }];

const setup = async () => {
  const p = makePipeline();
  let clock = 1_790_000_000_000;
  const calls = [];
  let reply = () => ({ status: 200, body: { status: "success", message: "Bet logged" } });
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = reply(calls.length);
    if (r instanceof Error) throw r;
    return { ok: r.status === 200, status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
  };
  const events = [];
  const ops = { emit: (e) => events.push(e) };
  const make = () => createSheetsForwarder({ db: p.db, targets: TARGETS, ops, log: silent, fetchImpl, now: () => clock });
  const sheets = make();
  const gid = p.groups.targetOf(G1).id;
  const startSession = (race, from, to = null) =>
    p.db.prepare("INSERT INTO sessions (group_id, label, race_number, started_at, ended_at) VALUES (?, 'S', ?, ?, ?)").run(gid, race, from, to).lastInsertRowid;
  const ingest = async (messages) => {
    p.intake.enqueue(upsert(messages));
    await p.intake.idle();
    p.committer.tick();
  };
  const settle = async (s = sheets) => { s.tick(); await new Promise((r) => setTimeout(r, 20)); await s.pump(); };
  return { p, calls, events, sheets, make, startSession, ingest, settle, setReply: (f) => (reply = f), advance: (ms) => (clock += ms) };
};

test("payload matches the Android app; id is 1, 2, 3… per session; raceNumber picks the sheet", async () => {
  const t = await setup();
  t.startSession(3, 1_790_000_100_000, 1_790_000_200_000);
  t.startSession(4, 1_790_000_300_000);
  await t.ingest([
    msg({ id: "A", ts: 1_790_000_110, text: "5 w 100", pushName: "Ravi" }),
    msg({ id: "B", ts: 1_790_000_120, text: "7p200 🏇", pushName: "Imran" }),
    msg({ id: "C", ts: 1_790_000_310, text: "2ew500", pushName: "Kiran" }),
    msg({ id: "X", chat: G2, ts: 1_790_000_310, text: "not forwarded" }), // group without a Sheets target
  ]);
  await t.settle();
  assert.equal(t.calls.length, 3);
  const [a, b, c] = t.calls.map((x) => x.body);
  assert.deepEqual(a, { id: 1, sender: "Ravi", message: "5 w 100", groupName: "Gladiators Indian Racing 🏇", timestamp: 1_790_000_110_000, raceNumber: "3" });
  assert.equal(b.id, 2);
  assert.equal(b.message, "7p200 🏇");
  assert.deepEqual([c.id, c.raceNumber], [1, "4"], "a new session starts again at row id 1 on its own RACE sheet");
  assert.equal(t.calls[0].init.method, "POST");
  assert.equal(t.calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(t.sheets.stats()[0].sent, 3);
  t.p.close();
});

test("transient failures retry with backoff and resend the SAME id (same row, no duplicates)", async () => {
  const t = await setup();
  t.startSession(1, 1_790_000_000_000);
  t.setReply((n) => (n <= 2 ? new Error("fetch failed") : { status: 200, body: { status: "success", message: "ok" } }));
  await t.ingest([msg({ id: "A", ts: 1_790_000_010, text: "1w100" })]);
  await t.settle();
  assert.equal(t.calls.length, 1);
  for (let i = 0; i < 2; i++) { t.advance(10 * 60_000); await t.settle(); }
  assert.equal(t.calls.length, 3);
  assert.deepEqual(t.calls.map((c) => c.body.id), [1, 1, 1]);
  assert.equal(t.sheets.stats()[0].sent, 1);
  t.p.close();
});

test("the script rejecting the group name fails fast with an actionable error; retry requeues", async () => {
  const t = await setup();
  t.startSession(2, 1_790_000_000_000);
  t.setReply(() => ({ status: 200, body: { status: "error", message: "Unrecognized group name: 'Gladiators Indian Racing 🏇'" } }));
  await t.ingest([msg({ id: "A", ts: 1_790_000_010, text: "3p1k" })]);
  await t.settle();
  assert.equal(t.calls.length, 1, "not retried automatically");
  assert.equal(t.sheets.stats()[0].failed, 1);
  assert.ok(t.events.some((e) => e.code === "sheets.config" && e.level === "error"));
  t.setReply(() => ({ status: 200, body: { status: "success", message: "ok" } }));
  assert.equal(t.sheets.retryFailed(), 1, "one failed row requeued");
  await t.sheets.pump();
  assert.equal(t.sheets.stats()[0].sent, 1);
  t.p.close();
});

test("a session without a race number is not sent (skipped + one warning); pending rows survive a restart", async () => {
  const t = await setup();
  t.startSession(null, 1_790_000_000_000, 1_790_000_100_000);
  t.startSession(5, 1_790_000_200_000);
  t.setReply(() => new Error("offline"));
  await t.ingest([msg({ id: "N", ts: 1_790_000_010 }), msg({ id: "N2", ts: 1_790_000_020 }), msg({ id: "P", ts: 1_790_000_210 })]);
  await t.settle();
  assert.equal(t.sheets.stats()[0].skipped, 2);
  assert.equal(t.events.filter((e) => e.code === "sheets.no_race").length, 1);
  assert.equal(t.sheets.stats()[0].pending, 1);
  // "restart": a new forwarder on the same database picks the pending row up
  t.setReply(() => ({ status: 200, body: { status: "success", message: "ok" } }));
  t.advance(10 * 60_000);
  const after = t.make();
  await t.settle(after);
  assert.equal(after.stats()[0].sent, 1);
  assert.equal(t.calls.at(-1).body.raceNumber, "5");
  t.p.close();
});
