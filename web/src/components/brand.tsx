import { cn } from "@/lib/utils"

// Placeholder Gladiators mark (no logo file was provided). To use the real logo, put it in
// web/public/logo.svg and replace <Mark /> with <img src="/logo.svg" alt="" className="size-8" />.
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8 shrink-0", className)} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <path
        d="M20.6 11.2A6.2 6.2 0 1 0 22 16h-5.6"
        fill="none"
        stroke="#fff"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="24.2" cy="8" r="1.9" fill="var(--gold)" />
    </svg>
  )
}

export function Wordmark({ className, subtitle = true }: { className?: string; subtitle?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <Mark />
      <div className="grid leading-tight">
        <span className="text-[15px] font-semibold tracking-tight text-foreground">Gladiators</span>
        {subtitle && <span className="text-xs text-muted-foreground">Bet logger</span>}
      </div>
    </div>
  )
}
