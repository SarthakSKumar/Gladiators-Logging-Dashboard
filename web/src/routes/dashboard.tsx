import { ArrowRight, Settings2 } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router"
import { PageHeader } from "@/components/app-shell"
import { GroupRow } from "@/components/group-row"
import { HistorySheet } from "@/components/history-sheet"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ago, full, greeting, num, when } from "@/lib/format"
import { useKpis, useMe, useStatus } from "@/lib/queries"
import { cn } from "@/lib/utils"

function Kpi({ label, value, hint, tone, title }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "warn"; title?: string }) {
  const body = (
    <div className="min-w-0 px-4 py-3.5" title={title}>
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 truncate text-xl font-semibold tabular-nums tracking-tight", tone === "warn" && "text-warning-ink")}>{value}</dd>
      {hint && <dd className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">{hint}</dd>}
    </div>
  )
  return body
}

function KpiStrip() {
  const k = useKpis()
  if (k.isPending)
    return (
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="bg-background px-4 py-3.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2.5 h-6 w-14" />
          </div>
        ))}
      </div>
    )
  if (k.isError) return <p className="rounded-xl border px-4 py-3 text-sm text-danger">Couldn’t load metrics: {k.error.message}</p>
  const d = k.data
  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3 xl:grid-cols-6 [&>div]:bg-background">
      <Kpi label="Bet messages logged" value={num(d.messagesAllTime)} hint="All time" />
      <Kpi label="Messages today" value={num(d.messagesToday)} hint={`${num(d.sessionsToday)} session${d.sessionsToday === 1 ? "" : "s"} today`} />
      <Kpi label="Last message" value={d.lastMessageAt ? ago(d.lastMessageAt) : "—"} hint={d.lastMessageAt ? when(d.lastMessageAt) : "Nothing logged yet"} title={full(d.lastMessageAt)} />
      <Kpi
        label="Logging now"
        value={
          <>
            {num(d.groupsLogging)}
            <span className="text-sm font-normal text-muted-foreground"> / {num(d.groupsConfigured)}</span>
          </>
        }
        hint={<Link className="hover:text-foreground hover:underline" to="/settings/groups">of {d.groupsConfigured} configured groups</Link>}
      />
      <Kpi label="Ingestion issues today" value={num(d.ingestionFailuresToday)} tone={d.ingestionFailuresToday ? "warn" : undefined} hint={<Link className="hover:text-foreground hover:underline" to="/settings/logs">View logs</Link>} />
      <Kpi label="Capture gaps today" value={num(d.gapsToday)} tone={d.gapsToday ? "warn" : undefined} hint="During logging" />
    </dl>
  )
}

export function DashboardPage() {
  const me = useMe().data
  const status = useStatus()
  const [historyFor, setHistoryFor] = useState<number | null>(null)
  const groups = status.data?.groups ?? []
  const firstName = (me?.name || me?.email || "").split(/[\s@]/)[0]

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-6 md:px-8 md:py-8">
      <PageHeader title={`${greeting()}${firstName ? `, ${firstName}` : ""}`} description="Live view of bet message capture across your WhatsApp groups." />

      <KpiStrip />

      <section className="grid gap-3" aria-labelledby="groups-heading">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 id="groups-heading" className="text-sm font-semibold">
              Groups
            </h2>
            <p className="text-sm text-muted-foreground">Start logging a group to capture its bet messages into a session.</p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" asChild aria-label="Manage groups">
                <Link to="/settings/groups">
                  <Settings2 />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Manage groups</TooltipContent>
          </Tooltip>
        </div>
        <div className="divide-y overflow-hidden rounded-xl border bg-background">
          {status.isPending ? (
            Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex h-14 items-center gap-3 px-4">
                <Skeleton className="size-2 rounded-full" />
                <Skeleton className="h-4 w-48" />
                <Skeleton className="ml-auto h-4 w-24" />
              </div>
            ))
          ) : status.isError ? (
            <p className="px-4 py-6 text-sm text-danger">Couldn’t load groups: {status.error.message}</p>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
              <p className="font-medium">No groups selected yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">Choose which of the linked account’s WhatsApp groups to log.</p>
              <Button asChild size="sm">
                <Link to="/settings/groups">
                  Choose groups <ArrowRight />
                </Link>
              </Button>
            </div>
          ) : (
            groups.map((g) => <GroupRow key={g.id} group={g} capture={status.data!.capture.state} onHistory={() => setHistoryFor(g.id)} />)
          )}
        </div>
      </section>

      <HistorySheet group={groups.find((g) => g.id === historyFor) ?? null} open={historyFor != null} onOpenChange={(o) => !o && setHistoryFor(null)} />
    </div>
  )
}
