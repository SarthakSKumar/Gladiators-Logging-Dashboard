// Tests for appscript/Code.gs — the REAL script source, run in a sandbox with a mocked Google environment.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dirname, "..", "appscript", "Code.gs"), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x)); // vm objects come from another realm: compare as plain JSON

/** A fresh sandbox: the script + fake SpreadsheetApp / PropertiesService / UrlFetchApp / ... */
const sandbox = ({ props = {}, sheets = ["RACE 1", "RACE 2", "RACE 3"], fetch = () => { throw new Error("unexpected network call"); } } = {}) => {
  const writes = []; // { sheet, row, values }
  const cells = {}; // `${sheet}!${row}` -> { background, note }
  const debug = [];
  const logs = [];
  const fetches = [];
  const range = (sheet, row) => ({
    setValues: (v) => writes.push({ sheet, row, values: plain(v) }),
    setBackground: (c) => { (cells[`${sheet}!${row}`] ??= {}).background = c; },
    setNote: (n) => { (cells[`${sheet}!${row}`] ??= {}).note = n; },
  });
  const ctx = vm.createContext({
    Logger: { log: (m) => logs.push(String(m)) },
    ContentService: { createTextOutput: (s) => ({ s, setMimeType() { return this; } }), MimeType: { JSON: "json" } },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        assert.equal(fmt, "dd/MM/yyyy HH:mm");
        const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
        return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
      },
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    UrlFetchApp: {
      fetch: (url, opts) => {
        fetches.push({ url, body: JSON.parse(opts.payload), headers: opts.headers });
        const r = fetch(url, opts, fetches.length);
        return { getResponseCode: () => r.code, getContentText: () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
      },
    },
    SpreadsheetApp: {
      openById: (id) => ({
        getSheetByName: (name) => {
          if (id === "17SV8q-OUgKocFJ_Vi6VEoWaU-0kGarRJiOJz16jiC2o" || id === "1VBCoHC4sFKo9-z-UFYBZyR5Ffb34mkOb_PANtgh5224") {
            return sheets.includes(name) ? { getRange: (row) => range(`${id.slice(0, 4)}/${name}`, row) } : null;
          }
          if (name === "Debug") return { appendRow: (r) => debug.push(plain(r)) };
          return null;
        },
      }),
    },
  });
  const api = vm.runInContext(`${SOURCE}\n;({ parseBetByRules, betObjectFromAiReply, aiBetAgreesWithMessage, parseBetWithAI, doPost, doGet, asText, authorize })`, ctx);
  const post = (body) => plain(JSON.parse(api.doPost({ postData: { contents: JSON.stringify(body) } }).s));
  return { api, post, writes, cells, debug, fetches, logs };
};

const rules = (m) => plain(sandbox().api.parseBetByRules(m));
const bet = (m) => { const r = rules(m); return r.ok ? [r.hNo, r.win, r.place] : null; };

test("rules: the examples from the original prompt", () => {
  const table = {
    "2w200": [2, 200, 0], "3p1kw5k": [3, 5000, 1000], "3p2k": [3, 0, 2000], "2 place. 8000. K B": [2, 0, 8000],
    "5place500": [5, 0, 500], "1.W.500": [1, 500, 0], "4ew100": [4, 100, 100], "1win. 15k": [1, 15000, 0],
    "2 win.   3000. .k": [2, 3000, 0], "9 each way 3k": [9, 3000, 3000], "6w1200p300": [6, 1200, 300],
    "2 win 200 place 500": [2, 200, 500], "2p 1k w 3k": [2, 3000, 1000], "10ew1000": [10, 1000, 1000], "6w100": [6, 100, 0], "2 p100": [2, 0, 100],
  };
  for (const [m, want] of Object.entries(table)) assert.deepEqual(bet(m), want, m);
  assert.equal(bet("random garbage"), null);
  // "k" glued to the next keyword, and initials that merely start with k
  assert.deepEqual(bet("4w2kp1k"), [4, 2000, 1000]);
  assert.deepEqual(bet("2p1kwin3k"), [2, 3000, 1000]);
  assert.deepEqual(bet("3 win 777 kb"), [3, 777, 0], "kb are initials, not thousands");
  assert.deepEqual(bet("5w100 kw"), [5, 100, 0], "trailing initials that look like k+w are ignored");
});

