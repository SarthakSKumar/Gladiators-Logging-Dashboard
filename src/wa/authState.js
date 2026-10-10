// Baileys v7 persistent auth state on SQLite (plan §5).
// - Generic `type` column: all v7 key types (pre-key, session, sender-key, sender-key-memory,
//   app-state-sync-key, app-state-sync-version, lid-mapping, device-list, tctoken, identity-key) and any
//   future ones are stored without code changes.
// - Values use Baileys' BufferJSON (same as the reference file store) → binary-safe and compatible.
// - better-sqlite3 is synchronous with synchronous=FULL: every write is durable before it returns.
// - Each keys.set() call is one transaction; every write bumps a monotonic counter (rollback fencing).
import { BufferJSON, initAuthCreds, proto } from 'baileys'
import { getMeta, setMeta } from '../db/index.js'

export const AUTH_FORMAT_VERSION = 1

const encode = v => JSON.stringify(v, BufferJSON.replacer)
const decode = s => JSON.parse(s, BufferJSON.reviver)

export const createAuthStore = (db, { log } = {}) => {
  const getCreds = db.prepare('SELECT value FROM auth_creds WHERE id = 1').pluck()
  const putCreds = db.prepare(`INSERT INTO auth_creds (id, value, format_version) VALUES (1, ?, ${AUTH_FORMAT_VERSION})
    ON CONFLICT(id) DO UPDATE SET value = excluded.value, format_version = excluded.format_version`)
  const getKey = db.prepare('SELECT value FROM auth_keys WHERE type = ? AND id = ?').pluck()
  const putKey = db.prepare(`INSERT INTO auth_keys (type, id, value, format_version) VALUES (?, ?, ?, ${AUTH_FORMAT_VERSION})
    ON CONFLICT(type, id) DO UPDATE SET value = excluded.value, format_version = excluded.format_version`)
  const delKey = db.prepare('DELETE FROM auth_keys WHERE type = ? AND id = ?')
  const bump = db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'auth_write_counter'")
  const seenTypes = new Set()

  const stored = getCreds.get()
  let creds = stored ? decode(stored) : initAuthCreds()

  const saveCreds = db.transaction(() => { putCreds.run(encode(creds)); bump.run() })

  const keys = {
    get: async (type, ids) => {
      const out = {}
      for (const id of ids) {
        const raw = getKey.get(type, id)
        let value = raw === undefined ? null : decode(raw)
        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
        out[id] = value
      }
      return out
    },
    set: db.transaction(data => {
      for (const type in data) {
        if (!seenTypes.has(type)) { seenTypes.add(type); log?.info({ type }, 'auth: key type in use') }
        for (const id in data[type]) {
          const value = data[type][id]
          // same semantics as the reference store: falsy value = delete
          if (value) putKey.run(type, id, encode(value)); else delKey.run(type, id)
        }
      }
      bump.run()
    })
  }
  // async facade (Baileys awaits these); the work above is already synchronous and durable
  const setSync = keys.set
  keys.set = async data => { setSync(data) }

  return {
    get creds () { return creds },
    keys,
    saveCreds: async () => saveCreds(),
    isRegistered: () => Boolean(creds.me?.id),
    writeCounter: () => Number(getMeta(db, 'auth_write_counter') || 0),
    /** Remove credentials and keys (logout / relink). The counter keeps increasing — never reset. */
    wipe: db.transaction(() => {
      db.prepare('DELETE FROM auth_keys').run()
      db.prepare('DELETE FROM auth_creds').run()
      bump.run()
      setMeta(db, 'auth_epoch', Number(getMeta(db, 'auth_epoch') || 0) + 1)
      creds = initAuthCreds()
    }),
    /** fencing: allow a deliberate fresh start to move the counter past a recorded high-water mark */
    raiseCounterTo: n => db.prepare("UPDATE meta SET value = ? WHERE key = 'auth_write_counter' AND CAST(value AS INTEGER) < ?").run(String(n), n),
    keyTypes: () => db.prepare('SELECT type, count(*) n FROM auth_keys GROUP BY type').all()
  }
}
