// Consistent backup *set* of both databases (plan §6). The two VACUUM INTO statements run back-to-back
// on this (only) thread, so no auth or message write can interleave: the pair is mutually consistent.
// Restore with scripts/restore.js — it restores sets, defaults to messages.db only, never single files.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMeta } from './db/index.js'

const KEEP_SETS = 14
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')

export const runBackup = ({ msgDb, authDb, journal, dir, log }) => {
  mkdirSync(dir, { recursive: true })
  const name = `set-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const target = join(dir, name)
  mkdirSync(target)
  msgDb.prepare('VACUUM INTO ?').run(join(target, 'messages.db'))
  authDb.prepare('VACUUM INTO ?').run(join(target, 'auth.db'))
  const manifest = {
    created: new Date().toISOString(),
    data_epoch: getMeta(msgDb, 'data_epoch'),
    applied_through_jseq: Number(getMeta(msgDb, 'applied_through_jseq') || 0),
    auth_write_counter: Number(getMeta(authDb, 'auth_write_counter') || 0),
    journal: { durableJseq: journal.durableJseq, firstRetainedJseq: journal.firstRetainedJseq(), segments: journal.segments.map(s => ({ n: s.n, firstJseq: s.firstJseq, lastJseq: s.lastJseq, size: s.size })) },
    files: { 'messages.db': sha(join(target, 'messages.db')), 'auth.db': sha(join(target, 'auth.db')) }
  }
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2))
  // rotate old *backup copies* (records themselves are never purged)
  const sets = readdirSync(dir).filter(f => f.startsWith('set-')).sort()
  for (const old of sets.slice(0, Math.max(0, sets.length - KEEP_SETS))) rmSync(join(dir, old), { recursive: true, force: true })
  log?.info({ set: name }, 'backup: set written')
  return { set: name, manifest }
}
