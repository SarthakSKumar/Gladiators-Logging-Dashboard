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
  const logs = [];
  const log = Object.fromEntries(["info", "warn", "error"].map((l) => [l, (o, m) => logs.push({ l, m, ...o })]));
  const make = () => createSheetsForwarder({ db: p.db, targets: TARGETS, ops, log, fetchImpl, now: () => clock, sendIntervalMs: 0 });
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
  return { p, calls, events, logs, sheets, make, startSession, ingest, settle, setReply: (f) => (reply = f), advance: (ms) => (clock += ms) };
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

test("enabling forwarding mid-session back-fills that running session once (ended sessions are not)", async () => {
  const t = await setup();
  t.startSession(1, 1_790_000_000_000, 1_790_000_050_000); // ended before forwarding existed
  t.startSession(2, 1_790_000_100_000); // still running
  t.p.db.prepare("DELETE FROM meta WHERE key = 'sheets_cursor'").run();
  await t.ingest([msg({ id: "OLD", ts: 1_790_000_010, text: "old" }), msg({ id: "R1", ts: 1_790_000_110, text: "Hi" }), msg({ id: "R2", ts: 1_790_000_120, text: "Ye" })]);
  // first start of the integration: cursor = latest message, then the running session is back-filled
  t.p.db.prepare("DELETE FROM sheet_outbox").run();
  t.p.db.prepare("DELETE FROM meta WHERE key = 'sheets_cursor'").run();
  const fresh = t.make();
  await t.settle(fresh);
  assert.deepEqual(t.calls.slice(-2).map((c) => [c.body.id, c.body.message, c.body.raceNumber]), [[1, "Hi", "2"], [2, "Ye", "2"]]);
  assert.ok(!t.calls.some((c) => c.body.message === "old"), "ended session not back-filled");
  const again = t.make(); // a later restart does not re-queue
  await t.settle(again);
  assert.equal(t.p.db.prepare("SELECT count(*) FROM sheet_outbox").pluck().get(), 2);
  t.p.close();
});

test("every call to the endpoint is logged: request payload, response, outcome (and the URL is masked)", async () => {
  const t = await setup();
  t.startSession(3, 1_790_000_000_000);
  await t.ingest([msg({ id: "A", ts: 1_790_000_010, text: "5 w 100", pushName: "Ravi" })]);
  await t.settle();
  let post = t.logs.find((x) => x.m === "sheets: POST");
  assert.equal(post.payload.message, "5 w 100");
  assert.equal(post.payload.raceNumber, "3");
  assert.equal(post.attempt, 1);
  assert.ok(post.url.startsWith("https://script.google.com/macros/s/TEST"), "script id never logged in full");
  const ok = t.logs.find((x) => x.m === "sheets: response");
  assert.deepEqual([ok.result, ok.httpStatus], ["sent", 200]);
  assert.match(ok.response, /Bet logged/);

  // the script rejects the group name → error-level line with the script's answer
  t.logs.length = 0;
  t.setReply(() => ({ status: 200, body: { status: "error", message: "Unrecognized group name: 'x'" } }));
  await t.ingest([msg({ id: "B", ts: 1_790_000_020, text: "2p200" })]);
  await t.settle();
  const rej = t.logs.find((x) => x.m === "sheets: response");
  assert.equal(rej.l, "error");
  assert.match(rej.response, /Unrecognized group name/);

  // network failure → warn line with the reason, then a retry line
  t.logs.length = 0;
  t.setReply(() => new Error("fetch failed"));
  await t.ingest([msg({ id: "C", ts: 1_790_000_030, text: "3w300" })]);
  await t.settle();
  assert.ok(t.logs.some((x) => x.m === "sheets: request failed" && /fetch failed/.test(x.reason)));
  assert.ok(t.logs.some((x) => x.m === "sheets: will retry" && x.retryInSeconds > 0));
  t.p.close();
});

test("a missing RACE sheet is reported in plain words (script says 'Template Sheet not found!')", async () => {
  const t = await setup();
  t.startSession(9, 1_790_000_000_000);
  t.setReply(() => ({ status: 200, body: { status: "error", message: "Template Sheet not found!" } }));
  await t.ingest([msg({ id: "A", ts: 1_790_000_010, text: "1w100" })]);
  await t.settle();
  assert.match(t.sheets.stats()[0].lastError, /no "RACE 9" sheet/);
  t.p.close();
});

test("call log: every attempt is stored with the exact request and the script's answer (sent, rejected, network error)", async () => {
  const t = await setup();
  t.startSession(3, 1_790_000_000_000);
  // 1) accepted
  await t.ingest([msg({ id: "A", ts: 1_790_000_010, text: "7 win 1000", pushName: "Ravi" })]);
  await t.settle();
  // 2) the script says the RACE sheet is missing (retryable), 3) the network fails
  t.setReply(() => ({ status: 200, body: { status: "error", message: "Template Sheet not found!" } }));
  await t.ingest([msg({ id: "B", ts: 1_790_000_020, text: "2p200", pushName: "Imran" })]);
  await t.settle();
  t.setReply(() => new Error("fetch failed"));
  await t.ingest([msg({ id: "C", ts: 1_790_000_030, text: "3w300", pushName: "Kiran" })]);
  await t.settle();

  const all = t.sheets.calls();
  assert.deepEqual(all.map((c) => c.result).reverse(), ["sent", "rejected", "network_error"]);
  const [net, rej, ok] = all;
  assert.equal(ok.message, "7 win 1000");
  assert.deepEqual([ok.sender, ok.race, ok.row_id, ok.http_status, ok.attempt], ["Ravi", "3", 1, 200, 1]);
  assert.deepEqual(ok.request, JSON.parse(t.calls[0].init.body), "the stored request is exactly what was POSTed");
  assert.match(ok.response, /Bet logged/);
  assert.match(rej.error, /no "RACE 3" sheet/);
  assert.match(rej.response, /Template Sheet not found/);
  assert.equal(net.http_status, null);
  assert.match(net.error, /fetch failed/);

  // filters + paging
  assert.equal(t.sheets.calls({ result: "sent" }).length, 1);
  assert.equal(t.sheets.calls({ result: "problem" }).length, 2);
  assert.equal(t.sheets.calls({ beforeId: rej.id }).length, 1);
  assert.equal(t.sheets.calls({ target: "nope" }).length, 0);

  // a retry of the same message is a second entry for the same row (history is kept, not overwritten)
  t.setReply(() => ({ status: 200, body: { status: "success", message: "ok" } }));
  t.advance(10 * 60_000);
  await t.settle();
  const again = t.sheets.calls().filter((c) => c.outbox_id === rej.outbox_id);
  assert.deepEqual(again.map((c) => [c.attempt, c.result]).reverse(), [[1, "rejected"], [2, "sent"]]);
  t.p.close();
});
