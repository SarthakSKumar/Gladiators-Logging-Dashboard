import { CheckCircle2, Loader2, RefreshCw, Smartphone } from "lucide-react"
import { useEffect, useRef } from "react"
import { useNavigate } from "react-router"
import { Wordmark } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useLink, useStatus } from "@/lib/queries"

/** Forced whenever WhatsApp is not linked (see RequireLinked in router.tsx). */
export function LinkPage() {
  const status = useStatus()
  const link = useLink()
  const navigate = useNavigate()
  const requested = useRef(false)
  const s = status.data
  const c = s?.capture

  // Ask the server for a QR once, as soon as we know we need one (not after an expiry: that waits for the user)
  useEffect(() => {
    if (!s || s.linked || requested.current) return
    if (c?.state === "not_linked" && !c.qrExpired && c.reason !== "operator") {
      requested.current = true
      link.mutate()
    }
  }, [s, c, link])

  useEffect(() => {
    if (!s?.linked) return
    const t = setTimeout(() => navigate("/", { replace: true }), 1500)
    return () => clearTimeout(t)
  }, [s?.linked, navigate])

  const expired = c?.state === "not_linked" && c.qrExpired
  const pairing = c?.phase === "pairing" || (c?.state === "linking" && !c.qr && c.phase !== "qr")
  const blocked = c?.state === "error"

  return (
    <main className="flex min-h-svh items-center justify-center bg-sidebar px-4 py-10">
      <div className="w-full max-w-3xl">
        <Wordmark className="mb-8" />
        <div className="grid overflow-hidden rounded-xl border bg-background shadow-sm md:grid-cols-[1fr_320px]">
          <section className="p-6 md:p-8">
            <h1 className="text-lg font-semibold tracking-tight">Link WhatsApp</h1>
            <p className="mt-1 text-sm text-muted-foreground">Connect the logger’s WhatsApp number to start capturing group messages.</p>
            <ol className="mt-6 grid gap-4 text-sm">
              {["Open WhatsApp on the logger phone (the spare number).", "Go to Settings → Linked devices → Link a device.", "Point the phone at the code. It refreshes automatically."].map((t, i) => (
                <li key={t} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold tabular-nums text-muted-foreground">{i + 1}</span>
                  <span className="pt-0.5">{t}</span>
                </li>
              ))}
            </ol>
            <p className="mt-6 text-xs text-muted-foreground">
              Linking uses WhatsApp’s standard “Linked devices” flow. Messages are captured only for the groups you select, and only while a group is logging.
            </p>
          </section>
          <section className="flex flex-col items-center justify-center gap-4 border-t bg-surface-2 p-6 md:border-t-0 md:border-l" aria-live="polite">
            {!s ? (
              <Skeleton className="size-60 rounded-lg" />
            ) : s.linked ? (
              <div className="flex size-60 flex-col items-center justify-center gap-3 text-center">
                <CheckCircle2 className="size-10 text-success" />
                <p className="font-medium">WhatsApp linked</p>
                <p className="text-sm text-muted-foreground">Opening the dashboard…</p>
              </div>
            ) : blocked ? (
              <div className="flex w-60 flex-col items-center gap-3 text-center">
                <p className="text-sm font-medium text-danger">Linking is blocked</p>
                <p className="text-sm text-muted-foreground">{c?.detail}</p>
              </div>
            ) : expired ? (
              <div className="flex size-60 flex-col items-center justify-center gap-3 text-center">
                <p className="font-medium">QR code expired</p>
                <p className="text-sm text-muted-foreground">It wasn’t scanned in time.</p>
                <Button onClick={() => link.mutate()} disabled={link.isPending}>
                  {link.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  Generate new code
                </Button>
              </div>
            ) : pairing ? (
              <div className="flex size-60 flex-col items-center justify-center gap-3 text-center">
                <Loader2 className="size-8 animate-spin text-primary" />
                <p className="font-medium">Linking…</p>
                <p className="text-sm text-muted-foreground">Finishing setup with WhatsApp.</p>
              </div>
            ) : c?.qr ? (
              <>
                <div className="size-60 rounded-lg bg-white p-2 ring-1 ring-border [&_svg]:size-full" role="img" aria-label="WhatsApp link QR code" dangerouslySetInnerHTML={{ __html: c.qr }} />
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Smartphone className="size-3.5" /> Scan with the logger phone
                </p>
              </>
            ) : (
              <div className="flex size-60 flex-col items-center justify-center gap-3 text-center">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Generating code…</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}
