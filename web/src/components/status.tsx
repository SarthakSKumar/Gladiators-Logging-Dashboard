import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { CaptureState, CaptureStateName } from "@/lib/types"

export type Tone = "live" | "warn" | "error" | "idle"

const DOT: Record<Tone, string> = {
  live: "bg-success",
  warn: "bg-warning",
  error: "bg-danger",
  idle: "bg-muted-foreground/40",
}

/** Status dot. `ping` adds an expanding ring (live things only). */
export function Dot({ tone, ping = false, className }: { tone: Tone; ping?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)} aria-hidden="true">
      {ping && <span className={cn("absolute inset-0 rounded-full opacity-60 animate-live-ping", DOT[tone])} />}
      <span className={cn("relative inline-flex size-2 rounded-full", DOT[tone])} />
    </span>
  )
}

const PILL: Record<Tone, string> = {
  live: "bg-success-soft text-success-ink",
  warn: "bg-warning-soft text-warning-ink",
  error: "bg-danger-soft text-danger",
  idle: "bg-surface-2 text-muted-foreground",
}

const CAPTURE: Record<CaptureStateName, { label: string; tone: Tone; ping?: boolean }> = {
  capturing: { label: "Capturing", tone: "live", ping: true },
  starting: { label: "Starting", tone: "warn" },
  idle: { label: "Idle", tone: "idle" },
  linking: { label: "Linking", tone: "warn" },
  not_linked: { label: "Not linked", tone: "error" },
  error: { label: "Error", tone: "error" },
}

export const captureTone = (s: CaptureStateName) => CAPTURE[s].tone

export function StatusPill({ tone, ping, children, className }: { tone: Tone; ping?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium", PILL[tone], className)}>
      <Dot tone={tone} ping={ping} />
      {children}
    </span>
  )
}

export function CaptureBadge({ capture }: { capture: CaptureState }) {
  const c = CAPTURE[capture.state]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <StatusPill tone={c.tone} ping={c.ping}>
            {c.label}
          </StatusPill>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        {capture.detail || c.label}
      </TooltipContent>
    </Tooltip>
  )
}
