import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";
import { G1, G2, OTHER, makePipeline, msg, upsert } from "./helpers.js";

const PT = proto.Message.ProtocolMessage.Type;
const count = (db, sql = "SELECT count(*) FROM messages", ...p) =>
  db
    .prepare(sql)
    .pluck()
    .get(...p);

test("burst: 10,000 messages across two groups in many batches — all committed, invariants hold", async () => {
  const p = makePipeline();
  for (let b = 0; b < 100; b++) {
    const batch = [];
    for (let i = 0; i < 100; i++)
      batch.push(
        msg({ chat: i % 2 ? G1 : G2, id: `B${b}-${i}`, ts: 1_790_000_000 + b }),
      );
    p.intake.enqueue(upsert(batch));
  }
  await p.intake.idle();
  p.committer.tick();
  assert.equal(count(p.db), 10_000);
  assert.equal(
    count(p.db, "SELECT count(*) FROM messages WHERE chat_jid = ?", G1),
    5000,
  );
  assert.equal(p.counters.c.journaled, 10_000);
  assert.equal(p.counters.c.applied_new, 10_000);
  assert.equal(p.counters.c.inflight, 0);
  assert.ok(p.check().ok, JSON.stringify(p.check()));
  const lat = p.counters.latencyStats();
  assert.ok(lat.n > 0 && lat.max >= lat.p50);
  p.close();
});

test("duplicates: replaying the same batches 5x creates no extra rows; excluded classes are counted", async () => {
  const p = makePipeline();
  const batch = [
    msg({ id: "D1" }),
    msg({ id: "D2", chat: G2 }),
    msg({ id: "X1", chat: OTHER }), // non-target group (all targets resolved)
    msg({ id: "X2", chat: "919000000001@s.whatsapp.net" }), // 1:1 chat
    msg({ id: "X3", message: { reactionMessage: { text: "👍" } } }), // reaction
  ];
  for (let i = 0; i < 5; i++) {
    p.intake.enqueue(upsert(batch));
    p.intake.enqueue(upsert(batch, "append"));
  }
  await p.intake.idle();
  p.committer.tick();
  assert.equal(count(p.db), 2);
  const c = p.counters.c;
  assert.equal(c.observed, 50);
  assert.equal(c.excluded_non_target_group, 10);
  assert.equal(c.excluded_non_group, 10);
  assert.equal(c.excluded_type, 10);
  assert.equal(c.applied_new, 2);
  assert.equal(c.applied_duplicate, 18);
  assert.ok(p.check().ok);
  p.close();
});

test("edit before original, revoke, late decryption: originals immutable, events appended once", async () => {
  const p = makePipeline();
  p.intake.enqueue(
    upsert([
      msg({
        id: "E1",
        message: {
          protocolMessage: {
            type: PT.MESSAGE_EDIT,
            key: { id: "O1" },
            editedMessage: { conversation: "v2" },
          },
        },
      }),
    ]),
  );
  p.intake.enqueue(upsert([msg({ id: "O1", text: "v1" })]));
  p.intake.enqueue(
    upsert([
      msg({
        id: "R1",
        message: { protocolMessage: { type: PT.REVOKE, key: { id: "O1" } } },
      }),
    ]),
  );
  p.intake.enqueue(
    upsert([
      msg({
        id: "R1",
        message: { protocolMessage: { type: PT.REVOKE, key: { id: "O1" } } },
      }),
    ]),
  ); // duplicate delivery
  p.intake.enqueue(
    upsert([
      msg({
        id: "C1",
        message: null,
        messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT,
      }),
    ]),
  );
  p.intake.enqueue(
    upsert([msg({ id: "C1", text: "decrypted now" })], "notify"),
  );
  await p.intake.idle();
  p.committer.tick();
  assert.equal(
    count(p.db, "SELECT body FROM messages WHERE wa_msg_id = 'O1'"),
    "v1",
  );
  assert.equal(
    count(
      p.db,
      "SELECT count(*) FROM message_events WHERE target_wa_msg_id = 'O1' AND event_type = 'edit'",
    ),
    1,
  );
  assert.equal(
    count(
      p.db,
      "SELECT count(*) FROM message_events WHERE target_wa_msg_id = 'O1' AND event_type = 'revoke'",
    ),
    1,
  );
  assert.equal(
    count(p.db, "SELECT msg_type FROM messages WHERE wa_msg_id = 'C1'"),
    "undecryptable",
  );
  assert.equal(
    count(
      p.db,
      "SELECT new_body FROM message_events WHERE target_wa_msg_id = 'C1' AND event_type = 'content_resolved'",
    ),
    "decrypted now",
  );
  assert.ok(p.check().ok);
  p.close();
});

test("preflight safety: unknown-group messages are held while a group is unresolved, then promoted or purged", async () => {
  const p = makePipeline({
    groupsConfig: [
      { key: "g1", label: "Gladiators Test Group", jid: G1 },
      { key: "g2", label: "Gladiators Test Group 2 🏇" },
    ],
  });
  assert.equal(p.groups.scopeOf(G2), "pending");
  p.intake.enqueue(
    upsert([
      msg({ id: "P1", chat: G2 }),
      msg({ id: "P2", chat: OTHER }),
      msg({ id: "T1", chat: G1 }),
    ]),
  );
  await p.intake.idle();
  p.committer.tick();
  assert.equal(count(p.db), 1);
  assert.equal(p.committer.pendingScopeOpen(), 2);
  assert.ok(p.check().ok);
  // resolve: G2 matches the label exactly (after normalisation), OTHER does not
  await p.groups.preflight(
    async () => ({
      [G1]: { id: G1, subject: "Gladiators Test Group" },
      [G2]: { id: G2, subject: "  RACE  TALK INDIA 🏇 " },
      [OTHER]: { id: OTHER, subject: "Something else" },
    }),
    { force: true },
  );
  assert.equal(p.groups.allResolved(), true);
  const r = p.committer.promotePending({
    allResolved: true,
    ttlMs: 86_400_000,
  });
  assert.deepEqual(r, { promoted: 1, purged: 1 });
  assert.equal(
    count(p.db, "SELECT count(*) FROM messages WHERE chat_jid = ?", G2),
    1,
  );
  assert.equal(p.committer.pendingScopeOpen(), 0);
  assert.ok(p.check().ok, JSON.stringify(p.check()));
  p.close();
});

