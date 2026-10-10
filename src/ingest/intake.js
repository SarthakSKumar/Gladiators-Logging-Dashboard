// Intake (plan §2–§4): serialises Baileys event batches (ev.process does NOT await handlers between
// batches), classifies every message record into exactly one disposition, and durably journals the
// in-scope ones. The handler holds records in memory only until journal.append() returns.
import { isJidGroup } from 'baileys'
import { normalize } from '../wa/normalize.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const MESSAGE_PATHS = ['messages.upsert', 'messaging-history.set']

/**
 * inSession(chatJid, waTimestampMs): only messages *sent* inside a logging session window of their group are
 * stored (anything else — before Start, after Stop, or WhatsApp's offline backlog from idle time — is dropped).
 * Omitted (tests of the raw pipeline) → every in-scope message is kept.
 */
export const createIntake = ({ journal, groups, counters, limits, log, onDurable, onPressure, onMetadata, onUndecryptable, inSession, now = Date.now }) => {
  const c = counters.c
  const queue = [] // [{ events, at, records }]
  let queuedRecords = 0
  let running = false
  let idleWaiters = []
  let peakRecords = 0

  const countRecords = events =>
    (events['messages.upsert']?.messages.length || 0) + (events['messaging-history.set']?.messages.length || 0)

  /**
   * Called from sock.ev.process — must be synchronous and cheap. The queue only holds events Baileys has
   * already received (and acknowledged), so disconnecting cannot shrink it; it is not a backpressure
   * trigger (that is what suspended the socket mid-sync before). Its depth is reported as a gauge.
   */
  const enqueue = events => {
    const records = countRecords(events)
    queue.push({ events, at: now(), records })
    queuedRecords += records
    if (queuedRecords > peakRecords) peakRecords = queuedRecords
    if (!running) run()
  }

  const run = async () => {
    running = true
    try {
      while (queue.length) {
        const item = queue.shift()
        queuedRecords -= item.records
        try { await processBatch(item) } catch (err) {
          // a bug, not an I/O error (those retry forever above); the stuck `inflight` gauge then
          // breaks invariant I1, which raises an alert
          log.fatal({ err: err.stack }, 'intake: batch processing crashed')
        }
        await new Promise(setImmediate) // keep the event loop responsive during bursts
      }
    } finally {
      running = false
      idleWaiters.forEach(r => r()); idleWaiters = []
    }
  }

  const sourceOf = (name, data) => {
    if (name === 'messaging-history.set') return 'history'
    if (data.requestId) return 'resend'
    return data.type === 'append' ? 'offline' : 'live'
  }

  const processBatch = async ({ events, at }) => {
    const inScope = []
    for (const name of MESSAGE_PATHS) {
      const data = events[name]
      if (!data) continue
      const source = sourceOf(name, data)
      for (const msg of data.messages) {
        c.observed++
        const chat = msg.key?.remoteJid
        if (!isJidGroup(chat)) { c.excluded_non_group++; continue }
        const scope = groups.scopeOf(chat)
        if (scope === 'non_target') { c.excluded_non_target_group++; continue }
        let rec
        try { rec = normalize(msg, source) } catch (err) {
          c.failed_not_durable++ // structurally invalid (no key/id) — cannot be stored or deduplicated
          log.error({ err: err.message, chat }, 'intake: unstorable message')
          continue
        }
        if (rec.kind === 'ignored') { c.excluded_type++; continue } // non-text: silently ignored by design
        if (inSession && !inSession(chat, rec.wa_timestamp ?? now())) { c.excluded_out_of_session++; continue }
        if (rec.kind === 'undecryptable') {
          c.undecryptable++
          if (scope === 'target') onUndecryptable?.(rec)
          continue
        }
        c.inflight++
        inScope.push(rec)
      }
    }
    if (events['messages.update']) c.updates_ignored += events['messages.update'].length
    if (events['messages.delete']) c.deletes_ignored += events['messages.delete'].keys?.length || 1
    for (const [name, data] of Object.entries(events)) {
      if (MESSAGE_PATHS.includes(name) || name === 'messages.update' || name === 'messages.delete') continue
      try { onMetadata?.(name, data) } catch (err) { log.warn({ err: err.message, event: name }, 'intake: metadata handler failed') }
    }

    for (let i = 0; i < inScope.length; i += limits.chunkSize) {
      const chunk = inScope.slice(i, i + limits.chunkSize).map(toJournalRecord)
      await appendWithRetry(chunk)
      const t = now()
      c.inflight -= chunk.length
      c.journaled += chunk.length
      for (let k = 0; k < chunk.length; k++) counters.recordLatency(t - at)
      onDurable?.(chunk)
    }
  }

  const toJournalRecord = rec => {
    const received_at = now()
    const { kind, ...rest } = rec
    const wa = rest.wa_timestamp ?? received_at
    const skew = rest.source === 'live' && Math.abs(wa - received_at) > 60_000 ? 1 : 0
    return { t: 'msg', ...rest, wa_timestamp: wa, received_at, skew_flag: rest.wa_timestamp == null ? 1 : skew }
  }

  // Records stay in memory (counted `inflight`, i.e. at risk) while retrying; after chunkRetryMs the
  // socket is suspended so no new data flows in. In-memory is never treated as durable.
  const appendWithRetry = async chunk => {
    const start = now()
    let delay = 50
    let suspended = false
    for (;;) {
      try {
        journal.append(chunk)
        if (suspended) onPressure?.(false, 'journal_write')
        return
      } catch (err) {
        c.journal_write_errors++
        log.error({ err: err.message, code: err.code }, 'intake: journal append failed')
        if (err.code === 'ENOSPC') journal.releaseReserve()
        if (!suspended && now() - start >= limits.chunkRetryMs) {
          suspended = true
          onPressure?.(true, 'journal_write', { code: err.code })
        }
        await sleep(delay)
        delay = Math.min(delay * 2, 5000)
      }
    }
  }

  return {
    enqueue,
    depth: () => ({ batches: queue.length, records: queuedRecords, peakRecords }),
    /** resolves once everything enqueued so far is durable (used by shutdown and tests) */
    idle: () => (running || queue.length ? new Promise(r => idleWaiters.push(r)) : Promise.resolve())
  }
}
