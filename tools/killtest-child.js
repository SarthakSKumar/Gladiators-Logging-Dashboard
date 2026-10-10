// Child for the crash harness: ingests an endless burst and reports, over IPC, which records became
// durable. The parent SIGKILLs it at random moments.
import { makePipeline, msg, upsert } from '../test/helpers.js'

const [dir, runId] = process.argv.slice(2)
const p = makePipeline({ dir, onDurable: chunk => process.send({ ack: chunk.map(r => r.wa_msg_id) }) })
p.committer.tick() // crash recovery: replay what the previous child journaled but did not apply
let i = 0
const loop = () => {
  const batch = Array.from({ length: 50 }, () => msg({ id: `${runId}-${i++}` }))
  process.send({ enq: batch.map(m => m.key.id) })
  p.intake.enqueue(upsert(batch))
  setTimeout(loop, 1)
}
process.send({ ready: true })
loop()