test("rules: real messages from the groups (shapes that occurred)", () => {
  const table = {
    "1  win 300": [1, 300, 0], "1 Win 100": [1, 100, 0], "1 p 700": [1, 0, 700], "1 plc 1800": [1, 0, 1800], "1 w 596": [1, 596, 0],
    "1 win 1000 place 1000": [1, 1000, 1000], "1 win 800 place 1k": [1, 800, 1000], "1 win 10k": [1, 10000, 0], "1 win 409/": [1, 409, 0],
    "1, w,1400": [1, 1400, 0], "10 win.  200 kB": [10, 200, 0], "10 win. 100. KB": [10, 100, 0], "3 WIN. 777. KB": [3, 777, 0],
    "3 place.  2000. KB": [3, 0, 2000], "10w100.   10plc100": [10, 100, 100], "4 win 200\n4 plc 300": [4, 200, 300], "5 win 500\n5 plc 500": [5, 500, 500],
    "1w100 p200": [1, 100, 200], "4w100 p400": [4, 100, 400], "4win 200 pl 500": [4, 200, 500], "9w200,pls 300": [9, 200, 300],
    "6, w,1000,plc,2000": [6, 1000, 2000], "2Pl2k": [2, 0, 2000], "3eway5k": [3, 5000, 5000], "2 ew 5k": [2, 5000, 5000], "4 ew\n100": [4, 100, 100],
    "1w\n100": [1, 100, 0], "4pla 5000": [4, 0, 5000], "3pls100": [3, 0, 100], "6win 25k": [6, 25000, 0], "3w26250": [3, 26250, 0],
    "2win 1970 taken": [2, 1970, 0], "2win.2k": [2, 2000, 0], "6Win.2k": [6, 2000, 0], "7p6": [7, 0, 6], "No 5 win 100": [5, 100, 0],
  };
  for (const [m, want] of Object.entries(table)) assert.deepEqual(bet(m), want, JSON.stringify(m));
});

test("rules: never guesses — several horses, missing amounts, chatter and typos are NOT parsed", () => {
  const notParsed = [
    "1w1k 7w1k", "1 win 2520, 2 win 2520", "1ew500 3ew500", "2p100 9p100", "2w100 4p200", "3w3k 2w1k", "1w 1000\n2w 1000", "2pl 500\n6pl 500",
    "3 and 5 win 150", "3and6w100", "3win../4pls100", "1p4p100", "4w3005w300", "3w 1000\n10e 1000", // more than one bet / ambiguous
    "1 win", "2 win", "5 place", "1 plc all", "1 place odds ???", // no amount
    "290 taken", "600", "Qs", "Not taken", "Not taken mention proper amount", "MT add balance", "NO 4 WITHDRAWN", "Sry take 100 win",
    "Sorry sir   9 place.. Please", "*DEDUCTIONS*\nWIN 20%\nPLACE 35%", "random garbage", "", "2 min 2000",
  ];
  for (const m of notParsed) assert.equal(bet(m), null, JSON.stringify(m));
  assert.equal(rules("1w1k 7w1k").multiple, true, "multi-bet is flagged so the AI is never asked");
  assert.equal(rules("3win../4pls100").multiple, true);
});

test("AI reply shapes: OpenAI choices, result.response as string, as OBJECT, fenced / chatty text, errors", () => {
  const { api } = sandbox();
  const ok = (d) => plain(api.betObjectFromAiReply(d));
  const want = { ok: true, hNo: 7, win: 1000, place: 0 };
  assert.deepEqual(ok({ choices: [{ message: { content: '{"hNo":7,"win":1000,"place":0}' } }] }), want);
  assert.deepEqual(ok({ result: { response: '{"hNo":7,"win":1000,"place":0}' }, success: true }), want);
  assert.deepEqual(ok({ result: { response: { hNo: 7, win: 1000, place: 0 } } }), want, "response already parsed into an object (the original bug)");
  assert.deepEqual(ok({ choices: [{ message: { content: { hNo: 7, win: 1000 } } }] }), want);
  assert.deepEqual(ok({ result: { response: 'Sure!\n```json\n{"hNo": 7, "win": 1000, "place": 0}\n```' } }), want);
  assert.deepEqual(ok({ result: { choices: [{ message: { content: '{"hNo":7,"win":1000,"place":0}' } }] } }), want);
  for (const bad of [
    { result: { response: '{"error":"Could not parse message"}' } },
    { result: { response: "I cannot help with that" } },
    { result: { response: '{"hNo":0,"win":5,"place":0}' } },
    { result: { response: '{"hNo":99,"win":5,"place":0}' } },
    { result: { response: '{"hNo":3,"win":-5,"place":0}' } },
    { result: { response: '{"hNo":3,"win":1.5,"place":0}' } },
    { result: { response: '{"hNo":3,"win":0,"place":0}' } },
    { result: {} }, {}, { choices: [] },
  ]) assert.equal(ok(bad).ok, false, JSON.stringify(bad));
});

