// Custom integration: forward every logged message of the two Gladiators groups to their Google Apps Script
// endpoint, exactly like the Android "Gladiators Bet Reader" app did (app/.../NotificationListener.kt).
//
//   POST <url>  Content-Type: application/json
//   { "id": <int>, "sender": "<name>", "message": "<text>", "groupName": "<script's group name>",
//     "timestamp": <ms epoch>, "raceNumber": "<1-10>" }
//   → { "status": "success" | "error", "message": "..." }
//
// The script opens the spreadsheet chosen by `groupName`, sheet "RACE <raceNumber>", and writes row id + 2
// (S.No, IST time, sender, message, …). So:
//   - raceNumber = the logging session's race number (required for these groups — it selects the sheet)
//   - id         = 1, 2, 3… per session in arrival order, assigned once and stored → retries overwrite the
//                  same row, never duplicate it
// Delivery is durable: an outbox row is created in the database for each message; a worker sends pending
// rows with retries/backoff, survives restarts, and reports failures as operator events.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const BATCH = 200
const CONCURRENCY = 4
const MAX_ATTEMPTS = 8
const TIMEOUT_MS = 45_000
const backoffMs = attempts => Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1))

/** config/sheets.json: { "targets": [{ "key", "groupJid", "groupName", "url" }] } (missing file = disabled) */
export const loadSheetsConfig = configDir => {
  const file = join(configDir, 'sheets.json')
  if (!existsSync(file)) return []
  const { targets = [] } = JSON.parse(readFileSync(file, 'utf8'))
  for (const t of targets) {
    if (!t.key || !t.groupJid?.endsWith('@g.us') || !t.groupName || !/^https:\/\//.test(t.url || '')) {
      throw new Error(`config/sheets.json: each target needs key, groupJid (…@g.us), groupName and an https url (${t.key || '?'})`)
    }
  }
  return targets
}

