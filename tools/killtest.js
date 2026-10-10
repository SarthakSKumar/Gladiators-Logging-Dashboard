// Crash harness (plan §12): `node tools/killtest.js [rounds]`
// Pass condition: every record the child reported durable is in SQLite after recovery.
// Records enqueued but not yet durable at the kill are the measured loss window (reported, not "passed").
import { fork } from 'node:child_process'
import { join } from 'node:path'
import { makePipeline, tmpDir } from '../test/helpers.js'

export const runKillTest = async ({ rounds = 100, minMs = 30, maxMs = 400 } = {}) => {
  const dir = tmpDir()
  const acked = new Set()
  const enqueued = new Set()
  const perKillInFlight = []
  for (let r = 0; r < rounds; r++) {
    const child = fork(join(import.meta.dirname, 'killtest-child.js'), [dir, `r${r}`], { stdio: 'ignore' })
    const runEnq = new Set(); const runAck = new Set()
    child.on('message', m => {
      if (m.enq) m.enq.forEach(id => { enqueued.add(id); runEnq.add(id) })
      if (m.ack) m.ack.forEach(id => { acked.add(id); runAck.add(id) })
    })
    await new Promise(res => child.once('message', res)) // ready (startup replay done)
    await new Promise(res => setTimeout(res, minMs + Math.random() * (maxMs - minMs)))
    child.kill('SIGKILL')
    await new Promise(res => child.once('exit', res))
    perKillInFlight.push(runEnq.size - runAck.size)
  }
  const p = makePipeline({ dir })
  p.committer.tick()
  const stored = new Set(p.db.prepare('SELECT wa_msg_id FROM messages').pluck().all())
  p.close()
  const lostAcked = [...acked].filter(id => !stored.has(id))
  const notDurable = [...enqueued].filter(id => !stored.has(id))
  const sorted = [...perKillInFlight].sort((a, b) => a - b)
  return {
    rounds,
    enqueued: enqueued.size,
    acked: acked.size,
    stored: stored.size,
    lostAcked: lostAcked.length, // MUST be 0
    lostInWindow: notDurable.length, // measured loss window (never acknowledged)
    inFlightAtKill: { median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) }
  }
}

if (process.argv[1] === import.meta.filename) {
  const res = await runKillTest({ rounds: Number(process.argv[2] || 100) })
  console.log(JSON.stringify(res, null, 2))
  process.exit(res.lostAcked === 0 ? 0 : 1)
}