test("AI answers must match numbers actually written in the message (no hallucinated amounts)", () => {
  const { api } = sandbox();
  const agree = (b, m) => api.aiBetAgreesWithMessage(b, m);
  assert.equal(agree({ hNo: 2, win: 2000, place: 0 }, "2 min 2000"), true);
  assert.equal(agree({ hNo: 2, win: 5000, place: 0 }, "2 min 5k"), true, "5k = 5000");
  assert.equal(agree({ hNo: 2, win: 7000, place: 0 }, "2 min 2000"), false);
  assert.equal(agree({ hNo: 9, win: 2000, place: 0 }, "2 min 2000"), false, "horse must be written in the message");
  assert.equal(agree({ hNo: 2, win: 2000, place: 100 }, "2 min 2000"), false);
});

test("doPost: rules-parsed bet → exact row, numbers, IST time, NO network call, red cleared", () => {
  const t = sandbox();
  const r = t.post({ id: 5, sender: "Ravi", message: "6w1200p300", groupName: "Gladiators Indian Racing 🏇", timestamp: 1_791_630_000_000, raceNumber: "2" });
  assert.equal(r.status, "success");
  assert.deepEqual([r.parsed, r.source, r.row, r.hNo, r.win, r.place], [true, "rules", 7, 6, 1200, 300]);
  assert.match(r.message, /Bet logged at row 7 \(ID: 5\), Horse: 6, Win: 1200, Place: 300/);
  assert.equal(t.writes.length, 1);
  assert.equal(t.writes[0].sheet, "1VBC/RACE 2", "Indian group → Indian spreadsheet, sheet RACE 2");
  assert.equal(t.writes[0].row, 7);
  assert.deepEqual(t.writes[0].values[0], [5, "10/10/2026 16:30", "Ravi", "6w1200p300", "=LEFT(C7, 2)", 6, 1200, 300]);
  assert.equal(t.fetches.length, 0);
  assert.equal(t.cells["1VBC/RACE 2!7"].background, null);
  assert.equal(t.cells["1VBC/RACE 2!7"].note, "");
});

