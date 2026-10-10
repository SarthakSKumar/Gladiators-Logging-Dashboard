import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessions } from '../src/sessions.js'
import { listMessages } from '../src/web/queries.js'
import { G1, makePipeline, msg, upsert } from './helpers.js'

// Session membership is decided by wa_timestamp (sender-claimed send time), whole seconds, half-open.
test('delayed messages across start/stop boundaries', async () => {
  const p = makePipeline()
  let clock = 1_790_000_100_400 // Start clicked at …100.4 s
  const sessions = createSessions({ db: p.db, now: () => clock })
  const gid = p.groups.targetOf(G1).id
  const s = sessions.start({ groupId: gid, label: 'RACE 3', raceNumber: 3, by: 't' })
  assert.equal(sessions.start({ groupId: gid, label: 'dup' }).id, s.id, 'repeated start is idempotent')
  clock = 1_790_000_200_700 // Stop clicked at …200.7 s
  sessions.stop({ id: s.id, by: 't' })

  const cases = [
    { id: 'before-start', ts: 1_790_000_099, expect: false }, // sent before start (even if delivered after)
    { id: 'start-second', ts: 1_790_000_100, expect: true }, // same second as Start → in
    { id: 'middle', ts: 1_790_000_150, expect: true },
    { id: 'sent-before-stop-delivered-after', ts: 1_790_000_199, expect: true, late: true },
    { id: 'stop-second', ts: 1_790_000_200, expect: false }, // same second as Stop → next window
    { id: 'after-stop', ts: 1_790_000_300, expect: false }
  ]
  // delivered in a different order than sent, all after Stop (offline backlog)
  p.intake.enqueue(upsert([...cases].reverse().map(c => msg({ id: c.id, ts: c.ts })), 'append'))
  await p.intake.idle()
  p.committer.tick()
  const ended = sessions.get(s.id)
  const { rows, total } = listMessages(p.db, { session: ended, limit: 50 })
  assert.deepEqual(rows.map(r => r.wa_msg_id).sort(), cases.filter(c => c.expect).map(c => c.id).sort())
  assert.equal(total, 3)
  assert.deepEqual(rows.map(r => r.sno), [3, 2, 1]) // numbered in send order regardless of arrival order
  const st = sessions.stats(ended)
  assert.equal(st.message_count, 3)
  assert.equal(st.late_arrivals, 3) // all three arrived (received_at) after Stop
  p.close()
})

test('adjacent sessions never double-claim a message; validation errors', async () => {
  const p = makePipeline()
  let clock = 1_790_000_000_000
  const sessions = createSessions({ db: p.db, now: () => clock })
  const gid = p.groups.targetOf(G1).id
  const a = sessions.start({ groupId: gid, label: 'A' })
  clock = 1_790_000_010_300
  sessions.stop({ id: a.id })
  clock = 1_790_000_010_800 // restarted within the same second
  const b = sessions.start({ groupId: gid, label: 'B' })
  p.intake.enqueue(upsert([msg({ id: 'edge', ts: 1_790_000_010 })]))
  await p.intake.idle()
  p.committer.tick()
  const inA = listMessages(p.db, { session: sessions.get(a.id) }).total
  const inB = listMessages(p.db, { session: sessions.get(b.id) }).total
  assert.equal(inA + inB, 1)
  assert.throws(() => sessions.start({ groupId: 999, label: 'x' }), /Unknown group/)
  assert.throws(() => sessions.start({ groupId: gid, label: '   ' }), /label is required/)
  sessions.stop({ id: b.id })
  assert.throws(() => sessions.start({ groupId: gid, label: 'x', raceNumber: 11 }), /1–10/)
  p.close()
})

test('session interruptions: only gaps that begin during a session count', async () => {
  const p = makePipeline()
  let clock = 1_790_000_000_000
  const sessions = createSessions({ db: p.db, now: () => clock })
  const gid = p.groups.targetOf(G1).id
  const gap = (from, to, cause) => p.db.prepare("INSERT INTO capture_gaps (started_at, ended_at, cause, status) VALUES (?, ?, ?, 'unverified')").run(from, to, cause)
  gap(clock - 5_000, clock + 3_000, 'connecting') // capture still coming up when the session started: expected
  const s = sessions.start({ groupId: gid, label: 'R1' })
  gap(clock + 60_000, clock + 90_000, 'interrupted') // disconnect mid-session: an interruption
  clock += 120_000
  sessions.stop({ id: s.id })
  const st = sessions.stats(sessions.get(s.id))
  assert.deepEqual(st.gaps.map(g => g.cause), ['interrupted'])
  p.close()
})
