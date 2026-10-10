import { useMemo, useState } from "react"
import { StatusPill } from "@/components/status"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { bytes, elapsed, full, num, timeOfDay, when } from "@/lib/format"
import { notifySuccess } from "@/lib/notify"
import { useDiagnostics, useEvents, useRetrySheets, useSheetCalls, useSheets } from "@/lib/queries"
import type { SheetCall } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { ChevronRight, RotateCw } from "lucide-react"
import type { Diagnostics, OpEvent } from "@/lib/types"
import { cn } from "@/lib/utils"

type LogType = "health" | "counters" | "gaps" | "connection" | "sheets"
const TYPES: { value: LogType; label: string }[] = [
  { value: "health", label: "Ingestion health" },
  { value: "counters", label: "Counters" },
  { value: "gaps", label: "Capture gaps" },
  { value: "connection", label: "Connection log" },
  { value: "sheets", label: "Google Sheets" },
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
  excluded_out_of_session: "Sent outside a logging session (not stored by design)",
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
  connecting: "Capture starting",
  interrupted: "Connection interrupted",
  process_down: "Server not running",
  suspended: "Paused",
  paused: "Paused to protect data",
  reconnecting: "Reconnect failing",
  logged_out: "Logged out",
  unlinked: "Unlinked",
  restore: "Restored from backup",
  stopped: "Server stopped",
  needs_link: "Not linked",
  link_idle: "Not linked",
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

const CALL_RESULT: Record<SheetCall["result"], { label: string; tone: "live" | "warn" | "error" }> = {
  sent: { label: "Sent", tone: "live" },
  rejected: { label: "Rejected", tone: "warn" },
  config_error: { label: "Group rejected", tone: "error" },
  network_error: { label: "No response", tone: "error" },
}

function pretty(json: string | null) {
  if (!json) return "—"
  try {
    return JSON.stringify(JSON.parse(json), null, 2)
  } catch {
    return json
  }
}

/** Every call made to the Apps Script endpoint: the request that was sent and what the script answered. */
function SheetCallLog() {
  const [filter, setFilter] = useState<"all" | "sent" | "problem">("all")
  const [open, setOpen] = useState<number | null>(null)
  const q = useSheetCalls(filter)
  const rows = q.data?.pages.flat() ?? []
  return (
    <section className="grid gap-3" aria-labelledby="calls-heading">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="calls-heading" className="text-sm font-semibold">
          Call log
        </h2>
        <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
          <SelectTrigger className="w-44" aria-label="Filter calls" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All calls</SelectItem>
            <SelectItem value="sent">Sent only</SelectItem>
            <SelectItem value="problem">Problems only</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">Every request to the Apps Script, with the script’s reply. Kept permanently.</span>
      </div>
      <div className="overflow-hidden rounded-xl border bg-background">
        {q.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : q.isError ? (
          <p className="px-4 py-6 text-sm text-danger">Couldn’t load the call log: {q.error.message}</p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {filter === "all" ? "No calls yet. They appear here as messages are sent to Google Sheets." : "Nothing matches this filter."}
          </p>
        ) : (
          <Table className="text-[13px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-8" />
                <TableHead className="w-28">Time</TableHead>
                <TableHead>Group · RACE · S.No</TableHead>
                <TableHead>Sender</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">HTTP</TableHead>
                <TableHead className="text-right">ms</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.flatMap((c) => {
                const r = c.result === "sent" && c.error ? { label: "Sent · not read", tone: "warn" as const } : CALL_RESULT[c.result]
                const expanded = open === c.id
                const toggle = () => setOpen(expanded ? null : c.id)
                const main = (
                  <TableRow key={c.id} className="cursor-pointer align-top" onClick={toggle}>
                    <TableCell>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        aria-label={expanded ? "Hide details" : "Show details"}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        onClick={(e) => {
                          e.stopPropagation()
                          toggle()
                        }}
                      >
                        <ChevronRight className={cn("size-4 transition-transform", expanded && "rotate-90")} />
                      </button>
                    </TableCell>
                    <TableCell className="tabular-nums" title={full(c.ts)}>
                      {when(c.ts)}
                    </TableCell>
                    <TableCell>
                      <span className="block max-w-52 truncate">{c.group}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        RACE {c.race ?? "?"} · #{c.row_id}
                        {c.attempt > 1 ? ` · attempt ${c.attempt}` : ""}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-32 truncate">{c.sender}</TableCell>
                    <TableCell className="max-w-56 truncate" title={c.message}>
                      {c.message}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={r.tone}>{r.label}</StatusPill>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{c.http_status ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.duration_ms ?? "—"}</TableCell>
                  </TableRow>
                )
                if (!expanded) return [main]
                return [
                  main,
                  <TableRow key={`${c.id}-d`} className="bg-surface-2 hover:bg-surface-2">
                    <TableCell />
                    <TableCell colSpan={7}>
                      <div className="grid gap-3 py-1 md:grid-cols-2">
                        <div className="min-w-0">
                          <p className="mb-1 text-xs font-medium text-muted-foreground">Request sent</p>
                          <pre className="max-h-60 overflow-auto rounded-md border bg-background p-2 font-mono text-xs break-words whitespace-pre-wrap">{JSON.stringify(c.request, null, 2)}</pre>
                        </div>
                        <div className="min-w-0">
                          <p className="mb-1 text-xs font-medium text-muted-foreground">
                            Script’s reply{c.host ? ` · ${c.host}` : ""}
                            {c.redirected ? " · after redirect" : ""}
                          </p>
                          <pre className="max-h-60 overflow-auto rounded-md border bg-background p-2 font-mono text-xs break-words whitespace-pre-wrap">{c.response ? pretty(c.response) : "No response received"}</pre>
                          {c.error && <p className="mt-2 text-xs text-danger">{c.error}</p>}
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>,
                ]
              })}
            </TableBody>
          </Table>
        )}
        {q.hasNextPage && (
          <div className="flex justify-center border-t p-2">
            <Button variant="ghost" size="sm" disabled={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
              Load older
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}

function SheetsLog() {
  const q = useSheets()
  const retry = useRetrySheets()
  if (q.isPending) return <Skeleton className="h-60 w-full rounded-xl" />
  if (q.isError) return <p className="rounded-xl border bg-background px-4 py-6 text-sm text-danger">Couldn’t load Google Sheets status: {q.error.message}</p>
  if (!q.data.enabled)
    return <p className="rounded-xl border bg-background px-4 py-10 text-center text-sm text-muted-foreground">Google Sheets forwarding is not configured (config/sheets.json).</p>
  const anyFailed = q.data.targets.some((t) => t.failed)
  return (
    <div className="grid gap-4">
      <div className="overflow-hidden rounded-xl border bg-background">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Sheet group</TableHead>
              <TableHead className="text-right">Sent</TableHead>
              <TableHead className="text-right">Sending</TableHead>
              <TableHead className="text-right">Failed</TableHead>
              <TableHead className="text-right">Not sent</TableHead>
              <TableHead>Last sent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.targets.map((t) => (
              <TableRow key={t.key}>
                <TableCell>
                  <span className="font-medium">{t.groupName}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{t.endpoint}</span>
                  {t.lastError && <span className="block text-xs text-danger">{t.lastError}</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{num(t.sent)}</TableCell>
                <TableCell className={cn("text-right tabular-nums", t.pending && "text-warning-ink")}>{num(t.pending)}</TableCell>
                <TableCell className={cn("text-right tabular-nums", t.failed && "font-semibold text-danger")}>{num(t.failed)}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground" title="Sessions without a race number are not sent">{num(t.skipped)}</TableCell>
                <TableCell className="tabular-nums">{t.lastSentAt ? when(t.lastSentAt) : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" disabled={!anyFailed || retry.isPending} onClick={() => retry.mutate(undefined, { onSuccess: (r) => notifySuccess(`Retrying ${r.requeued} message${r.requeued === 1 ? "" : "s"}`) })}>
          <RotateCw /> Retry failed
        </Button>
        <span className="text-xs text-muted-foreground">Each message keeps its row number, so a retry rewrites the same row instead of adding a duplicate.</span>
      </div>
      <SheetCallLog />
      {q.data.failures.length > 0 && (
        <div className="overflow-hidden rounded-xl border bg-background">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Time</TableHead>
                <TableHead>Message</TableHead>
                <TableHead className="text-right">S.No</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead>Problem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.failures.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="tabular-nums">{when(f.wa_timestamp)}</TableCell>
                  <TableCell className="max-w-56 truncate">{f.body}</TableCell>
                  <TableCell className="text-right tabular-nums">{f.row_id}</TableCell>
                  <TableCell className="text-right tabular-nums">{f.attempts}</TableCell>
                  <TableCell className="max-w-72 truncate text-danger" title={f.last_error}>
                    {f.last_error}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
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
        <span className="text-xs text-muted-foreground">{type === "connection" ? "Live — new events appear automatically" : type === "sheets" ? "Refreshes every 5 s" : "Refreshes every 10 s"}</span>
      </div>
      {type === "sheets" ? (
        <SheetsLog />
      ) : d.isPending ? (
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
