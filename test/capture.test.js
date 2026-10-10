import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "../src/wa/connection.js";
import { createCapture } from "../src/capture.js";
import { makeFakeSocketFactory } from "./fakesock.js";
import { silent } from "./helpers.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await sleep(5);
  }
};

const tracked = [];
const setup = ({ registered = true, logging = 0, closeDelayMs = 0, timing } = {}) => {
  const f = makeFakeSocketFactory({ closeDelayMs });
  const auth = {
    creds: registered ? { me: { id: "919876543210:5@s.whatsapp.net" } } : {},
    keys: { get: async () => ({}), set: async () => {} },
    wipes: 0,
    saveCreds: async () => {},
    isRegistered() { return Boolean(this.creds.me); },
    wipe() { this.wipes++; this.creds = {}; },
  };
  const events = [];
  const ops = { emit: (e) => (events.push(e), e) };
  let n = logging;
  let capture = null;
  const conn = createConnection({
    authStore: auth, intake: { enqueue: () => {} }, log: silent, baileysLogger: silent, events: ops,
    makeSocket: f.factory, getVersion: async () => undefined, random: () => 0.5,
    shouldStayUp: () => capture.desiredUp(),
    onDown: (s) => { if (!s.linked) capture.linkSettled(); capture.reconcile(); },
    onState: () => capture?.observe(),
    timing: { quietMs: 30, maxDrainMs: 400, pendingFlagTimeoutMs: 5000, ...timing },
  });
  capture = createCapture({ connection: conn, loggingCount: () => n, events: ops, log: silent, tickMs: 1e9 });
  const ctx = {
    f, auth, conn, capture, events,
    state: () => capture.captureState().state,
    setLogging: (v) => { n = v; return capture.reconcile(); },
    online: async () => { await f.last().emit({ "connection.update": { connection: "open" } }); await f.last().emit({ "connection.update": { receivedPendingNotifications: true } }); },
    codes: () => events.map((e) => e.code),
  };
  tracked.push(ctx);
  return ctx;
};
test.afterEach(async () => {
  while (tracked.length) { const c = tracked.pop(); await c.capture.stop(); await c.conn.stop(); }
});

test("not linked: no socket until a link is requested; QR shown; QR expiry is reported, not auto-retried; regenerate works", async () => {
  const c = setup({ registered: false });
  await c.capture.reconcile();
  assert.equal(c.f.sockets.length, 0);
  assert.equal(c.state(), "not_linked");
  await c.capture.requestLink();
  assert.equal(c.f.sockets.length, 1);
  await c.f.last().emit({ "connection.update": { qr: "2@abc,def" } });
  assert.equal(c.state(), "linking");
  assert.match(c.conn.state().qr, /^<svg/);
  await c.f.last().close(408, "QR refs attempts ended");
  await c.capture.reconcile();
  assert.equal(c.state(), "not_linked");
  assert.equal(c.conn.state().qrExpired, true);
  assert.ok(c.codes().includes("wa.qr_expired"));
  assert.equal(c.f.sockets.length, 1, "expired QR is not regenerated without the user");
  await c.capture.requestLink(); // "Regenerate"
  assert.equal(c.f.sockets.length, 2);
  assert.equal(c.conn.state().qrExpired, false);
});

test("pairing: 515 restart-required right after linking restarts cleanly and is logged as noise only", async () => {
  const c = setup({ registered: false });
  await c.capture.requestLink();
  await c.f.last().emit({ "connection.update": { qr: "2@abc" } });
  await c.f.last().emit({ "connection.update": { isNewLogin: true } });
  c.auth.creds = { me: { id: "919876543210:5@s.whatsapp.net" } }; // Baileys stores creds while pairing
  c.capture.linkSettled();
  c.capture.lease("post-link-sync", 60_000);
  await c.f.last().close(515, "Stream Errored (restart required)");
  await until(() => c.f.sockets.length === 2);
  const restart = c.events.find((e) => e.code === "wa.restart_required");
  assert.equal(restart.noise, true);
  assert.equal(restart.level, "info");
  assert.ok(!c.events.some((e) => e.level === "error"), "no error surfaced for an expected 515");
  await c.online();
  assert.equal(c.conn.state().phase, "online");
  assert.equal(c.state(), "idle", "linked, socket up for initial sync, but no group logging");
});