test("preflight reports ambiguous and missing groups with actions; pick resolves", async () => {
  const p = makePipeline({
    groupsConfig: [
      { key: "a", label: "Gladiators Test Group" },
      { key: "b", label: "Gladiators Test Group 2 🏇" },
    ],
  });
  await p.groups.preflight(
    async () => ({
      x: { id: "x@g.us", subject: "Gladiators Test Group", size: 3 },
      y: { id: "y@g.us", subject: "Gladiators Test Group", size: 40 },
      z: { id: "z@g.us", subject: "Gladiators Test Group 2" },
    }),
    { force: true, me: "+91 98••••0000" },
  );
  const [a, b] = p.groups.list();
  assert.equal(a.status, "ambiguous");
  assert.equal(JSON.parse(a.candidates_json).length, 2);
  assert.equal(b.status, "missing");
  assert.match(b.action, /Ask a group admin to add \+91/);
  assert.equal(JSON.parse(b.candidates_json)[0].id, "z@g.us"); // suggestion only, not auto-selected
  p.groups.pick("a", "y@g.us");
  assert.equal(p.groups.scopeOf("y@g.us"), "target");
  assert.throws(() => p.groups.pick("a", "nope@g.us"));
  p.close();
});

test("database failure: journal keeps capturing, committer retries and catches up", async () => {
  const p = makePipeline();
  p.intake.enqueue(upsert([msg({ id: "F1" })]));
  await p.intake.idle();
  p.db.exec(
    "CREATE TRIGGER fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(FAIL, 'simulated I/O error'); END",
  );
  p.intake.enqueue(upsert([msg({ id: "F2" }), msg({ id: "F3" })]));
  await p.intake.idle();
  assert.equal(p.committer.degraded(), true);
  assert.equal(p.counters.c.journaled, 3); // still durable
  assert.equal(p.committer.pendingApply(), 2);
  p.db.exec("DROP TRIGGER fail_insert");
  p.committer.tick();
  assert.equal(p.committer.degraded(), false);
  assert.equal(count(p.db), 3);
  assert.ok(p.check().ok);
  p.committer.stop();
  p.close();
});

test("journal write failure: records stay in flight (at risk), socket suspension is requested, then recovery", async () => {
  let failing = true;
  const p = makePipeline({
    journalHooks: {
      beforeWrite: () => {
        if (failing)
          throw Object.assign(new Error("no space"), { code: "ENOSPC" });
      },
    },
  });
  p.intake.enqueue(upsert([msg({ id: "W1" })]));
  await new Promise((r) => setTimeout(r, 400)); // > chunkRetryMs (200) in test limits
  assert.equal(p.counters.c.inflight, 1);
  assert.ok(p.pressure.some((x) => x.on && x.reason === "journal_write"));
  failing = false;
  await p.intake.idle();
  p.committer.tick();
  assert.equal(p.counters.c.inflight, 0);
  assert.ok(p.pressure.some((x) => !x.on && x.reason === "journal_write"));
  assert.equal(count(p.db), 1);
  p.close();
});

test("boundedness: intake queue over its limit requests suspension and releases it when drained", async () => {
  const p = makePipeline({
    limits: {
      intakeMaxBatches: 2,
      intakeMaxRecords: 1000,
      chunkSize: 100,
      chunkRetryMs: 200,
    },
  });
  for (let b = 0; b < 10; b++)
    p.intake.enqueue(
      upsert(Array.from({ length: 300 }, (_, i) => msg({ id: `Q${b}-${i}` }))),
    );
  const peak = p.intake.depth();
  assert.ok(peak.batches > 2);
  assert.ok(p.pressure[0]?.on && p.pressure[0].reason === "intake_queue");
  await p.intake.idle();
  assert.deepEqual(p.intake.depth(), { batches: 0, records: 0 });
  assert.equal(p.pressure.at(-1).on, false);
  p.committer.tick();
  assert.equal(count(p.db), 3000);
  p.close();
});

test("restart replays journaled-but-unapplied records exactly once", async () => {
  const p = makePipeline();
  p.db.exec(
    "CREATE TRIGGER fail_insert BEFORE INSERT ON messages BEGIN SELECT RAISE(FAIL, 'down'); END",
  );
  p.intake.enqueue(upsert([msg({ id: "R1" }), msg({ id: "R2" })]));
  await p.intake.idle();
  assert.equal(count(p.db), 0);
  p.db.exec("DROP TRIGGER fail_insert");
  p.committer.stop();
  p.close(); // "crash": durable in journal only
  const p2 = makePipeline({ dir: p.dir });
  assert.equal(p2.counters.c.replay_backlog_at_start, 2);
  p2.committer.tick();
  p2.committer.tick();
  assert.equal(count(p2.db), 2);
  assert.ok(p2.check().ok, JSON.stringify(p2.check()));
  p2.close();
});
