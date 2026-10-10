import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "../src/app.js";
import { makeFakeSocketFactory } from "./fakesock.js";
import { G1, G2, LIMITS, msg, silent, tmpDir } from "./helpers.js";

const ADMIN = "sarthakskumar7@gmail.com";

const boot = async () => {
  const root = tmpDir();
  const configDir = join(root, "config");
  mkdirSync(configDir);
  writeFileSync(
    join(configDir, "groups.json"),
    JSON.stringify([
      { key: "trial", label: "Gladiators Test Group" },
      { key: "race", label: "Gladiators Test Group 2 🏇" },
    ]),
  );
  writeFileSync(
    join(configDir, "admins.json"),
    JSON.stringify([
      { name: "Sarthak", email: ADMIN, phone: "+91 97429 13699" },
    ]),
  );
  process.env.CONFIG_DIR = configDir; // read lazily by loadGroupsConfig/loadAdmins
  const { config } = await import("../src/config.js");
  config.configDir = configDir;
  const cfg = {
    ...config,
    dataDir: join(root, "data"),
    backupDir: join(root, "backups"),
    port: 0,
    publicOrigin: "http://127.0.0.1",
    cookieSecure: false,
    limits: { ...LIMITS, diskMinFreeBytes: 0 },
  };
  const mails = [];
  const mailer = {
    configured: true,
    send: async (m) => {
      mails.push(m);
    },
  };
  const f = makeFakeSocketFactory();
  const app = await startApp({
    config: cfg,
    log: silent,
    makeSocket: f.factory,
    getVersion: async () => undefined,
    mailer,
  });
  while (!f.sockets.length) await new Promise((r) => setTimeout(r, 10));
  const base = `http://127.0.0.1:${app.web.port()}`;
  return { app, f, mails, base, root };
};

const call = async (
  base,
  path,
  { method = "GET", body, cookie, csrf = true } = {},
) => {
  const headers = { "content-type": "application/json" };
  if (csrf) headers["x-requested-with"] = "fetch";
  if (cookie) headers.cookie = cookie;
  const r = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  return {
    status: r.status,
    json: await r.json().catch(() => null),
    headers: r.headers,
  };
};

test(
  "end to end: OTP login, CSRF, preflight, sessions, live messages, SSE, logout",
  { timeout: 60_000 },
  async () => {
    const { app, f, mails, base } = await boot();
    try {
      // ---- auth ----
      assert.equal((await call(base, "/api/status")).status, 401);
      assert.equal(
        (
          await call(base, "/api/auth/request-otp", {
            method: "POST",
            body: { email: "stranger@x.com" },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call(base, "/api/auth/request-otp", {
            method: "POST",
            body: { email: ADMIN },
            csrf: false,
          })
        ).status,
        403,
        "CSRF header required",
      );
      assert.equal(
        (
          await call(base, "/api/auth/request-otp", {
            method: "POST",
            body: { email: ADMIN },
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await call(base, "/api/auth/request-otp", {
            method: "POST",
            body: { email: ADMIN },
          })
        ).status,
        429,
        "one code per minute",
      );
      const code = mails.at(-1).text.match(/\b(\d{6})\b/)[1];
      const wrong = code === "000000" ? "111111" : "000000";
      const bad = await call(base, "/api/auth/verify-otp", {
        method: "POST",
        body: { email: ADMIN, code: wrong },
      });
      assert.equal(bad.status, 400);
      assert.match(bad.json.error, /4 attempts left/);
      const ok = await call(base, "/api/auth/verify-otp", {
        method: "POST",
        body: { email: ADMIN, code },
      });
      assert.equal(ok.status, 200);
      const setCookie = ok.headers.get("set-cookie");
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.match(setCookie, /Max-Age=604800/); // 7 days
      const cookie = setCookie.split(";")[0];
      assert.equal(
        (
          await call(base, "/api/auth/verify-otp", {
            method: "POST",
            body: { email: ADMIN, code },
          })
        ).status,
        400,
        "codes are single-use",
      );

      // ---- WhatsApp comes online; preflight resolves both groups by exact label ----
      const sock = f.last();
      sock.groups = {
        [G1]: { id: G1, subject: "Gladiators Test Group", size: 3 },
        [G2]: { id: G2, subject: "Gladiators Test Group 2 🏇", size: 80 },
      };
      await sock.emit({ "connection.update": { connection: "open" } });
      await sock.emit({
        "connection.update": { receivedPendingNotifications: true },
      });
      await new Promise((r) => setTimeout(r, 100));
      let st = (await call(base, "/api/status", { cookie })).json;
      assert.equal(st.connection.state, "ONLINE");
      assert.deepEqual(
        st.groups.map((g) => g.status),
        ["resolved", "resolved"],
      );
      assert.equal(st.connection.me.number, "+91 98••••3210");
      const trial = st.groups[0];

      // ---- SSE ----
      const ctrl = new AbortController();
      const res = await fetch(`${base}/api/stream`, {
        headers: { cookie },
        signal: ctrl.signal,
      });
      const reader = res.body.getReader();
      let streamed = "";
      const reading = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            streamed += new TextDecoder().decode(value);
          }
        } catch {}
      })();

      // ---- session + messages ----
      const sess = await call(base, "/api/sessions", {
        method: "POST",
        cookie,
        body: { groupId: trial.id, label: "Race 1", raceNumber: 1 },
      });
      assert.equal(sess.status, 200);
      assert.equal(
        (
          await call(base, "/api/sessions", {
            method: "POST",
            cookie,
            body: { groupId: trial.id, label: "again" },
          })
        ).status,
        409,
      );
      const now = Math.floor(Date.now() / 1000) + 1;
      await sock.emit({
        "messages.upsert": {
          type: "notify",
          messages: [
            msg({ chat: G1, id: "M1", text: "5 w 100", ts: now }),
            msg({ chat: G1, id: "M2", text: "7 p 200", ts: now + 1 }),
          ],
        },
      });
      await app.intake.idle();
      await new Promise((r) => setTimeout(r, 100));
      const page = (
        await call(
          base,
          `/api/messages?group=${trial.id}&session=${sess.json.id}`,
          { cookie },
        )
      ).json;
      assert.equal(page.total, 2);
      assert.deepEqual(
        page.rows.map((r) => [r.sno, r.body]),
        [
          [2, "7 p 200"],
          [1, "5 w 100"],
        ],
      );
      assert.match(streamed, /event: msg/);
      assert.match(streamed, /"body":"5 w 100"/);
      st = (await call(base, "/api/status", { cookie })).json;
      assert.equal(st.groups[0].session.label, "Race 1");
      assert.ok(st.health.invariants.ok);
      const stop = await call(base, `/api/sessions/${sess.json.id}/stop`, {
        method: "POST",
        cookie,
      });
      assert.ok(stop.json.ended_at);
      ctrl.abort();
      await reading;

      // ---- operations ----
      assert.equal(
        (
          await call(base, "/api/wa/unlink", {
            method: "POST",
            cookie,
            body: { confirm: "nope" },
          })
        ).status,
        400,
      );
      const backup = await call(base, "/api/backup", {
        method: "POST",
        cookie,
      });
      assert.ok(backup.json.files["messages.db"]);
      const diag = (await call(base, "/api/diagnostics", { cookie })).json;
      assert.equal(diag.counters.applied_new, 2);

      // ---- logout ----
      assert.equal(
        (await call(base, "/api/auth/logout", { method: "POST", cookie }))
          .status,
        200,
      );
      assert.equal((await call(base, "/api/status", { cookie })).status, 401);
    } finally {
      await app.shutdown();
    }
  },
);