test("capture is automatic: starts when a group logs, stops (gracefully) when none does", async () => {
  const c = setup();
  await c.capture.reconcile();
  assert.equal(c.state(), "idle");
  assert.equal(c.f.sockets.length, 0);
  await c.setLogging(1);
  assert.equal(c.state(), "starting");
  await c.online();
  assert.equal(c.state(), "capturing");
  await c.setLogging(0);
  assert.equal(c.state(), "idle");
  assert.equal(c.f.open().length, 0);
  assert.equal(c.f.sockets.length, 1, "intentional close is not followed by a reconnect");
  assert.deepEqual(c.codes().filter((x) => x.startsWith("capture.")), ["capture.started", "capture.stopped"]);
});

test("rapid play/stop clicks never leave the socket half open (one live socket at most, final state wins)", async () => {
  const c = setup({ closeDelayMs: 15 });
  const ps = [];
  for (let i = 0; i < 9; i++) ps.push(c.setLogging(i % 2 === 0 ? 1 : 0)); // ends on 1
  await Promise.all(ps);
  assert.ok(c.f.open().length <= 1);
  await until(() => c.f.open().length === 1);
  await c.online();
  assert.equal(c.state(), "capturing");
  const ps2 = [];
  for (let i = 0; i < 8; i++) ps2.push(c.setLogging(i % 2 === 0 ? 0 : 1)); // ends on 1
  ps2.push(c.setLogging(0));
  await Promise.all(ps2);
  assert.equal(c.f.open().length, 0);
  assert.equal(c.state(), "idle");
});

test("regression: a pause that clears before the close event lands still resumes (old suspend/resume race)", async () => {
  const c = setup({ closeDelayMs: 40 });
  await c.setLogging(1);
  await c.online();
  assert.equal(c.state(), "capturing");
  c.capture.setPressure("journal_write", true); // pause requested → graceful close starts
  await until(() => c.conn.state().phase === "closing" || c.f.last().ended);
  c.capture.setPressure("journal_write", false); // …cleared before the close event has landed
  await until(() => c.f.sockets.length === 2 && c.f.open().length === 1);
  await c.online();
  assert.equal(c.state(), "capturing", "no manual resume needed");
});

test("graceful close waits for in-flight sync to go quiet before ending the socket; no sends on a closing socket", async () => {
  const c = setup({ timing: { quietMs: 60, maxDrainMs: 1000 } });
  await c.setLogging(1);
  await c.online();
  const s = c.f.last();
  // Baileys still busy (app-state sync, offline messages): events keep arriving for ~150 ms
  let lastEmit = 0;
  const busy = (async () => { for (let i = 0; i < 6; i++) { await sleep(25); lastEmit = Date.now(); await s.emit({ "chats.update": [{ id: "x" }] }); } })();
  const closing = c.setLogging(0);
  await sleep(10);
  assert.equal(c.conn.usable(), false, "closing socket is not usable");
  await assert.rejects(c.conn.sendText("1@s.whatsapp.net", "hi"), /not connected/);
  await assert.rejects(c.conn.fetchGroups(), /not connected/);
  await busy;
  await closing;
  assert.ok(s.ended);
  assert.ok(s.endedAt - lastEmit >= 55, `ended ${s.endedAt - lastEmit} ms after the last event (quiet period respected)`);
  assert.equal(s.sent.length, 0);
});

test("unexpected drop while logging reconnects with backoff; a drop while idle does not", async (t) => {
  const c = setup();
  await c.setLogging(1);
  await c.online();
  await c.f.last().close(428, "Connection Closed");
  assert.equal(c.conn.state().phase, "reconnecting");
  assert.equal(c.state(), "starting");
  assert.ok(c.codes().includes("wa.reconnecting"));
  await until(() => c.f.sockets.length === 2, 3000);
  await c.online();
  assert.equal(c.state(), "capturing");
  await c.setLogging(0);
  assert.equal(c.state(), "idle");
});

test("logged out from the phone: keys wiped, not linked, error event; replaced: error state until restart", async () => {
  const c = setup();
  await c.setLogging(1);
  await c.online();
  await c.f.last().close(401, "logged out");
  assert.equal(c.auth.wipes, 1);
  assert.equal(c.state(), "not_linked");
  assert.equal(c.events.find((e) => e.code === "wa.logged_out").level, "error");

  const d = setup();
  await d.setLogging(1);
  await d.online();
  await d.f.last().close(440, "replaced");
  assert.equal(d.state(), "error");
  assert.equal(d.capture.captureState().reason, "replaced");
  await d.capture.reconcile();
  assert.equal(d.f.sockets.length, 1, "blocked: not reopened automatically");
  await d.conn.restart();
  await d.capture.reconcile();
  assert.equal(d.f.sockets.length, 2);
});
