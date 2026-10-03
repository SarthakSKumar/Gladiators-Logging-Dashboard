import { Check, Loader2, Minus, Plus, RefreshCw, Search, Users } from "lucide-react"
import { useMemo, useState } from "react"
import { StatusPill } from "@/components/status"
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
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { ago, num } from "@/lib/format"
import { notifySuccess } from "@/lib/notify"
import { useAccountGroups, useAddGroup, useRefreshAccountGroups, useRemoveGroup, useStatus } from "@/lib/queries"
import type { SelectedGroup } from "@/lib/types"

export function GroupsSettings() {
  const status = useStatus().data
  const account = useAccountGroups()
  const refresh = useRefreshAccountGroups()
  const add = useAddGroup()
  const remove = useRemoveGroup()
  const [q, setQ] = useState("")
  const [confirm, setConfirm] = useState<SelectedGroup | null>(null)

  const selectedById = useMemo(() => new Map((status?.groups ?? []).map((g) => [g.id, g])), [status])
  const all = account.data?.groups ?? []
  const filtered = all.filter((g) => (g.subject ?? g.jid).toLowerCase().includes(q.trim().toLowerCase()))
  // selected groups that are not (or no longer) in the account's list — still shown so they can be removed
  const orphaned = (status?.groups ?? []).filter((g) => !all.some((a) => a.group_id === g.id && a.selected))
  const linked = status?.linked

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input className="pl-8" placeholder="Search groups" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search groups" />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {account.data?.fetchedAt ? `Updated ${ago(account.data.fetchedAt)}` : "Not loaded yet"}
          {all.length ? ` · ${all.length} groups · ${status?.groups.length ?? 0} selected` : ""}
        </span>
        <Button variant="outline" size="sm" className="ml-auto" disabled={!linked || refresh.isPending} onClick={() => refresh.mutate(undefined, { onSuccess: () => notifySuccess("Group list refreshed") })}>
          {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Refresh
        </Button>
      </div>

      {orphaned.length > 0 && (
        <div className="divide-y overflow-hidden rounded-xl border border-warning/40 bg-background">
          {orphaned.map((g) => (
            <div key={g.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{g.label}</p>
                <p className="truncate text-xs text-muted-foreground">{g.action || "Not in the linked account’s group list."}</p>
              </div>
              <StatusPill tone="warn">{g.status === "inaccessible" ? "Removed from group" : "Not found"}</StatusPill>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(g)}>
                <Minus /> Remove
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-background">
        {account.isPending ? (
          <div className="divide-y">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex h-14 items-center gap-3 px-4">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="ml-auto h-8 w-20" />
              </div>
            ))}
          </div>
        ) : account.isError ? (
          <p className="px-4 py-6 text-sm text-danger">Couldn’t load groups: {account.error.message}</p>
        ) : !all.length ? (
          <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
            <Users className="size-8 text-muted-foreground/60" />
            <p className="font-medium">No groups loaded</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {linked ? "Refresh to load the WhatsApp groups the linked number is in." : "Link WhatsApp first, then refresh to load its groups."}
            </p>
            <Button size="sm" disabled={!linked || refresh.isPending} onClick={() => refresh.mutate()}>
              {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />} Load groups
            </Button>
          </div>
        ) : !filtered.length ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">No groups match “{q}”.</p>
        ) : (
          <ul className="divide-y">
            {filtered.map((g) => {
              const sel = g.selected && g.group_id != null ? selectedById.get(g.group_id) : undefined
              const busy = (add.isPending && add.variables === g.jid) || (remove.isPending && remove.variables === g.group_id)
              return (
                <li key={g.jid} className="flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2/60">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{g.subject || g.jid}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">{g.size != null ? `${num(g.size)} members` : "—"}</p>
                  </div>
                  {g.selected && (
                    <StatusPill tone={sel?.session ? "live" : "idle"} ping={Boolean(sel?.session)}>
                      {sel?.session ? "Logging" : "Selected"}
                    </StatusPill>
                  )}
                  {g.selected ? (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => sel && setConfirm(sel)} aria-label={`Remove ${g.subject}`}>
                      {busy ? <Loader2 className="animate-spin" /> : <Minus />} Remove
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => add.mutate(g.jid, { onSuccess: () => notifySuccess("Group added", g.subject ?? undefined) })}
                      aria-label={`Add ${g.subject}`}
                    >
                      {busy ? <Loader2 className="animate-spin" /> : <Plus />} Add
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check className="size-3.5" /> Groups are tracked by their WhatsApp id, so renaming a group doesn’t break logging. Removing a group keeps its history.
      </p>

      <AlertDialog open={confirm != null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{confirm?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.session ? "Its running session is stopped first. " : ""}
              New messages from this group won’t be captured. Logged history is kept, and adding the group again restores it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-white hover:bg-danger/90"
              onClick={() => confirm && remove.mutate(confirm.id, { onSuccess: () => notifySuccess("Group removed", confirm.label) })}
            >
              Remove group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
