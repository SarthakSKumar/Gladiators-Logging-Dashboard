import { useMemo, useState } from "react"
import { StatusPill } from "@/components/status"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { bytes, elapsed, full, num, timeOfDay, when } from "@/lib/format"
import { useDiagnostics, useEvents } from "@/lib/queries"
import type { Diagnostics, OpEvent } from "@/lib/types"
import { cn } from "@/lib/utils"

type LogType = "health" | "counters" | "gaps" | "connection"
const TYPES: { value: LogType; label: string }[] = [
  { value: "health", label: "Ingestion health" },
  { value: "counters", label: "Counters" },
  { value: "gaps", label: "Capture gaps" },
  { value: "connection", label: "Connection log" },
]

function KV({ rows }: { rows: [string, React.ReactNode, string?][] }) {
  return (
    <dl className="divide-y overflow-hidden rounded-xl border bg-background">
      {rows.map(([k, v, note]) => (
        <div key={k} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[240px_1fr] sm:gap-4">
          <dt className="text-sm text-muted-foreground">{k}</dt>
          <dd className="text-sm tabular-nums">
            {v}
            {note && <span className="ml-2 text-xs text-muted-foreground">{note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const ok = (good: boolean, yes: string, no: string) => <StatusPill tone={good ? "live" : "error"}>{good ? yes : no}</StatusPill>

function Health({ d }: { d: Diagnostics }) {
  const h = d.health
  return (
    <KV
      rows={[
        ["Database writes", ok(!h.committerDegraded, "Healthy", "Failing — journal is holding messages")],
        ["Counters reconcile", ok(h.invariants.ok, "Yes", "No — see Counters")],
        ["Capture paused for", h.pressure.length ? h.pressure.join(", ") : "—"],
        ["Journal backlog", num(h.pendingApply), "messages durable but not yet in the database"],
        ["In flight", num(h.inflight), "received, not yet durable"],
        ["Intake queue", `${num(h.intakeDepth.batches)} batches · ${num(h.intakeDepth.records)} messages`, `peak ${num(h.intakeDepth.peakRecords)}`],
        ["Receive → durable", `p50 ${h.latency.p50} ms · p99 ${h.latency.p99} ms · max ${h.latency.max} ms`, `${num(h.latency.n)} samples`],
        ["Disk free", h.disk ? `${bytes(h.disk.free)} of ${bytes(h.disk.total)}` : "—"],
        ["Journal", `${num(d.journal.segments)} segments · ${bytes(d.journal.bytes)}`, `applied through #${num(d.journal.appliedThrough)}`],
        ["Email delivery", d.mailerConfigured ? "Configured" : "Not configured (codes print to the server console in development)"],
        ["Server process", `up ${elapsed(Date.now() - d.process.uptimeS * 1000)} · ${d.process.rssMb} MB · Node ${d.process.node}`],
      ]}
    />
  )
}

const COUNTER_HELP: Record<string, string> = {
  observed: "Messages seen from WhatsApp (all chats)",
  excluded_non_group: "Not a group chat (ignored)",
  excluded_non_target_group: "Group not selected (ignored)",
  excluded_type: "Not plain text — media, stickers, reactions… (ignored by design)",
  undecryptable: "Couldn’t be decrypted (reported in the connection log)",
  journaled: "Saved durably to the journal",
  inflight: "Received, not yet durable",
  failed_not_durable: "Could not be stored at all (must stay 0)",
  replay_backlog_at_start: "Journal backlog replayed at startup",
  applied_new: "Written to the database",
  applied_duplicate: "Duplicates safely skipped",
  to_pending_scope: "Held until a group was resolved",
  promoted_from_scope: "Held messages later stored",
  purged_non_target: "Held messages discarded (not a selected group)",
  journal_write_errors: "Journal write errors",
  commit_errors: "Database write errors",
  torn_tail_bytes: "Bytes set aside from an interrupted write",
  quarantined_ranges: "Corrupt journal ranges quarantined",
}

function Counters({ d }: { d: Diagnostics }) {
  const entries = Object.entries(d.counters).filter(([k]) => !["events_applied", "events_duplicate", "updates_ignored", "deletes_ignored", "pending_scope_open_at_start"].includes(k))
  return (
    <div className="overflow-hidden rounded-xl border bg-background">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Counter</TableHead>
            <TableHead className="w-28 text-right">Since start</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map(([k, v]) => (
            <TableRow key={k}>
              <TableCell>
                <span className="font-medium">{COUNTER_HELP[k] ?? k}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">{k}</span>
              </TableCell>
              <TableCell className={cn("text-right tabular-nums", k === "failed_not_durable" && v > 0 && "font-semibold text-danger")}>{num(v)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

const GAP_CAUSE: Record<string, string> = {
  idle: "No group logging",
  not_linked: "Not linked",
  linking: "Linking",
  connecting: "Connecting",
  process_down: "Server not running",
  suspended: "Paused",
  paused: "Paused to protect data",
  reconnecting: "Reconnect failing",
  logged_out: "Logged out",
  unlinked: "Unlinked",
  restore: "Restored from backup",
  auth_rollback: "Auth rollback",
}

function Gaps({ d }: { d: Diagnostics }) {
  if (!d.gaps.length) return <p className="rounded-xl border bg-background px-4 py-10 text-center text-sm text-muted-foreground">No capture gaps recorded.</p>
  return (
    <div className="overflow-hidden rounded-xl border bg-background">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>From</TableHead>
            <TableHead>To</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead>Cause</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {d.gaps.map((g) => (
            <TableRow key={g.id}>
              <TableCell className="tabular-nums" title={full(g.started_at)}>
                {when(g.started_at)}
              </TableCell>
              <TableCell className="tabular-nums">{g.ended_at ? when(g.ended_at) : "ongoing"}</TableCell>
              <TableCell className="text-right tabular-nums">{elapsed(g.started_at, g.ended_at ?? Date.now())}</TableCell>
              <TableCell>{GAP_CAUSE[g.cause] ?? g.cause}</TableCell>
              <TableCell>
                {g.status === "open" ? (
                  <StatusPill tone="warn">Open</StatusPill>
                ) : g.status === "recovered" ? (
                  <StatusPill tone="live">Recovered · {g.recovered_messages}</StatusPill>
                ) : ["idle", "not_linked", "linking"].includes(g.cause) ? (
                  <StatusPill tone="idle">Expected</StatusPill>
                ) : (
                  <StatusPill tone="error">Unverified</StatusPill>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

type Line = { key: string; ts: number; level: "info" | "warn" | "error"; text: string; noise: boolean; tag: string }
const LEVEL_CLASS = { info: "text-foreground/80", warn: "text-warning-ink", error: "text-danger" }

function ConnectionLog({ d, events }: { d: Diagnostics; events: OpEvent[] }) {
  const [showNoise, setShowNoise] = useState(false)
  const lines = useMemo<Line[]>(() => {
    const ev: Line[] = events.map((e) => ({
      key: `e${e.id}`,
      ts: e.last_ts,
      level: e.level,
      text: `${e.message}${e.count > 1 ? `  (×${e.count})` : ""}`,
      noise: e.noise,
      tag: e.code,
    }))
    const conn: Line[] = d.connectionLog.map((c) => ({ key: `c${c.id}`, ts: c.ts, level: "info", text: `${c.state}${c.code ? ` [${c.code}]` : ""}${c.detail ? ` — ${c.detail}` : ""}`, noise: true, tag: "socket" }))
    return [...ev, ...conn].sort((a, b) => b.ts - a.ts).filter((l) => showNoise || !l.noise)
  }, [events, d.connectionLog, showNoise])

  return (
    <div className="grid gap-2">
      <label className="flex items-center gap-2 self-end text-sm text-muted-foreground">
        <input type="checkbox" className="size-4 accent-primary" checked={showNoise} onChange={(e) => setShowNoise(e.target.checked)} />
        Show expected events (socket transitions, restarts)
      </label>
      <div className="max-h-[60vh] overflow-auto rounded-xl border bg-surface-2 p-3 font-mono text-xs leading-relaxed" role="log" aria-live="polite">
        {lines.length === 0 ? (
          <p className="py-8 text-center font-sans text-sm text-muted-foreground">Nothing logged yet.</p>
        ) : (
          lines.map((l) => (
            <div key={l.key} className={cn("grid grid-cols-[auto_auto_1fr] gap-3 py-0.5", LEVEL_CLASS[l.level], l.noise && "opacity-60")}>
              <span className="tabular-nums text-muted-foreground" title={full(l.ts)}>
                {when(l.ts).includes(" ") ? when(l.ts) : timeOfDay(l.ts)}
              </span>
              <span className="w-12 uppercase">{l.level}</span>
              <span className="break-words">
                {l.text} <span className="text-muted-foreground">· {l.tag}</span>
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export function LogsSettings() {
  const [type, setType] = useState<LogType>("health")
  const d = useDiagnostics()
  const events = useEvents()
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={type} onValueChange={(v) => setType(v as LogType)}>
          <SelectTrigger className="w-60" aria-label="Log type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{type === "connection" ? "Live — new events appear automatically" : "Refreshes every 10 s"}</span>
      </div>
      {d.isPending ? (
        <Skeleton className="h-80 w-full rounded-xl" />
      ) : d.isError ? (
        <p className="rounded-xl border bg-background px-4 py-6 text-sm text-danger">Couldn’t load logs: {d.error.message}</p>
      ) : type === "health" ? (
        <Health d={d.data} />
      ) : type === "counters" ? (
        <Counters d={d.data} />
      ) : type === "gaps" ? (
        <Gaps d={d.data} />
      ) : (
        <ConnectionLog d={d.data} events={events.data ?? []} />
      )}
    </div>
  )
}
