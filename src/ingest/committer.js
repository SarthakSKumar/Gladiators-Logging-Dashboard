// Committer (plan §3): single writer that applies journal records to messages.db. The applied rows and
// meta.applied_through_jseq commit in ONE transaction — that commit is the acknowledgement, so a crash
// can never leave "committed but not acked". Re-applying a record is harmless (unique keys).
import { getMeta, setMeta } from '../db/index.js'

// journal records are JSON: absent keys must still bind as NULL
const MSG_DEFAULTS = { sender_jid: null, sender_pn: null, push_name: null, body: null, quoted_wa_msg_id: null, quoted_body: null, skew_flag: 0 }
const EVT_DEFAULTS = { new_body: null, actor_jid: null, raw: null }

export const createCommitter = ({ db, journal, groups, counters, log, onCommitted, onHealth, now = Date.now, batchSize = 500 }) => {
  const c = counters.c
  let appliedThrough = Number(getMeta(db, 'applied_through_jseq') || 0)
  let running = false
  let again = false
  let retryTimer = null
  let backoff = 1000
  let degraded = false

  const insertMsg = db.prepare(`INSERT INTO messages (jseq, group_id, chat_jid, wa_msg_id, from_me, sender_jid, sender_pn, push_name,
      wa_timestamp, received_at, skew_flag, source, msg_type, body, quoted_wa_msg_id, quoted_body, raw_json, parse_version)
    VALUES (@j, @group_id, @chat_jid, @wa_msg_id, @from_me, @sender_jid, @sender_pn, @push_name,
      @wa_timestamp, @received_at, @skew_flag, @source, @msg_type, @body, @quoted_wa_msg_id, @quoted_body, @raw, @parse_version)
    ON CONFLICT (chat_jid, wa_msg_id) DO NOTHING`)
  const existingType = db.prepare('SELECT msg_type FROM messages WHERE chat_jid = ? AND wa_msg_id = ?').pluck()
  const insertEvt = db.prepare(`INSERT INTO message_events (jseq, group_id, chat_jid, target_wa_msg_id, event_type, new_body, actor_jid,
      event_ts, received_at, raw_json, event_key)
    VALUES (@j, @group_id, @chat_jid, @target_wa_msg_id, @event_type, @new_body, @actor_jid, @event_ts, @received_at, @raw, @event_key)
    ON CONFLICT (event_key) DO NOTHING`)
  const touchGroup = db.prepare('UPDATE groups SET last_message_at = max(coalesce(last_message_at, 0), ?) WHERE id = ?')
  const insertPending = db.prepare('INSERT OR IGNORE INTO pending_scope (jseq, chat_jid, received_at, record_json) VALUES (?, ?, ?, ?)')
  const listPending = db.prepare('SELECT jseq, chat_jid, received_at, record_json FROM pending_scope ORDER BY jseq')
  const deletePending = db.prepare('DELETE FROM pending_scope WHERE jseq = ?')
  const countPending = db.prepare('SELECT count(*) FROM pending_scope').pluck()

  /** @returns {'new'|'dup'} */
  const applyToTarget = (r, groupId) => {
    if (r.t === 'evt') {
      const res = insertEvt.run({ ...EVT_DEFAULTS, ...r, group_id: groupId })
      if (res.changes) { c.events_applied++; return 'new' }
      c.events_duplicate++
      return 'dup'
    }
    const res = insertMsg.run({ ...MSG_DEFAULTS, ...r, group_id: groupId })
    if (res.changes) { touchGroup.run(r.received_at, groupId); return 'new' }
    // Same key again. If we only had an undecryptable placeholder and real content arrived (retry /
    // placeholder resend), record it as an event — the original row stays untouched.
    if (existingType.get(r.chat_jid, r.wa_msg_id) === 'undecryptable' && r.msg_type !== 'undecryptable') {
      insertEvt.run({
        j: r.j, group_id: groupId, chat_jid: r.chat_jid, target_wa_msg_id: r.wa_msg_id, event_type: 'content_resolved',
        new_body: r.body ?? `[${r.msg_type}]`, actor_jid: r.sender_jid, event_ts: r.wa_timestamp, received_at: r.received_at,
        raw: r.raw, event_key: `${r.chat_jid}|${r.wa_msg_id}|resolved`
      })
      c.events_applied++
    }
    return 'dup'
  }

  const applyBatch = db.transaction(records => {
    for (const r of records) {
      const target = groups.targetOf(r.chat_jid)
      if (!target) {
        insertPending.run(r.j, r.chat_jid, r.received_at, JSON.stringify(r))
        c.to_pending_scope++
        continue
      }
      if (applyToTarget(r, target.id) === 'new') c.applied_new++
      else c.applied_duplicate++
    }
    setMeta(db, 'applied_through_jseq', records.at(-1).j)
  })

  const tick = () => {
    if (running) { again = true; return }
    running = true
    try {
      do {
        again = false
        for (;;) {
          const records = journal.readAfter(appliedThrough, batchSize)
          if (!records.length) break
          applyBatch(records)
          appliedThrough = records.at(-1).j
          onCommitted?.(records)
        }
      } while (again)
      if (degraded) { degraded = false; backoff = 1000; onHealth?.(true) }
    } catch (err) {
      c.commit_errors++
      log.error({ err: err.message, code: err.code }, 'committer: apply failed; journal keeps accepting writes')
      if (!degraded) { degraded = true; onHealth?.(false, err) }
      clearTimeout(retryTimer)
      retryTimer = setTimeout(tick, backoff)
      backoff = Math.min(backoff * 2, 30_000)
    } finally {
      running = false
    }
  }

  /** Re-route pending-scope rows after group resolution changes (plan §9). */
  const promotePending = db.transaction(({ allResolved, ttlMs }) => {
    let promoted = 0; let purged = 0
    for (const row of listPending.all()) {
      const r = JSON.parse(row.record_json)
      const target = groups.targetOf(row.chat_jid)
      if (target) {
        applyToTarget(r, target.id)
        deletePending.run(row.jseq)
        promoted++
      } else if (allResolved || now() - row.received_at > ttlMs) {
        deletePending.run(row.jseq)
        purged++
      }
    }
    c.promoted_from_scope += promoted
    c.purged_non_target += purged
    return { promoted, purged }
  })

  return {
    tick,
    promotePending,
    appliedThrough: () => appliedThrough,
    // records older than the retained journal (after a messages.db restore) cannot be replayed
    pendingApply: () => journal.durableJseq - Math.max(appliedThrough, journal.firstRetainedJseq() - 1),
    pendingScopeOpen: () => countPending.get(),
    degraded: () => degraded,
    stop: () => clearTimeout(retryTimer)
  }
}
