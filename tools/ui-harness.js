// DEV/QA ONLY — never used in production. Runs the real server code (startApp) on a *copy* of a data
// directory with a scripted WhatsApp socket, so every dashboard state can be clicked through without a
// phone. Usage: node tools/ui-harness.js <data-dir-to-copy> [port]
//   linked by default; append "unlinked" to start on the Link page.
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { config } from '../src/config.js'
import { startApp } from '../src/app.js'
import { makeFakeSocketFactory } from '../test/fakesock.js'

const [src = 'data', port = '3100', mode = 'linked'] = process.argv.slice(2)
const dir = mkdtempSync(join(tmpdir(), 'walog-ui-'))
cpSync(src, join(dir, 'data'), { recursive: true, filter: p => !p.endsWith('instance.lock') })
const log = pino({ level: 'info' })
const f = makeFakeSocketFactory({ closeDelayMs: 50 })
let n = 0
let app = null

const factory = opts => {
  const sock = f.factory(opts)
  // the account's group list = the copy's known groups, read when asked (app may not exist yet at first connect)
  sock.groupFetchAllParticipating = async () => {
    const groups = app.msgDb.prepare("SELECT jid, coalesce(subject_current, label) AS subject FROM groups WHERE jid IS NOT NULL UNION SELECT jid, subject FROM account_groups").all()
    return Object.fromEntries(groups.map((g, i) => [g.jid, { id: g.jid, subject: g.subject, size: 40 + i * 17 }]))
  }
  setTimeout(async () => {
    if (!opts.auth.creds.me) {
      await sock.emit({ 'connection.update': { qr: `2@harness-${Date.now()}` } })
      // like WhatsApp: the QR expires if nobody scans it (shortened for QA)
      setTimeout(() => sock.close(408, 'QR refs attempts ended'), Number(process.env.HARNESS_QR_MS || 8000))
      return
    }
    await sock.emit({ 'connection.update': { connection: 'open' } })
    await sock.emit({ 'connection.update': { receivedPendingNotifications: true } })
  }, 600)
  // while connected, a scripted bettor posts a text message every few seconds into logging groups
  const timer = setInterval(async () => {
    if (sock.ended) return clearInterval(timer)
    if (!app) return
    const live = app.msgDb.prepare(`SELECT g.jid FROM sessions s JOIN groups g ON g.id = s.group_id WHERE s.ended_at IS NULL`).all()
    for (const { jid } of live) {
      n++
      await sock.emit({
        'messages.upsert': {
          type: 'notify',
          messages: [{ key: { remoteJid: jid, id: `HARNESS${Date.now()}${n}`, participant: `9198450${String(n % 9).padStart(5, '0')}@s.whatsapp.net`, fromMe: false },
            messageTimestamp: Math.floor(Date.now() / 1000), pushName: ['Ravi', 'Imran', 'Kiran', 'Deepa'][n % 4], message: { conversation: `${(n % 9) + 1} w ${(n % 5 + 1) * 100}` } }]
        }
      })
    }
  }, 4000)
  return sock
}

// The Google Sheets forwarder NEVER touches the network here: a scripted stand-in for the Apps Script answers
// (mostly success; a missing RACE sheet for race 9; an occasional network failure).
let calls = 0
const sheetsFetch = async (url, init) => {
  const p = JSON.parse(init.body)
  calls++
  if (calls % 7 === 0) throw new Error('fetch failed')
  const body = p.raceNumber === '9'
    ? { status: 'error', message: 'Template Sheet not found!' }
    : { status: 'success', message: `Bet logged at row ${p.id + 2} (ID: ${p.id}), Horse: ${(p.id % 9) + 1}, Win: ${(p.id % 5 + 1) * 100}, Place: 0` }
  await new Promise(r => setTimeout(r, 150 + (calls % 5) * 220))
  return { ok: true, status: 200, redirected: true, url: 'https://script.googleusercontent.com/macros/echo?user_content_key=harness', text: async () => JSON.stringify(body) }
}

app = await startApp({
  config: { ...config, dataDir: join(dir, 'data'), backupDir: join(dir, 'backups'), port: Number(port), devOtpToConsole: true, sheetsFetch },
  log, makeSocket: factory, getVersion: async () => undefined, mailer: { configured: false, send: async () => {} }
})
if (mode === 'unlinked') {
  app.authStore.wipe()
  await app.capture.reconcile()
} else {
  app.authStore.creds.me = { id: '919742913699:7@s.whatsapp.net', name: 'Gladiators Logger' }
  await app.authStore.saveCreds()
  app.capture.lease('harness', 15_000)
  await app.capture.reconcile()
}
console.log(`UI harness on http://127.0.0.1:${port} (data copy in ${dir}); sign in → the OTP is printed here`)
