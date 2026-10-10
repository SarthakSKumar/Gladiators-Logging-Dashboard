// Typed operator events (stored + pushed live). pino stays for diagnostics, but anything an operator
// should know about goes through emit(): { level, code, message, context, noise }.
//   level: 'info' | 'warn' | 'error'   noise: expected/benign → shown in Logs, never toasted
const COALESCE_MS = 60_000

export const createOpsEvents = ({ db, bus, log, now = Date.now }) => {
  const insert = db.prepare(`INSERT INTO ops_events (ts, last_ts, level, code, message, context_json, noise)
    VALUES (@ts, @ts, @level, @code, @message, @context_json, @noise)`)
  const recent = db.prepare('SELECT id, count FROM ops_events WHERE code = ? AND message = ? AND last_ts > ? ORDER BY id DESC LIMIT 1')
  const bump = db.prepare('UPDATE ops_events SET count = count + 1, last_ts = ?, context_json = ? WHERE id = ?')
  const get = db.prepare('SELECT * FROM ops_events WHERE id = ?')

  const toPublic = r => r && ({ ...r, context: r.context_json ? JSON.parse(r.context_json) : null, context_json: undefined, noise: Boolean(r.noise) })

  const emit = ({ level = 'info', code, message, context = null, noise = false }) => {
    const ts = now()
    const context_json = context ? JSON.stringify(context) : null
    let row
    try {
      // coalesce repeated problems/noise; distinct info transitions (capture started/stopped…) stay separate
      const prev = level !== 'info' || noise ? recent.get(code, message, ts - COALESCE_MS) : null
      if (prev) { bump.run(ts, context_json, prev.id); row = get.get(prev.id) } else {
        const { lastInsertRowid } = insert.run({ ts, level, code, message, context_json, noise: noise ? 1 : 0 })
        row = get.get(lastInsertRowid)
      }
    } catch (err) {
      // storage failing must not hide the event: still log and push it
      log.error({ err: err.message, code }, 'events: could not store operator event')
      row = { id: -ts, ts, last_ts: ts, level, code, message, context_json, noise: noise ? 1 : 0, count: 1 }
    }
    const ev = toPublic(row)
    log[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']({ code, ...(context || {}) }, message)
    bus.emit('opevent', ev)
    return ev
  }

  return {
    emit,
    list: ({ limit = 200, beforeId, minLevel } = {}) => {
      const levels = minLevel === 'error' ? ['error'] : minLevel === 'warn' ? ['warn', 'error'] : ['info', 'warn', 'error']
      return db.prepare(`SELECT * FROM ops_events WHERE level IN (${levels.map(() => '?').join(',')}) ${beforeId ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?`)
        .all(...levels, ...(beforeId ? [beforeId] : []), Math.min(limit, 1000)).map(toPublic)
    },
    countSince: (prefix, since, level = 'error') =>
      db.prepare("SELECT coalesce(sum(count), 0) FROM ops_events WHERE code LIKE ? AND level = ? AND last_ts >= ?").pluck().get(`${prefix}%`, level, since)
  }
}

// ---- Baileys log classification -------------------------------------------------------------
// Baileys reports some failures only through its logger (e.g. a message whose receipt could not be
// sent because the socket closed). This turns the ones that matter into typed operator events.
const SEND_ON_CLOSED = new Set([
  'error in sending presence update on name change', 'keep alive called when WS not open', 'error in sending keep alive',
  'failed to ack receipt', 'failed to ack notification', 'failed to ack message after error', 'failed to ack call', 'received error in ack'
])

const attr = (node, k) => (typeof node === 'string' ? node.match(new RegExp(`\\b${k}="([^"]+)"`))?.[1] : undefined)

/**
 * @param {number} level pino numeric level (40 warn, 50 error)
 * @param {any[]} args   the logger call arguments
 * @param {{ emit, groupOf: (jid) => {label}|null }} deps
 */
export const classifyBaileysLog = (level, args, { emit, groupOf }) => {
  if (level < 40) return
  const [obj, msg] = typeof args[0] === 'string' ? [{}, args[0]] : [args[0] || {}, args[1] || '']
  const err = obj.error || obj.err
  const reason = err?.message || (typeof obj.trace === 'string' ? obj.trace.split('\n')[0] : undefined)
  const statusCode = err?.output?.statusCode

  if (msg === 'error in handling message') {
    const from = attr(obj.node, 'from')
    const group = from?.endsWith('@g.us') ? groupOf(from) : null
    const context = { from, id: attr(obj.node, 'id'), participant: attr(obj.node, 'participant'), type: attr(obj.node, 'type'), reason, statusCode, group: group?.label }
    if (!group) return emit({ level: 'info', code: 'ingest.message_failed_other', message: 'A message outside the selected groups could not be processed', context, noise: true })
    return emit({
      level: 'error',
      code: 'ingest.message_failed',
      message: `A message in "${group.label}" could not be processed${statusCode === 428 ? ' (connection was closing)' : ''}. WhatsApp should redeliver it because it was not acknowledged; check the group for gaps.`,
      context
    })
  }
  if (SEND_ON_CLOSED.has(msg)) {
    return emit({ level: 'info', code: 'wa.send_on_closed_socket', message: `WhatsApp client tried to send on a closed connection (${msg})`, context: { reason }, noise: true })
  }
  if (msg === 'failed to decrypt message') return // handled by intake with group context (ingest.undecryptable)
  if (msg === 'failed to process sender key distribution message') {
    return emit({ level: 'warn', code: 'ingest.sender_key_failed', message: 'Could not process a group encryption key; later messages from that sender may fail to decrypt', context: { reason, from: obj.key?.remoteJid } })
  }
  if (msg === 'Failed to upload pre-keys to server') return emit({ level: 'warn', code: 'wa.prekeys_failed', message: 'Could not upload encryption pre-keys to WhatsApp', context: { reason } })
  if (msg.startsWith('error 463')) return emit({ level: 'error', code: 'wa.restricted', message: 'WhatsApp reports the account as restricted (error 463)', context: { reason } })
  if (msg.startsWith('Timeout in AwaitingInitialSync')) return emit({ level: 'info', code: 'wa.initial_sync_timeout', message: 'Initial sync timed out; WhatsApp client continued', noise: true })
  if (level >= 50) return emit({ level: 'warn', code: 'wa.client_error', message: `WhatsApp client error: ${msg}`, context: { reason, statusCode } })
}
