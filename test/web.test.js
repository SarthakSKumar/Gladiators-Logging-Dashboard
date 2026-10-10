import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proto } from "baileys";
import { startApp } from "../src/app.js";
import { makeFakeSocketFactory } from "./fakesock.js";
import { G1, G2, LIMITS, msg, silent, tmpDir } from "./helpers.js";

const ADMIN = "sarthakskumar7@gmail.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error("condition not met in time");
    await sleep(20);
  }
};

const boot = async () => {
  const root = tmpDir();
  const configDir = join(root, "config");
  mkdirSync(configDir);
  // legacy config: imported once, resolved by exact label on the first group refresh
  writeFileSync(join(configDir, "groups.json"), JSON.stringify([{ key: "indian", label: "Gladiators Indian Racing 🏇🏻" }]));
  writeFileSync(join(configDir, "admins.json"), JSON.stringify([{ name: "Sarthak", email: ADMIN, phone: "+91 97429 13699" }]));
  process.env.CONFIG_DIR = configDir; // loadAdmins reads config.configDir lazily
  const { config } = await import("../src/config.js");
  config.configDir = configDir;
  const cfg = {
    ...config, configDir, dataDir: join(root, "data"), backupDir: join(root, "backups"), port: 0,
    publicOrigin: "http://127.0.0.1", cookieSecure: false, devOtpToConsole: false, limits: { ...LIMITS, diskMinFreeBytes: 0 },
  };
  const mails = [];
  const mailer = { configured: true, send: async (m) => { mails.push(m); } };
  const f = makeFakeSocketFactory();
  const app = await startApp({
    config: cfg, log: silent, makeSocket: f.factory, getVersion: async () => undefined, mailer,
    connectionTiming: { quietMs: 20, maxDrainMs: 300 },
  });
  return { app, f, mails, base: `http://127.0.0.1:${app.web.port()}` };
};

const call = async (base, path, { method = "GET", body, cookie, csrf = true } = {}) => {
  const headers = { "content-type": "application/json" };
  if (csrf) headers["x-requested-with"] = "fetch";
  if (cookie) headers.cookie = cookie;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
};

