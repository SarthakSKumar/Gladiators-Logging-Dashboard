// Heartbeat + capture-gap bookkeeping (plan §5 "Gap detection"). A gap is any period we were not
// ONLINE. When the connection is back and the offline marker has arrived, the gap closes as
// 'recovered' (backlog messages arrived) or 'unverified'. Nothing here can prove completeness.
import { getMeta, setMeta } from './db/index.js'

const MIN_GAP_MS = 5000
const ALWAYS_UNVERIFIED = new Set(['unlinked', 'logged_out', 'restore', 'auth_rollback'])

export const createGaps = ({ db, log, now = Date.now, onClosed }) => {
  const openGap = () => db.prepare("SELECT * FROM capture_gaps WHERE status = 'open' ORDER BY id DESC LIMIT 1").get()

  const open = (cause, startedAt = now(), note = null) => {
    if (openGap()) return
    db.prepare("INSERT INTO capture_gaps (started_at, cause, status, note) VALUES (?, ?, 'open', ?)").run(startedAt, cause, note)
    log?.warn({ cause }, 'gap: opened')
  }

  const close = () => {
    const g = openGap()
    if (!g) return null
    const t = now()
    if (t - g.started_at < MIN_GAP_MS && !ALWAYS_UNVERIFIED.has(g.cause) && g.cause !== 'process_down') {
      db.prepare('DELETE FROM capture_gaps WHERE id = ?').run(g.id)
      return null
    }
    const recovered = db.prepare("SELECT count(*) FROM messages WHERE source IN ('offline','resend') AND received_at >= ?").pluck().get(g.started_at)
    const status = ALWAYS_UNVERIFIED.has(g.cause) ? 'unverified' : recovered > 0 ? 'recovered' : 'unverified'
    db.prepare('UPDATE capture_gaps SET ended_at = ?, recovered_messages = ?, status = ? WHERE id = ?').run(t, recovered, status, g.id)
    const closed = { ...g, ended_at: t, recovered_messages: recovered, status }
    log?.info({ id: g.id, status, recovered }, 'gap: closed')
    onClosed?.(closed)
    return closed
  }

  return {
    open,
    close,
    current: openGap,
    /** On boot: the last heartbeat approximates when the previous process stopped capturing. */
    onStartup: () => {
      const last = Number(getMeta(db, 'heartbeat') || 0)
      if (last) open('process_down', last, 'process was not running / crashed')
    },
    beat: () => setMeta(db, 'heartbeat', now()),
    recordRestoreGap: (from, note) => {
      db.prepare("INSERT INTO capture_gaps (started_at, ended_at, cause, status, note) VALUES (?, ?, 'restore', 'unverified', ?)").run(from, now(), note)
    },
    list: (limit = 100) => db.prepare('SELECT * FROM capture_gaps ORDER BY id DESC LIMIT ?').all(limit)
  }
}