export const createSheetsForwarder = ({ db, targets, ops, log, fetchImpl = globalThis.fetch, now = Date.now }) => {
  const byJid = new Map(targets.map(t => [t.groupJid, t]))
  const byKey = new Map(targets.map(t => [t.key, t]))
  const getCursor = db.prepare("SELECT value FROM meta WHERE key = 'sheets_cursor'").pluck()
  const setCursor = db.prepare("INSERT INTO meta (key, value) VALUES ('sheets_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  // never back-fill history that was logged before this integration existed
  if (getCursor.get() === undefined) setCursor.run(String(db.prepare('SELECT coalesce(max(seq), 0) FROM messages').pluck().get()))

  const newMessages = db.prepare(`SELECT m.seq, m.group_id, m.chat_jid, m.wa_timestamp, m.body, m.push_name, m.sender_pn, m.sender_jid,
      c.push_name AS contact_name
    FROM messages m LEFT JOIN contacts c ON c.jid = m.sender_jid
    WHERE m.seq > ? AND m.msg_type = 'text' ORDER BY m.seq LIMIT ?`)
  const sessionFor = db.prepare(`SELECT * FROM sessions WHERE group_id = ? AND (started_at / 1000) * 1000 <= ?
    AND (ended_at IS NULL OR ? < (ended_at / 1000) * 1000) ORDER BY started_at DESC LIMIT 1`)
  const nextRow = db.prepare('SELECT coalesce(max(row_id), 0) + 1 FROM sheet_outbox WHERE session_id = ?').pluck()
  const insert = db.prepare(`INSERT OR IGNORE INTO sheet_outbox (message_seq, session_id, target, row_id, payload_json, status, next_attempt_at, last_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const due = db.prepare("SELECT * FROM sheet_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?")
  const markSent = db.prepare("UPDATE sheet_outbox SET status = 'sent', attempts = attempts + 1, sent_at = ?, response = ?, last_error = NULL WHERE id = ?")
  const markRetry = db.prepare('UPDATE sheet_outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?, response = ? WHERE id = ?')
  const markFailed = db.prepare("UPDATE sheet_outbox SET status = 'failed', attempts = attempts + 1, last_error = ?, response = ? WHERE id = ?")

  const senderName = m => m.push_name || m.contact_name || (m.sender_pn ? `+${m.sender_pn.split('@')[0]}` : m.sender_jid?.split('@')[0] || 'Unknown')

  /** Turn newly committed messages of the forwarded groups into outbox rows (one transaction per batch). */
  const enqueue = db.transaction(() => {
    let cursor = Number(getCursor.get() || 0)
    let added = 0
    const noRace = new Set()
    for (;;) {
      const rows = newMessages.all(cursor, BATCH)
      if (!rows.length) break
      for (const m of rows) {
        const target = byJid.get(m.chat_jid)
        if (!target) continue
        const s = sessionFor.get(m.group_id, m.wa_timestamp, m.wa_timestamp)
        if (!s) continue // not inside a logging session (should not happen: only session messages are stored)
        const rowId = nextRow.get(s.id)
        const payload = {
          id: rowId,
          sender: senderName(m),
          message: m.body,
          groupName: target.groupName,
          timestamp: m.wa_timestamp,
          raceNumber: s.race_number == null ? null : String(s.race_number)
        }
        const skip = s.race_number == null
        if (skip) noRace.add(s.id)
        added += insert.run(m.seq, s.id, target.key, rowId, JSON.stringify(payload), skip ? 'skipped' : 'pending', now(),
          skip ? 'Session has no race number — no RACE sheet to write to' : null, now()).changes
      }
      cursor = rows.at(-1).seq
    }
    setCursor.run(String(cursor))
    return { added, noRace: [...noRace] }
  })

  const warnedNoRace = new Set()
  let pumping = false
  let pumpAgain = false

  const sendOne = async row => {
    const target = byKey.get(row.target)
    if (!target) return markFailed.run(`No target "${row.target}" in config/sheets.json`, null, row.id)
    let text = ''
    try {
      const res = await fetchImpl(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: row.payload_json,
        redirect: 'follow', // Apps Script answers via a 302 to script.googleusercontent.com
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      text = (await res.text()).slice(0, 2000)
      let body = null
      try { body = JSON.parse(text) } catch { /* not JSON (e.g. an HTML error page) */ }
      if (res.ok && body?.status === 'success') return markSent.run(now(), text, row.id)
      const reason = body?.message || `HTTP ${res.status}${body ? '' : ' (response was not JSON)'}`
      // the script rejecting our group name is a configuration problem: retrying cannot fix it
      if (/unrecognized group name/i.test(reason)) {
        markFailed.run(reason, text, row.id)
        return ops.emit({ level: 'error', code: 'sheets.config', message: `Google Sheets rejected group "${JSON.parse(row.payload_json).groupName}": ${reason}. Fix the Apps Script group mapping, then retry failed rows in Settings → Logs → Google Sheets.`, context: { target: row.target } })
      }
      throw new Error(reason)
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? `timed out after ${TIMEOUT_MS / 1000} s` : err.message
      if (row.attempts + 1 >= MAX_ATTEMPTS) {
        markFailed.run(reason, text || null, row.id)
        ops.emit({ level: 'error', code: 'sheets.failed', message: `A message could not be sent to Google Sheets after ${MAX_ATTEMPTS} attempts (${reason}). Retry it from Settings → Logs → Google Sheets.`, context: { target: row.target, outbox: row.id, session: row.session_id, row: row.row_id } })
      } else {
        markRetry.run(now() + backoffMs(row.attempts + 1), reason, text || null, row.id)
        if (row.attempts + 1 >= 3) ops.emit({ level: 'warn', code: 'sheets.retrying', message: `Google Sheets is not accepting messages (${reason}); retrying automatically`, context: { target: row.target } })
      }
    }
  }

  /** Send everything that is due, CONCURRENCY at a time. Single-flight. */
  const pump = async () => {
    if (pumping) { pumpAgain = true; return }
    pumping = true
    try {
      do {
        pumpAgain = false
        for (let batch; (batch = due.all(now(), CONCURRENCY * 5)).length;) {
          for (let i = 0; i < batch.length; i += CONCURRENCY) await Promise.all(batch.slice(i, i + CONCURRENCY).map(sendOne))
        }
      } while (pumpAgain)
    } catch (err) {
      log.error({ err: err.stack }, 'sheets: pump failed')
    } finally { pumping = false }
  }

  const tick = () => {
    if (!targets.length) return
    try {
      const { noRace } = enqueue()
      for (const id of noRace) {
        if (warnedNoRace.has(id)) continue
        warnedNoRace.add(id)
        ops.emit({ level: 'warn', code: 'sheets.no_race', message: 'This session has no race number, so its messages are not sent to Google Sheets (the race number picks the RACE sheet).', context: { session: id } })
      }
    } catch (err) {
      log.error({ err: err.message }, 'sheets: enqueue failed')
    }
    pump()
  }

  return {
    enabled: targets.length > 0,
    tick,
    pump,
    targetFor: jid => byJid.get(jid) || null,
    /** failed → pending again (optionally only one target) */
    retryFailed: target => db.prepare(`UPDATE sheet_outbox SET status = 'pending', attempts = 0, next_attempt_at = ?
      WHERE status = 'failed' ${target ? 'AND target = ?' : ''}`).run(...(target ? [now(), target] : [now()])).changes,
    stats: () => targets.map(t => {
      const counts = Object.fromEntries(db.prepare('SELECT status, count(*) n FROM sheet_outbox WHERE target = ? GROUP BY status').all(t.key).map(r => [r.status, r.n]))
      const last = db.prepare("SELECT sent_at FROM sheet_outbox WHERE target = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1").pluck().get(t.key) ?? null
      const lastError = db.prepare("SELECT last_error FROM sheet_outbox WHERE target = ? AND last_error IS NOT NULL AND status != 'sent' ORDER BY id DESC LIMIT 1").pluck().get(t.key) ?? null
      return { key: t.key, groupJid: t.groupJid, groupName: t.groupName, endpoint: t.url.replace(/\/s\/([^/]{6})[^/]*/, '/s/$1…'), pending: counts.pending || 0, sent: counts.sent || 0, failed: counts.failed || 0, skipped: counts.skipped || 0, lastSentAt: last, lastError }
    }),
    recentFailures: (limit = 50) => db.prepare(`SELECT o.id, o.target, o.session_id, o.row_id, o.attempts, o.last_error, o.created_at, m.body, m.wa_timestamp
      FROM sheet_outbox o JOIN messages m ON m.seq = o.message_seq WHERE o.status IN ('failed','pending') AND o.last_error IS NOT NULL
      ORDER BY o.id DESC LIMIT ?`).all(limit)
  }
}

