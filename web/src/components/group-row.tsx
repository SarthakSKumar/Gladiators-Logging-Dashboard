import { FileSpreadsheet, List, Loader2, Play, Square } from "lucide-react"
import { useEffect, useState } from "react"
import { Dot, StatusPill, type Tone } from "@/components/status"
import { StartLoggingDialog } from "@/components/start-logging-dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ago, elapsed, sessionName } from "@/lib/format"
import { useStopLogging } from "@/lib/queries"
import type { CaptureStateName, SelectedGroup } from "@/lib/types"

/** Re-render once a second while a session runs, for the elapsed timer. */
function useTick(active: boolean) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => set((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
}

const UNAVAILABLE: Record<string, string> = { inaccessible: "Removed from group", missing: "Not found", ambiguous: "Ambiguous", unresolved: "Waiting" }

function IconAction({ label, onClick, disabled, children, className }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* span keeps the tooltip working when the button is disabled */}
        <span tabIndex={disabled ? 0 : -1} className="rounded-md">
          <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} disabled={disabled} className={className}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function GroupRow({ group, capture, onHistory }: { group: SelectedGroup; capture: CaptureStateName; onHistory: () => void }) {
  const s = group.session
  useTick(Boolean(s))
  const [confirmStop, setConfirmStop] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const stop = useStopLogging()
  const available = group.status === "resolved" && Boolean(group.jid)

  // the dot reflects real state: logging AND captured (green), logging but capture not running yet (amber/red), not logging (muted)
  const tone: Tone = !s ? "idle" : capture === "capturing" ? "live" : capture === "error" || capture === "not_linked" ? "error" : "warn"
  const dotLabel = !s ? "Not logging" : capture === "capturing" ? "Logging — capture running" : capture === "error" ? "Logging — capture error" : "Logging — capture starting"

  return (
    <div className="group/row flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2/60">
      <span title={dotLabel} className="flex items-center" role="img" aria-label={dotLabel}>
        <Dot tone={tone} ping={tone === "live"} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="min-w-0 truncate font-medium sm:max-w-[45%] sm:shrink-0" title={group.label}>
          {group.label}
        </span>
        {group.sheets && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} aria-label="Sent to Google Sheets" className="hidden shrink-0 rounded text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 sm:inline-flex">
                <FileSpreadsheet className="size-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent>Messages are sent to Google Sheets ({group.sheets.groupName}) on the RACE sheet of the session’s race number</TooltipContent>
          </Tooltip>
        )}
        <Separator orientation="vertical" className="hidden data-[orientation=vertical]:h-4 sm:block" />
        <span className="min-w-0 truncate text-sm text-muted-foreground tabular-nums">
          {s ? (
            <>
              <span className="text-foreground/80">{sessionName(s)}</span> · {elapsed(s.started_at)}
              <span className="hidden md:inline">
                {" "}
                · {s.message_count} message{s.message_count === 1 ? "" : "s"}
              </span>
            </>
          ) : available ? (
            group.lastMessageAt ? (
              `Not logging · last message ${ago(group.lastMessageAt)}`
            ) : (
              "Not logging"
            )
          ) : (
            <StatusPill tone="warn" className="h-5">
              {UNAVAILABLE[group.status] ?? group.status}
            </StatusPill>
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {s ? (
          <IconAction label="Stop logging" onClick={() => setConfirmStop(true)} disabled={stop.isPending} className="text-danger hover:bg-danger-soft hover:text-danger">
            {stop.isPending ? <Loader2 className="animate-spin" /> : <Square className="fill-current" />}
          </IconAction>
        ) : (
          <IconAction
            label={available ? "Start logging" : group.action || "This group isn’t available"}
            onClick={() => setStartOpen(true)}
            disabled={!available}
            className="text-success hover:bg-success-soft hover:text-success-ink"
          >
            <Play className="fill-current" />
          </IconAction>
        )}
        <IconAction label="Session history" onClick={onHistory}>
          <List />
        </IconAction>
      </div>

      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop logging?</AlertDialogTitle>
            <AlertDialogDescription>
              {s ? `“${sessionName(s)}” in ${group.label} ends now. ` : ""}
              Messages sent before this moment stay in the session. If no other group is logging, capture stops too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep logging</AlertDialogCancel>
            <AlertDialogAction className="bg-danger text-white hover:bg-danger/90" onClick={() => s && stop.mutate(s.id)}>
              Stop logging
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <StartLoggingDialog group={group} open={startOpen} onOpenChange={setStartOpen} />
    </div>
  )
}
