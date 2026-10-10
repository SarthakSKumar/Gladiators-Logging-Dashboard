import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { openDb } from "../src/db/index.js";
import { classifyBaileysLog, createOpsEvents } from "../src/events.js";
import { G1, silent, tmpDir } from "./helpers.js";

const setup = () => {
  const db = openDb(join(tmpDir(), "messages.db"), "messages");
  const bus = new EventEmitter();
  const pushed = [];
  bus.on("opevent", (e) => pushed.push(e));
  let t = 1_000_000;
  const ops = createOpsEvents({ db, bus, log: silent, now: () => t });
  return { db, ops, pushed, advance: (ms) => (t += ms) };
};

test("operator events are stored, pushed live, and repeats coalesce within a minute", () => {
  const { ops, pushed, advance } = setup();
  const a = ops.emit({ level: "error", code: "db.commit_failed", message: "Database writes failing (SQLITE_BUSY)", context: { x: 1 } });
  advance(10_000);
  const b = ops.emit({ level: "error", code: "db.commit_failed", message: "Database writes failing (SQLITE_BUSY)" });
  assert.equal(a.id, b.id, "same code+message within 60 s → same row");
  assert.equal(b.count, 2);
  advance(61_000);
  const c = ops.emit({ level: "error", code: "db.commit_failed", message: "Database writes failing (SQLITE_BUSY)" });
  assert.notEqual(c.id, a.id);
  assert.equal(pushed.length, 3, "every occurrence is pushed (UI dedupes toasts by id)");
  const list = ops.list({ minLevel: "warn" });
  assert.equal(list.length, 2);
  assert.equal(list[0].level, "error");
  assert.equal(typeof list[0].noise, "boolean");
});

test("Baileys 'error in handling message' becomes a structured event with group, message id and reason", () => {
  const out = [];
  const emit = (e) => out.push(e);
  const groupOf = (jid) => (jid === G1 ? { label: "Gladiators Indian Racing" } : null);
  const node = `<message from="${G1}" type="text" id="3EB0ABC" participant="123@lid" offline="1"><enc v="2" type="pkmsg"/></message>`;
  const err = Object.assign(new Error("Connection Closed"), { output: { statusCode: 428 } });
  classifyBaileysLog(50, [{ error: err, node }, "error in handling message"], { emit, groupOf });
  assert.equal(out.length, 1);
  assert.equal(out[0].code, "ingest.message_failed");
  assert.equal(out[0].level, "error");
  assert.match(out[0].message, /Gladiators Indian Racing/);
  assert.match(out[0].message, /connection was closing/);
  assert.deepEqual(
    { id: out[0].context.id, participant: out[0].context.participant, from: out[0].context.from, statusCode: out[0].context.statusCode },
    { id: "3EB0ABC", participant: "123@lid", from: G1, statusCode: 428 },
  );
  // same failure outside the selected groups: recorded as noise, never toasted
  classifyBaileysLog(50, [{ error: err, node: node.replace(G1, "999@lid") }, "error in handling message"], { emit, groupOf });
  assert.equal(out[1].noise, true);
});

test("send-on-closed-socket chatter (presence on name change, acks, keep-alive) is noise; info logs are ignored", () => {
  const out = [];
  const emit = (e) => out.push(e);
  classifyBaileysLog(40, [{ trace: "Error: Connection Closed\n at x" }, "error in sending presence update on name change"], { emit, groupOf: () => null });
  classifyBaileysLog(50, [{}, "failed to ack receipt"], { emit, groupOf: () => null });
  classifyBaileysLog(30, [{}, "something informational"], { emit, groupOf: () => null });
  classifyBaileysLog(50, [{}, "failed to decrypt message"], { emit, groupOf: () => null }); // reported by intake instead
  assert.equal(out.length, 2);
  assert.ok(out.every((e) => e.noise && e.code === "wa.send_on_closed_socket"));
});
