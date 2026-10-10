// Phase 0 spike recorder. Isolated: imports nothing from ../src, own auth dir, own tape.
// Usage: node record.js [--online] [--label outage-1h]
//   --online   markOnlineOnConnect=true (A/B test for offline backlog delivery)
// Tape: data/tape-<label>-<ts>.ndjson — one line per Baileys event, with receive timestamps.
// The tape contains real group content: it is git-ignored; delete it after writing FINDINGS.md.
import { mkdirSync, openSync, writeSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import makeWASocket, { BufferJSON, DisconnectReason, useMultiFileAuthState } from 'baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'

const args = process.argv.slice(2)
const online = args.includes('--online')
const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : 'run'
const dataDir = join(import.meta.dirname, 'data')
mkdirSync(dataDir, { recursive: true })
const tapePath = join(dataDir, `tape-${label}-${Date.now()}.ndjson`)
const tape = openSync(tapePath, 'a')
const t0 = process.hrtime.bigint()

const write = (kind, payload) => {
  const line = JSON.stringify({
    kind,
    at: Date.now(),
    mono_ms: Number(process.hrtime.bigint() - t0) / 1e6,
    payload
  }, BufferJSON.replacer)
  writeSync(tape, line + '\n')
  fsyncSync(tape) // spike measures receive→durable latency including fsync
}

const keyTypeHistogram = {}
let pendingDoneAt = null
let msgsAfterPending = 0

const start = async () => {
  const { state, saveCreds } = await useMultiFileAuthState(join(dataDir, 'auth'))
  const keys = {
    get: (type, ids) => state.keys.get(type, ids),
    set: async (data) => {
      for (const type in data) keyTypeHistogram[type] = (keyTypeHistogram[type] || 0) + Object.keys(data[type]).length
      return state.keys.set(data)
    }
  }
  const sock = makeWASocket({
    auth: { creds: state.creds, keys },
    logger: pino({ level: 'warn' }),
    markOnlineOnConnect: online,
    syncFullHistory: false
  })
  write('meta', { label, online, pid: process.pid, node: process.version })

  sock.ev.process(async (events) => {
    const recvMono = Number(process.hrtime.bigint() - t0) / 1e6
    for (const [name, data] of Object.entries(events)) {
      if (name === 'creds.update') { await saveCreds(); write(name, { keys: Object.keys(data) }); continue }
      write(name, data)
      if (name === 'messages.upsert') {
        const n = data.messages.length
        if (pendingDoneAt) msgsAfterPending += n
        console.log(`[upsert] type=${data.type} n=${n}${data.requestId ? ' requestId=' + data.requestId : ''}`)
      }
      if (name === 'connection.update') {
        const { connection, lastDisconnect, qr, receivedPendingNotifications } = data
        if (qr) { console.log('Scan with the spare phone: WhatsApp > Linked devices > Link a device'); qrcode.generate(qr, { small: true }) }
        if (receivedPendingNotifications) { pendingDoneAt = Date.now(); console.log(`[pending] receivedPendingNotifications at ${new Date(pendingDoneAt).toISOString()}`) }
        if (connection) console.log(`[conn] ${connection}`)
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode
          write('disconnect', { code, message: lastDisconnect?.error?.message })
          console.log(`[close] code=${code} (${Object.keys(DisconnectReason).filter(k => DisconnectReason[k] === code).join('/')})`)
          if (code === DisconnectReason.loggedOut || code === DisconnectReason.connectionReplaced) {
            console.log('Not reconnecting (logged out / replaced).'); summary(); process.exit(0)
          }
          setTimeout(start, code === DisconnectReason.restartRequired ? 0 : 3000)
        }
      }
    }
    write('_batch', { recvMono, names: Object.keys(events) })
  })

  // Phase 0 item J: group listing timing and fields
  sock.ev.on('connection.update', async ({ connection }) => {
    if (connection !== 'open') return
    const t = Date.now()
    try {
      const groups = await sock.groupFetchAllParticipating()
      write('groups.fetchAll', { ms: Date.now() - t, groups: Object.values(groups).map(g => ({ id: g.id, subject: g.subject, size: g.size ?? g.participants.length, creation: g.creation, addressingMode: g.addressingMode })) })
      console.log(`[groups] ${Object.keys(groups).length} groups in ${Date.now() - t}ms`)
    } catch (err) { write('groups.fetchAll.error', { message: err.message }) }
  })
}

const summary = () => {
  write('summary', { keyTypeHistogram, pendingDoneAt, msgsAfterPending })
  console.log('key types written:', keyTypeHistogram, '| messages after pending flag:', msgsAfterPending)
}
process.on('SIGINT', () => { summary(); process.exit(0) })
console.log(`Recording to ${tapePath} (markOnlineOnConnect=${online})`)
start()
