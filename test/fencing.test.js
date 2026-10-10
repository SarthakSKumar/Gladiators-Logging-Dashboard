import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, getMeta } from '../src/db/index.js'
import { Journal } from '../src/ingest/journal.js'
import { createAuthStore } from '../src/wa/authState.js'
import { checkAuthRollback, recordHighWater, resolveAuthRollbackByRelink, resolveEpoch } from '../src/fencing.js'
import { silent, tmpDir } from './helpers.js'

const boot = dir => {
  mkdirSync(join(dir, 'journal'), { recursive: true })
  const msgDb = openDb(join(dir, 'messages.db'), 'messages')
  const authDb = openDb(join(dir, 'auth.db'), 'auth')
  const ep = resolveEpoch({ msgDb, authDb })
  const journal = new Journal({ dir: join(dir, 'journal'), epoch: ep.epoch, log: silent })
  journal.open()
  const authStore = createAuthStore(authDb)
  const rb = checkAuthRollback({ msgDb, authStore, journal })
  if (rb.ok && ep.authEpochMissing) authDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('data_epoch', ?)").run(ep.epoch)
  return { msgDb, authDb, journal, authStore, ep, rb, close: () => { journal.close(); msgDb.close(); authDb.close() } }
}

test('restoring an older auth.db is detected (journal + messages.db witnesses) and blocks connecting', async () => {
  const dir = tmpDir()
  const a = boot(dir)
  assert.ok(a.rb.ok)
  await a.authStore.keys.set({ session: { x: Buffer.from([1]) } })
  a.authDb.pragma('wal_checkpoint(TRUNCATE)')
  copyFileSync(join(dir, 'auth.db'), join(dir, 'auth-old.db')) // snapshot of auth at counter N
  for (let i = 0; i < 3; i++) await a.authStore.keys.set({ session: { x: Buffer.from([i]) } })
  recordHighWater({ msgDb: a.msgDb, authStore: a.authStore, journal: a.journal })
  a.close()

  copyFileSync(join(dir, 'auth-old.db'), join(dir, 'auth.db')) // operator restores an old auth.db
  const b = boot(dir)
  assert.equal(b.rb.ok, false)
  assert.equal(b.rb.reason, 'auth_rollback')
  // operator chooses a fresh link: keys wiped, counter moved past every witness
  resolveAuthRollbackByRelink({ msgDb: b.msgDb, authDb: b.authDb, authStore: b.authStore, journal: b.journal, epoch: b.ep.epoch })
  assert.ok(checkAuthRollback({ msgDb: b.msgDb, authStore: b.authStore, journal: b.journal }).ok)
  assert.equal(b.authStore.isRegistered(), false)
  b.close()
})

test('mixed installs are refused; a fresh messages.db adopts the auth/journal epoch', () => {
  const d1 = tmpDir(); const d2 = tmpDir()
  boot(d1).close(); boot(d2).close()
  copyFileSync(join(d2, 'auth.db'), join(d1, 'auth.db'))
  const msgDb = openDb(join(d1, 'messages.db'), 'messages')
  const authDb = openDb(join(d1, 'auth.db'), 'auth')
  assert.equal(resolveEpoch({ msgDb, authDb }).reason, 'mixed_installs')
  msgDb.close(); authDb.close()

  const d3 = tmpDir()
  const x = boot(d3)
  const epoch = x.ep.epoch
  x.close()
  const msgDb3 = openDb(join(d3, 'messages-new.db'), 'messages') // e.g. messages.db lost; journal kept
  const authDb3 = openDb(join(d3, 'auth.db'), 'auth')
  const ep = resolveEpoch({ msgDb: msgDb3, authDb: authDb3 })
  assert.equal(ep.epoch, epoch)
  assert.equal(getMeta(msgDb3, 'data_epoch'), epoch)
  msgDb3.close(); authDb3.close()
})
