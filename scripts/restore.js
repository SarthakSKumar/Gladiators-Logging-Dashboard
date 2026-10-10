// Restore a backup SET (plan §6). Run with the service STOPPED:
//   node scripts/restore.js backups/set-…            # messages.db only (default, safe)
//   node scripts/restore.js backups/set-… --include-auth   # also auth.db (rolls back keys: re-link expected)
// The current journal is kept, so records newer than the set are replayed on the next start; anything
// older than the retained journal is recorded as an 'unverified' restore gap.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config } from '../src/config.js'
import { getMeta, openDb } from '../src/db/index.js'

const [setArg, ...flags] = process.argv.slice(2)
if (!setArg) { console.error('usage: node scripts/restore.js <backup-set-dir> [--include-auth]'); process.exit(1) }
const set = resolve(setArg)
const includeAuth = flags.includes('--include-auth')
const lock = join(config.dataDir, 'instance.lock')
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, 'utf8'))
  let alive = false
  try { process.kill(pid, 0); alive = true } catch (e) { alive = e.code === 'EPERM' }
  if (alive) { console.error(`The logger is running (pid ${pid}). Stop the service first.`); process.exit(1) }
}
const manifest = JSON.parse(readFileSync(join(set, 'manifest.json'), 'utf8'))
const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex')
for (const f of ['messages.db', 'auth.db']) {
  if (sha(join(set, f)) !== manifest.files[f]) { console.error(`${f} does not match the manifest — set is corrupt`); process.exit(1) }
}
const live = join(config.dataDir, 'messages.db')
if (existsSync(live)) {
  const db = openDb(live, 'messages')
  const epoch = getMeta(db, 'data_epoch')
  db.close()
  if (epoch && epoch !== manifest.data_epoch) { console.error(`Set belongs to install ${manifest.data_epoch}, live data is ${epoch}. Refusing.`); process.exit(1) }
}
const aside = join(config.dataDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(aside, { recursive: true })
const files = includeAuth ? ['messages.db', 'auth.db'] : ['messages.db']
for (const f of files) {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = join(config.dataDir, f + suffix)
    if (existsSync(p)) renameSync(p, join(aside, f + suffix))
  }
  copyFileSync(join(set, f), join(config.dataDir, f))
}
console.log(`Restored ${files.join(' + ')} from ${set} (previous files moved to ${aside}).`)
if (includeAuth) console.log('WARNING: auth.db was rolled back. On start, the dashboard will require "Start fresh link" (QR scan) if keys are older than recorded.')
console.log('Start the service; the journal replays newer records automatically. Check Settings → Capture gaps.')
