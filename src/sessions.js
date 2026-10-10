// Logical logging sessions (plan §8). Start/Stop never touch ingestion.
// Membership: a message belongs to a session iff, for the same group,
//   floor_s(started_at) <= wa_timestamp < floor_s(ended_at)      (whole seconds, half-open; open-ended while active)
// wa_timestamp is the sender-claimed send time (WhatsApp gives whole seconds). received_at is stored too
// but does NOT decide membership; it only drives the "late arrival" badge.
const httpError = (status, message) => Object.assign(new Error(message), { status })

export const sec = ms => Math.floor(ms / 1000) * 1000

/** SQL fragment + params selecting messages of a session (alias m). */
export const sessionWindow = s => ({
  sql: 'm.group_id = ? AND m.wa_timestamp >= ?' + (s.ended_at == null ? '' : ' AND m.wa_timestamp < ?'),
  params: s.ended_at == null ? [s.group_id, sec(s.started_at)] : [s.group_id, sec(s.started_at), sec(s.ended_at)]
})

export const createSessions = ({ db, now = Date.now, onChange }) => {
  const get = id => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)

  const start = ({ groupId, label, raceNumber, by }) => {
    label = String(label ?? '').trim()
    if (!label) throw httpError(400, 'A session label is required')
    if (label.length > 80) throw httpError(400, 'Label is too long (max 80 characters)')
    let race = null
    if (raceNumber !== undefined && raceNumber !== null && raceNumber !== '') {
      race = Number(raceNumber)
      if (!Number.isInteger(race) || race < 1 || race > 10) throw httpError(400, 'Race number must be 1–10')
    }
    const g = db.prepare('SELECT id FROM groups WHERE id = ? AND enabled = 1').get(groupId)
    if (!g) throw httpError(404, 'Unknown group')
    try {
      const { lastInsertRowid } = db.prepare('INSERT INTO sessions (group_id, label, race_number, started_at, started_by) VALUES (?, ?, ?, ?, ?)')
        .run(groupId, label, race, now(), by ?? null)
      onChange?.()
      return get(lastInsertRowid)
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) throw httpError(409, 'A session is already running for this group')
      throw err
    }
  }

  const stop = ({ id, by, reason = 'user' }) => {
    const s = get(id)
    if (!s) throw httpError(404, 'Unknown session')
    if (s.ended_at != null) throw httpError(409, 'Session already ended')
    db.prepare('UPDATE sessions SET ended_at = ?, ended_by = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL').run(Math.max(now(), s.started_at), by ?? null, reason, id)
    onChange?.()
    return get(id)
  }

  const stats = s => {
    const w = sessionWindow(s)
    const count = db.prepare(`SELECT count(*) FROM messages m WHERE ${w.sql}`).pluck().get(...w.params)
    const late = s.ended_at == null ? 0 : db.prepare(`SELECT count(*) FROM messages m WHERE ${w.sql} AND m.received_at > ?`).pluck().get(...w.params, s.ended_at)
    const end = s.ended_at ?? now()
    const gaps = db.prepare(`SELECT id, started_at, ended_at, cause, status, recovered_messages FROM capture_gaps
      WHERE started_at < ? AND coalesce(ended_at, ?) > ?`).all(end, now(), s.started_at)
    return { ...s, message_count: count, late_arrivals: late, gaps }
  }

  return {
    start,
    stop,
    get,
    stats,
    active: () => db.prepare('SELECT * FROM sessions WHERE ended_at IS NULL').all(),
    list: ({ groupId, limit = 50 } = {}) => db.prepare(`SELECT * FROM sessions ${groupId ? 'WHERE group_id = ?' : ''} ORDER BY started_at DESC LIMIT ?`)
      .all(...(groupId ? [groupId, limit] : [limit])).map(stats)
  }
}
