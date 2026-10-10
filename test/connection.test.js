import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from '../src/wa/connection.js'
import { makeFakeSocketFactory } from './fakesock.js'
import { silent } from './helpers.js'

const flush = () => new Promise(r => setImmediate(r))
const setup = ({ registered = true } = {}) => {
  const f = makeFakeSocketFactory()
  const auth = {
    creds: registered ? { me: { id: '919876543210:5@s.whatsapp.net' } } : {},
    keys: { get: async () => ({}), set: async () => {} },
    wipes: 0,
    saveCreds: async () => {},
    isRegistered () { return Boolean(this.creds.me) },
    wipe () { this.wipes++; this.creds = {} }
  }
  const states = []
  const enqueued = []
  const stops = []
  const conn = createConnection({
    authStore: auth, log: silent, baileysLogger: silent, makeSocket: f.factory, getVersion: async () => undefined, random: () => 0.5,
    intake: { enqueue: e => enqueued.push(e) },
    onState: s => states.push(s.state)
  })
  return { f, auth, conn, states, enqueued }
}
// every test must stop its connections: pending 60 s / 5 min timers would keep node:test waiting
const tracked = []
const track = x => { tracked.push(x.conn); return x }
test.afterEach(() => { while (tracked.length) tracked.pop().stop() })

test('link flow: QR → linked → restart required → syncing → online only after the offline marker', async () => {
  const { f, conn, auth, states } = track(setup({ registered: false }))
  await conn.start()
  await f.last().emit({ 'connection.update': { qr: '2@abc,def' } })
  assert.equal(conn.state().state, 'NEEDS_LINK')
  assert.match(conn.state().qr, /^<svg/)
  await f.last().emit({ 'connection.update': { isNewLogin: true } })
  assert.equal(conn.state().state, 'LINKING')
  auth.creds = { me: { id: '919876543210:5@s.whatsapp.net' } } // Baileys stores creds during pairing
  await f.last().close(515)
  await flush()
  assert.equal(f.sockets.length, 2, 'restartRequired reconnects immediately')
  await f.last().emit({ 'connection.update': { connection: 'open' } })
  assert.equal(conn.state().state, 'SYNCING')
  await f.last().emit({ 'connection.update': { receivedPendingNotifications: true } })
  assert.equal(conn.state().state, 'ONLINE')
  assert.ok(states.includes('LINKING'))
})

test('transient drop → RECONNECTING with backoff; replaced → no auto reconnect; restricted → slow retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { f, conn } = track(setup())
  await conn.start()
  await f.last().emit({ 'connection.update': { connection: 'open', receivedPendingNotifications: true } })
  await f.last().close(428)
  assert.equal(conn.state().state, 'RECONNECTING')
  assert.equal(conn.state().attempt, 1)
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(f.sockets.length, 2)
  await f.last().close(440)
  assert.equal(conn.state().state, 'REPLACED')
  t.mock.timers.tick(10 * 60_000)
  await flush()
  assert.equal(f.sockets.length, 2, 'never reconnects on its own after being replaced')
  conn.restart()
  await flush()
  await f.last().close(403)
  assert.equal(conn.state().state, 'RESTRICTED')
})

test('logged out by the phone → keys wiped, QR flow restarts; messages from the old socket still ingested', async () => {
  const { f, conn, auth, enqueued } = track(setup())
  await conn.start()
  const old = f.last()
  await old.emit({ 'connection.update': { connection: 'open', receivedPendingNotifications: true } })
  await old.close(401)
  await flush()
  assert.equal(auth.wipes, 1)
  assert.equal(conn.state().state, 'NEEDS_LINK')
  assert.equal(f.sockets.length, 2)
  await old.emit({ 'messages.upsert': { messages: [{ key: { id: 'late' } }], type: 'notify' } })
  assert.ok(enqueued.some(e => e['messages.upsert']?.messages[0].key.id === 'late'))
})

test('dashboard unlink → logout on WhatsApp, wipe, LINK_IDLE; suspend/resume; bad-session escalation', async () => {
  const { f, conn, auth } = track(setup())
  await conn.start()
  await f.last().emit({ 'connection.update': { connection: 'open', receivedPendingNotifications: true } })
  conn.suspend('disk_low')
  await flush()
  assert.equal(conn.state().state, 'SUSPENDED')
  conn.resume()
  await flush()
  await f.last().emit({ 'connection.update': { connection: 'open', receivedPendingNotifications: true } })
  assert.equal(conn.state().state, 'ONLINE')
  await conn.unlink()
  assert.equal(auth.wipes, 1)
  assert.equal(conn.state().state, 'LINK_IDLE')

  const b = track(setup())
  await b.conn.start()
  for (let i = 0; i < 10; i++) { await b.f.last().close(500); b.conn.restart(); await flush() }
  assert.equal(b.conn.state().state === 'NEEDS_OPERATOR' || b.states.includes('NEEDS_OPERATOR'), true)
})