test("doPost: International group → International spreadsheet; unknown group / race / id are rejected without writing", () => {
  const t = sandbox();
  const base = { id: 1, sender: "A", message: "3w100", timestamp: 1_791_630_000_000, raceNumber: "1" };
  assert.equal(t.post({ ...base, groupName: "Gladiators International Racing 🏇" }).status, "success");
  assert.equal(t.writes[0].sheet, "17SV/RACE 1");
  for (const [patch, re] of [
    [{ groupName: "trial message" }, /Unrecognized group name: 'trial message'/],
    [{ groupName: "Gladiators Indian Racing 🏇", raceNumber: "9" }, /RACE 9" not found/],
    [{ groupName: "Gladiators Indian Racing 🏇", raceNumber: "abc" }, /Invalid raceNumber/],
    [{ groupName: "Gladiators Indian Racing 🏇", raceNumber: null }, /Invalid raceNumber/],
    [{ groupName: "Gladiators Indian Racing 🏇", id: 0 }, /Invalid id/],
  ]) {
    const r = t.post({ ...base, groupName: "Gladiators Indian Racing 🏇", ...patch });
    assert.equal(r.status, "error");
    assert.match(r.message, re);
  }
  assert.equal(t.writes.length, 1, "nothing written for rejected requests");
  assert.equal(plain(JSON.parse(t.api.doGet().s)).status, "ok");
  assert.equal(plain(JSON.parse(t.api.doPost({}).s)).status, "error");
});

test("doPost: unreadable bet → row still written, Horse/Win/Place EMPTY (not 0), red + note, parsed:false", () => {
  const t = sandbox(); // no AI configured
  const r = t.post({ id: 2, sender: "Rajjjjj", message: "1 win", groupName: "Gladiators Indian Racing 🏇", timestamp: 1_791_630_000_000, raceNumber: "2" });
  assert.equal(r.status, "success");
  assert.deepEqual([r.parsed, r.source, r.hNo, r.win, r.place], [false, "none", null, null, null]);
  assert.match(r.message, /NOT PARSED/);
  assert.deepEqual(t.writes[0].values[0].slice(5), ["", "", ""]);
  assert.equal(t.cells["1VBC/RACE 2!4"].background, "#FFCCCC");
  assert.match(t.cells["1VBC/RACE 2!4"].note, /Could not read horse\/win\/place/);
  assert.ok(t.debug.length >= 1, "failure is logged to the Debug sheet");
  assert.equal(t.fetches.length, 0);
});

const AI = { CF_API_TOKEN: "test-token", CF_ACCOUNT_ID: "acct" };
const aiOk = (content) => ({ code: 200, body: { choices: [{ message: { content } }] } });

test("doPost: AI fallback reads a typo ('2 min 2000'), is marked 'Read by AI', and uses the OpenAI-compatible endpoint", () => {
  const t = sandbox({ props: AI, fetch: () => aiOk('{"hNo":2,"win":2000,"place":0}') });
  const r = t.post({ id: 1, sender: "S", message: "2 min 2000", groupName: "Gladiators Indian Racing 🏇", timestamp: 1_791_630_000_000, raceNumber: "1" });
  assert.deepEqual([r.parsed, r.source, r.hNo, r.win, r.place], [true, "ai", 2, 2000, 0]);
  assert.equal(t.fetches.length, 1);
  assert.equal(t.fetches[0].url, "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions");
  assert.equal(t.fetches[0].headers.Authorization, "Bearer test-token");
  assert.equal(t.fetches[0].body.model, "@cf/meta/llama-3.1-8b-instruct");
  assert.match(t.cells["1VBC/RACE 1!3"].note, /Read by AI/);
});

test("doPost: AI is NOT asked for multi-bet / long / number-heavy messages, and hallucinations are rejected", () => {
  const t = sandbox({ props: AI, fetch: () => aiOk('{"hNo":1,"win":1000,"place":0}') });
  const g = { sender: "S", groupName: "Gladiators Indian Racing 🏇", timestamp: 1_791_630_000_000, raceNumber: "1" };
  for (const [id, m] of [[1, "1w1k 7w1k"], [2, "3w 1000\n10e 1000"], [3, "Not taken mention proper amount"], [4, "1 2 3 4 win"]]) {
    const r = t.post({ id, message: m, ...g });
    assert.equal(r.parsed, false, m);
  }
  assert.equal(t.fetches.length, 0, "no AI call for any of those");
  // asked (1 number) but the AI invents an amount → rejected
  const bad = sandbox({ props: AI, fetch: () => aiOk('{"hNo":2,"win":9999,"place":0}') });
  const r = bad.post({ id: 1, message: "2 min 2000", ...g });
  assert.equal(r.parsed, false);
  assert.match(r.reason, /does not match the numbers/);
  assert.equal(bad.fetches.length, 1);
});

test("doPost: AI endpoint failures — 401 stops at once, 404 falls back to the native endpoint, garbage is flagged", () => {
  const g = { id: 1, sender: "S", message: "2 min 2000", groupName: "Gladiators Indian Racing 🏇", timestamp: 1_791_630_000_000, raceNumber: "1" };
  const unauth = sandbox({ props: AI, fetch: () => ({ code: 401, body: { success: false } }) });
  assert.match(unauth.post(g).reason, /AI HTTP 401/);
  assert.equal(unauth.fetches.length, 1, "a bad token is not retried on the second endpoint");

  const native = sandbox({ props: AI, fetch: (u) => (u.endsWith("/v1/chat/completions") ? { code: 404, body: "" } : { code: 200, body: { result: { response: { hNo: 2, win: 2000, place: 0 } }, success: true } }) });
  const r = native.post(g);
  assert.deepEqual([r.parsed, r.source], [true, "ai"]);
  assert.equal(native.fetches[1].url, "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/meta/llama-3.1-8b-instruct");

  const junk = sandbox({ props: AI, fetch: () => ({ code: 200, body: "<html>oops</html>" }) });
  assert.equal(junk.post(g).parsed, false);
  const thrown = sandbox({ props: AI, fetch: () => { throw new Error("DNS error"); } });
  assert.match(thrown.post(g).reason, /DNS error/);
});

test("doPost: sender/message that look like formulas are stored as text (no spreadsheet formula injection)", () => {
  const t = sandbox();
  t.post({ id: 1, sender: '=HYPERLINK("http://evil","x")', message: "+1w100", groupName: "Gladiators Indian Racing 🏇", timestamp: 1_791_630_000_000, raceNumber: "1" });
  const v = t.writes[0].values[0];
  assert.equal(v[2], `'=HYPERLINK("http://evil","x")`);
  assert.equal(v[3], "'+1w100");
  assert.equal(v[4], "=LEFT(C3, 2)", "the script's own formula is untouched");
});

test("authorize(): read-only permission check — touches all three spreadsheets, reports missing RACE sheets, writes nothing", () => {
  const t = sandbox({ sheets: ["RACE 1", "RACE 2", "RACE 3"] });
  t.api.authorize();
  assert.equal(t.writes.length, 0);
  assert.equal(t.fetches.length, 0);
  assert.match(t.logs.join("\n"), /Indian spreadsheet: OK — MISSING sheets: RACE 4, RACE 5, RACE 6, RACE 7, RACE 8, RACE 9, RACE 10/);
  assert.match(t.logs.join("\n"), /International spreadsheet: OK/);
  assert.match(t.logs.join("\n"), /Debug spreadsheet: OK/);
  const full = sandbox({ sheets: Array.from({ length: 10 }, (_, i) => `RACE ${i + 1}`) });
  full.api.authorize();
  assert.match(full.logs.join("\n"), /RACE 1\.\.10 all present/);
});
