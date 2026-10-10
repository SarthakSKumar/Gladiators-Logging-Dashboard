// Non-overlapping ingestion metrics (plan §4). Every observed message record gets exactly one
// disposition; the identities below are checked continuously and any violation raises an alert.
export const createCounters = () => {
  const c = {
    // I1 — intake dispositions (per message record from messages.upsert / messaging-history.set)
    observed: 0,
    excluded_non_group: 0,
    excluded_non_target_group: 0,
    excluded_type: 0, // non-text (media, stickers, polls, reactions, protocol…) — ignored by design, not a failure
    excluded_out_of_session: 0, // selected group, but sent outside any logging session window — not logged by design
    undecryptable: 0, // in a logging session but WhatsApp could not decrypt it — reported as an operator event
    journaled: 0,
    inflight: 0, // gauge: classified in-scope, not yet durable (at risk)
    failed_not_durable: 0,
    // I2 — committer outcomes for journal records (this process + replay backlog found at start)
    replay_backlog_at_start: 0,
    applied_new: 0,
    applied_duplicate: 0,
    to_pending_scope: 0,
    // I3 — pending-scope lifecycle
    pending_scope_open_at_start: 0,
    promoted_from_scope: 0,
    purged_non_target: 0,
    // events (edits/revokes/late decrypt) — parallel family, not part of I1 record counts
    events_applied: 0,
    events_duplicate: 0,
    // other event paths seen and intentionally not journaled
    updates_ignored: 0, // messages.update: derived duplicates of upserted protocol messages, receipts, polls
    deletes_ignored: 0, // messages.delete: "delete for me" / chat clears — local-only
    // health
    torn_tail_bytes: 0,
    quarantined_ranges: 0,
    journal_write_errors: 0,
    commit_errors: 0
  }
  const latency = { samples: [], max: 0 } // receive → durable (ms)
  return {
    c,
    recordLatency (ms) {
      latency.samples.push(ms)
      if (latency.samples.length > 2000) latency.samples.shift()
      if (ms > latency.max) latency.max = ms
    },
    latencyStats () {
      const s = [...latency.samples].sort((a, b) => a - b)
      const pct = p => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0)
      return { n: s.length, p50: pct(0.5), p99: pct(0.99), max: latency.max }
    },
    /** gauges come from the live system: pending_apply = durable - applied, pending_scope_open = rows */
    check ({ pending_apply, pending_scope_open }) {
      const i1 = c.observed === c.excluded_non_group + c.excluded_non_target_group + c.excluded_type + c.excluded_out_of_session + c.undecryptable + c.journaled + c.inflight + c.failed_not_durable
      const i2 = c.journaled + c.replay_backlog_at_start === c.applied_new + c.applied_duplicate + c.to_pending_scope + pending_apply
      const i3 = c.to_pending_scope + c.pending_scope_open_at_start === c.promoted_from_scope + c.purged_non_target + pending_scope_open
      return { ok: i1 && i2 && i3, i1, i2, i3 }
    }
  }
}