test("end to end: login, link on demand, auto capture, groups from the account, text-only messages, live operator events", { timeout: 60_000 }, async () => {
  const { app, f, mails, base } = await boot();
  try {
    // ---- auth (email OTP) ----
    assert.equal((await call(base, "/api/status")).status, 401);
    assert.equal((await call(base, "/api/health")).status, 200, "liveness is public");
    assert.equal((await call(base, "/api/auth/request-otp", { method: "POST", body: { email: "stranger@x.com" } })).status, 403);
    assert.equal((await call(base, "/api/auth/request-otp", { method: "POST", body: { email: ADMIN }, csrf: false })).status, 403);
    assert.equal((await call(base, "/api/auth/request-otp", { method: "POST", body: { email: ADMIN } })).status, 200);
    const code = mails.at(-1).text.match(/\b(\d{6})\b/)[1];
    const ok = await call(base, "/api/auth/verify-otp", { method: "POST", body: { email: ADMIN, code } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("set-cookie"), /HttpOnly/);
    assert.match(ok.headers.get("set-cookie"), /SameSite=Strict/);
    const cookie = ok.headers.get("set-cookie").split(";")[0];
    const get = (p) => call(base, p, { cookie }).then((r) => r.json);
    const post = (p, body) => call(base, p, { method: "POST", cookie, body });

    // ---- not linked: no socket until the Link page asks for one ----
    let st = await get("/api/status");
    assert.equal(st.linked, false);
    assert.equal(st.capture.state, "not_linked");
    assert.equal(f.sockets.length, 0);
    assert.equal((await post("/api/sessions", { groupId: 1, label: "x" })).status, 409, "cannot log before linking");

    // ---- SSE ----
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { headers: { cookie }, signal: ctrl.signal });
    const reader = res.body.getReader();
    let streamed = "";
    const reading = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; streamed += new TextDecoder().decode(value); } } catch {} })();

    // ---- link: QR → paired → 515 restart → online; the account's groups are read ----
    await post("/api/wa/link");
    await until(() => f.sockets.length === 1);
    await f.last().emit({ "connection.update": { qr: "2@abc,def" } });
    st = await get("/api/status");
    assert.equal(st.capture.state, "linking");
    assert.match(st.capture.qr, /^<svg/);
    const creds = f.last().opts.auth.creds;
    creds.me = { id: "919876543210:5@s.whatsapp.net", name: "Logger" };
    await f.last().emit({ "creds.update": { me: creds.me }, "connection.update": { isNewLogin: true } });
    await f.last().close(515, "Stream Errored (restart required)");
    await until(() => f.sockets.length === 2);
    const sock = f.last();
    sock.groups = {
      [G1]: { id: G1, subject: "Gladiators Indian Racing 🏇🏻", size: 80 },
      [G2]: { id: G2, subject: "Gladiators International Racing 🏇", size: 40 },
    };
    await sock.emit({ "connection.update": { connection: "open" } });
    await sock.emit({ "connection.update": { receivedPendingNotifications: true } });
    await until(async () => (await get("/api/wa/groups")).groups.length === 2);
    st = await get("/api/status");
    assert.equal(st.linked, true);
    assert.equal(st.me.number, "+91 98••••3210");
    assert.equal(st.capture.state, "idle", "linked, no group logging");
    assert.equal(st.groups.length, 1);
    assert.equal(st.groups[0].jid, G1, "legacy groups.json row resolved by exact label");

    // ---- group selection ----
    const accountGroups = (await get("/api/wa/groups")).groups;
    assert.deepEqual(accountGroups.map((g) => g.selected), [true, false]);
    assert.equal((await post("/api/groups", { jid: G2 })).status, 200);
    assert.equal((await post("/api/groups", { jid: "nope@g.us" })).status, 404);
    st = await get("/api/status");
    assert.equal(st.groups.length, 2);
    const indian = st.groups.find((g) => g.jid === G1);

    // ---- start logging → capture runs; messages (text only) arrive live ----
    const sess = await post("/api/sessions", { groupId: indian.id, label: "Race 1 · Mysore", raceNumber: 1 });
    assert.equal(sess.status, 200);
    assert.equal((await post("/api/sessions", { groupId: indian.id, label: "again" })).json.id, sess.json.id, "start is idempotent");
    await until(async () => (await get("/api/status")).capture.state === "capturing");
    const now = Math.floor(Date.now() / 1000) + 1;
    await sock.emit({
      "messages.upsert": {
        type: "notify",
        messages: [
          msg({ chat: G1, id: "M1", text: "5 w 100", ts: now }),
          msg({ chat: G1, id: "M2", text: "7 p 200 🏇", ts: now + 1 }),
          msg({ chat: G1, id: "IMG", message: { imageMessage: { caption: "slip" } }, ts: now + 1 }),
          msg({ chat: G1, id: "BAD", message: null, messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT, ts: now + 2 }),
        ],
      },
    });
    await app.intake.idle();
    await sleep(100);
    const page = await get(`/api/messages?session=${sess.json.id}`);
    assert.equal(page.total, 2, "images and undecryptable messages are not stored as messages");
    assert.deepEqual(page.rows.map((r) => [r.sno, r.body]), [[2, "7 p 200 🏇"], [1, "5 w 100"]]);
    assert.match(streamed, /event: msg/);
    assert.match(streamed, /event: opevent/);
    assert.match(streamed, /ingest\.undecryptable/);

    // ---- KPIs + events (logs) ----
    const k = await get("/api/kpis");
    assert.equal(k.messagesAllTime, 2);
    assert.equal(k.groupsConfigured, 2);
    assert.equal(k.groupsLogging, 1);
    assert.ok(k.lastMessageAt > 0);
    assert.ok(k.ingestionFailuresToday >= 1);
    const evs = await get("/api/events?limit=50");
    assert.ok(evs.some((e) => e.code === "capture.started"));
    assert.ok(evs.some((e) => e.code === "wa.restart_required" && e.noise === true));

    // ---- stop logging → idle; stop again is a no-op ----
    const stop = await post(`/api/sessions/${sess.json.id}/stop`);
    assert.ok(stop.json.ended_at);
    assert.equal((await post(`/api/sessions/${sess.json.id}/stop`)).status, 200, "stop is idempotent");
    st = await get("/api/status");
    assert.equal(st.capture.state, "idle");

    // ---- removing a group keeps its history ----
    assert.equal((await call(base, `/api/groups/${indian.id}`, { method: "DELETE", cookie })).status, 200);
    assert.equal((await get("/api/status")).groups.length, 1);

    // ---- removed endpoints ----
    for (const p of ["/api/wa/resume", "/api/backup", "/api/groups/recheck", "/api/config/reload", "/api/wa/show-qr"]) {
      assert.equal((await post(p)).status, 404, p);
    }
    ctrl.abort();
    await reading;

    // ---- logout ----
    assert.equal((await post("/api/auth/logout")).status, 200);
    assert.equal((await call(base, "/api/status", { cookie })).status, 401);
  } finally {
    await app.shutdown();
  }
});
