import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { proto } from 'baileys'
import { openDb } from '../src/db/index.js'
import { createAuthStore } from '../src/wa/authState.js'
import { tmpDir } from './helpers.js'

const fresh = () => { const dir = tmpDir(); return { dir, db: openDb(join(dir, 'auth.db'), 'auth') } }

test('every v7 key type round-trips binary-safely through a reopen', async () => {
  const { dir, db } = fresh()
  const s = createAuthStore(db)
  const data = {
    'pre-key': { 1: { private: Buffer.from([1, 2, 3]), public: new Uint8Array([4, 5, 6]) } },
    session: { 'a.0': new Uint8Array([9, 8, 7, 0, 255]) },
    'sender-key': { 'g::a': Buffer.from('sk') },
    'sender-key-memory': { g: { 'a@s.whatsapp.net': true } },
    'app-state-sync-key': { K1: { keyData: Buffer.from([1, 1]), fingerprint: { rawId: 5, currentIndex: 1, deviceIndexes: [0, 1] }, timestamp: 1790000000 } },
    'app-state-sync-version': { regular: { version: 3, hash: Buffer.alloc(128, 7), indexValueMap: { abc: { valueMac: Buffer.from([1]) } } } },
    'lid-mapping': { '1234': '919000000001' },
    'device-list': { '9190': ['0', '12'] },
    tctoken: { 'x@s.whatsapp.net': { token: Buffer.from('tok'), timestamp: '1790000000' } },
    'identity-key': { 'a.0': new Uint8Array([33, 44]) }
  }
  await s.keys.set(data)
  s.creds.registrationId = 4242
  await s.saveCreds()
  db.close()

  const db2 = openDb(join(dir, 'auth.db'), 'auth')
  const s2 = createAuthStore(db2)
  assert.equal(s2.creds.registrationId, 4242)
  for (const [type, entries] of Object.entries(data)) {
    const ids = Object.keys(entries)
    const got = await s2.keys.get(type, ids)
    for (const id of ids) {
      const want = entries[id]
      const have = got[id]
      if (type === 'app-state-sync-key') {
        assert.ok(have instanceof proto.Message.AppStateSyncKeyData, 'revived as protobuf')
        assert.deepEqual(Buffer.from(have.keyData), Buffer.from(want.keyData))
      } else if (want instanceof Uint8Array) {
        assert.ok(have instanceof Uint8Array, `${type} stays binary`)
        assert.deepEqual(Buffer.from(have), Buffer.from(want))
      } else if (type === 'pre-key') {
        assert.deepEqual(Buffer.from(have.private), Buffer.from(want.private))
        assert.deepEqual(Buffer.from(have.public), Buffer.from(want.public))
      } else if (type === 'app-state-sync-version') {
        assert.deepEqual(Buffer.from(have.hash), want.hash)
        assert.equal(have.version, 3)
      } else if (type === 'tctoken') {
        assert.deepEqual(Buffer.from(have.token), want.token)
      } else assert.deepEqual(have, want)
    }
  }
  assert.equal((await s2.keys.get('session', ['missing'])).missing, null)
  db2.close()
})

test('null deletes; each set is atomic; counter is monotonic and survives wipe', async () => {
  const { db } = fresh()
  const s = createAuthStore(db)
  await s.keys.set({ session: { a: Buffer.from([1]), b: Buffer.from([2]) } })
  const c1 = s.writeCounter()
  await s.keys.set({ session: { a: null } })
  assert.equal((await s.keys.get('session', ['a'])).a, null)
  assert.ok(s.writeCounter() > c1)
  // a failing write inside one set() rolls back the whole call
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON auth_keys WHEN NEW.id = 'bad' BEGIN SELECT RAISE(FAIL, 'x'); END")
  await assert.rejects(s.keys.set({ session: { c: Buffer.from([3]), bad: Buffer.from([4]) } }))
  assert.equal((await s.keys.get('session', ['c'])).c, null)
  db.exec('DROP TRIGGER boom')
  const before = s.writeCounter()
  s.wipe()
  assert.ok(s.writeCounter() > before, 'wipe never resets the counter')
  assert.equal(s.isRegistered(), false)
  assert.equal(db.prepare('SELECT count(*) FROM auth_keys').pluck().get(), 0)
  db.close()
})
