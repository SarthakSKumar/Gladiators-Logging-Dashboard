import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAdmins, config } from "../src/config.js";
import { loadSheetsConfig } from "../src/integrations/sheets.js";
import { tmpDir } from "./helpers.js";

const withEnv = (vars, fn) => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

test("admins: ADMINS_JSON (e.g. on Render) wins over the file; normalised; invalid JSON is a clear error", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, "admins.json"), JSON.stringify([{ name: "File Admin", email: "file@x.com" }]));
  const saved = config.configDir;
  config.configDir = dir;
  try {
    assert.deepEqual(loadAdmins().map((a) => a.email), ["file@x.com"], "file is used when the variable is unset");
    withEnv({ ADMINS_JSON: JSON.stringify([{ name: "Env Admin", email: " Env@X.com ", phone: "+91 98765-43210", alerts: false }]) }, () => {
      assert.deepEqual(loadAdmins(), [{ name: "Env Admin", email: "env@x.com", phone: "919876543210", alerts: false }]);
    });
    withEnv({ ADMINS_JSON: "{not json" }, () => assert.throws(() => loadAdmins(), /ADMINS_JSON is not valid JSON/));
  } finally { config.configDir = saved; }
});

test("admins: with neither file nor variable the allow-list is empty (nobody can sign in)", () => {
  const saved = config.configDir;
  config.configDir = tmpDir();
  try { assert.deepEqual(loadAdmins(), []); } finally { config.configDir = saved; }
});

test("sheets config: SHEETS_JSON wins over the file; validated; missing everywhere = disabled", () => {
  const dir = tmpDir();
  assert.deepEqual(loadSheetsConfig(dir), [], "no file, no variable → disabled");
  const target = { key: "indian", groupJid: "1203630000000000@g.us", groupName: "Gladiators Indian Racing", url: "https://script.google.com/macros/s/ID/exec" };
  withEnv({ SHEETS_JSON: JSON.stringify({ targets: [target] }) }, () => {
    assert.deepEqual(loadSheetsConfig(dir), [target]);
  });
  mkdirSync(join(dir, "x"));
  writeFileSync(join(dir, "sheets.json"), JSON.stringify({ targets: [{ ...target, key: "from-file" }] }));
  assert.equal(loadSheetsConfig(dir)[0].key, "from-file");
  withEnv({ SHEETS_JSON: JSON.stringify({ targets: [target] }) }, () => assert.equal(loadSheetsConfig(dir)[0].key, "indian"));
  withEnv({ SHEETS_JSON: "nope" }, () => assert.throws(() => loadSheetsConfig(dir), /SHEETS_JSON is not valid JSON/));
  withEnv({ SHEETS_JSON: JSON.stringify({ targets: [{ ...target, url: "http://insecure" }] }) }, () => assert.throws(() => loadSheetsConfig(dir), /https url/));
});
