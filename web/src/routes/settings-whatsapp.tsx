import { Loader2, RotateCw, Unlink } from "lucide-react"
import { useState } from "react"
import { CaptureBadge } from "@/components/status"
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
import { Skeleton } from "@/components/ui/skeleton"
import { ago, full } from "@/lib/format"
import { notifySuccess } from "@/lib/notify"
import { useRestartConnection, useStatus, useUnlink } from "@/lib/queries"

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  )
}

const PHASE: Record<string, string> = {
  down: "Disconnected",
  connecting: "Connecting",
  qr: "Waiting for QR scan",
  pairing: "Pairing",
  syncing: "Starting",
  online: "Connected",
  reconnecting: "Reconnecting",
  closing: "Closing safely",
}

export function WhatsAppSettings() {
  const status = useStatus()
  const restart = useRestartConnection()
  const unlink = useUnlink()
  const [confirm, setConfirm] = useState(false)
  const s = status.data
  if (!s) return <Skeleton className="h-64 w-full rounded-xl" />
  const c = s.capture

  return (
    <div className="grid gap-6">
      <section className="grid gap-3" aria-labelledby="account-heading">
        <h2 id="account-heading" className="text-sm font-semibold">
          Linked account
        </h2>
        <dl className="divide-y overflow-hidden rounded-xl border bg-background">
          <Row label="Account">{s.me?.name || "—"}</Row>
          <Row label="Number">
            <span className="tabular-nums">{s.me?.number || "—"}</span>
          </Row>
          <Row label="Capture">
            <CaptureBadge capture={c} />
          </Row>
          <Row label="Connection">
            <span>{PHASE[c.phase] ?? c.phase}</span>
            <span className="text-muted-foreground"> · since {ago(c.since)}</span>
            {c.detail && !["Online", "Disconnected"].includes(c.detail) && <p className="mt-0.5 text-xs text-muted-foreground">{c.detail}</p>}
            {c.nextRetryAt && c.nextRetryAt > Date.now() && <p className="mt-0.5 text-xs text-muted-foreground">Next attempt at {full(c.nextRetryAt)}</p>}
          </Row>
          <Row label="Groups logging">
            <span className="tabular-nums">{c.logging}</span>
            <span className="text-muted-foreground"> · only messages sent while a group is logging are stored</span>
          </Row>
        </dl>
      </section>

      <section className="grid gap-3" aria-labelledby="actions-heading">
        <h2 id="actions-heading" className="text-sm font-semibold">
          Connection
        </h2>
        <div className="divide-y overflow-hidden rounded-xl border bg-background">
          <div className="flex flex-wrap items-center gap-4 px-4 py-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium">Restart connection</p>
              <p className="text-sm text-muted-foreground">Reconnects with the existing link. Use it after an error such as “replaced” or “restricted”. Nothing is unlinked.</p>
            </div>
            <Button variant="outline" disabled={restart.isPending} onClick={() => restart.mutate(undefined, { onSuccess: () => notifySuccess("Connection restarted") })}>
              {restart.isPending ? <Loader2 className="animate-spin" /> : <RotateCw />} Restart
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-4 px-4 py-4">
            <div className="min-w-0 flex-1">
              <p className="font-medium">Unlink WhatsApp</p>
              <p className="text-sm text-muted-foreground">Removes this logger from the phone’s linked devices and deletes its keys. You’ll need to scan a new QR code.</p>
            </div>
            <Button variant="outline" className="border-danger/40 text-danger hover:bg-danger-soft hover:text-danger" disabled={!s.linked || unlink.isPending} onClick={() => setConfirm(true)}>
              {unlink.isPending ? <Loader2 className="animate-spin" /> : <Unlink />} Unlink
            </Button>
          </div>
        </div>
      </section>

      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink WhatsApp?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-2 text-sm text-muted-foreground">
                <p>This will:</p>
                <ul className="list-disc pl-5">
                  <li>stop every running logging session,</li>
                  <li>remove this logger from the phone’s linked devices,</li>
                  <li>delete the stored WhatsApp keys on the server.</li>
                </ul>
                <p>Messages sent while unlinked are never delivered later. Logged history is kept.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-danger text-white hover:bg-danger/90" onClick={() => unlink.mutate()}>
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
