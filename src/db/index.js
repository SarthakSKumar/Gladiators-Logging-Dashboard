import Database from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(import.meta.dirname, 'migrations')

/**
 * Opens a SQLite file with the durability settings from the plan and applies pending
 * migrations named `<prefix>-NNN.sql` (tracked with PRAGMA user_version).
 */
export const openDb = (file, prefix) => {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL') // durability over speed: a commit survives power loss
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  migrate(db, prefix)
  return db
}

const migrate = (db, prefix) => {
  const current = db.pragma('user_version', { simple: true })
  const files = readdirSync(MIGRATIONS)
    .filter(f => f.startsWith(prefix + '-') && f.endsWith('.sql'))
    .map(f => ({ f, v: Number(f.slice(prefix.length + 1, -4)) }))
    .sort((a, b) => a.v - b.v)
  for (const { f, v } of files) {
    if (v <= current) continue
    db.transaction(() => {
      db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'))
      db.pragma(`user_version = ${v}`)
    })()
  }
}

export const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(key)
export const setMeta = (db, key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value))
