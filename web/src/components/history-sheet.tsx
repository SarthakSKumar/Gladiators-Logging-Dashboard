import { AlertTriangle, History, RotateCw } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { elapsed, full, prettyJid, sessionName, timeOfDay, when } from "@/lib/format"
import { useMessages, useSessions } from "@/lib/queries"
import type { MessageRow, SelectedGroup, Session } from "@/lib/types"

const senderOf = (m: MessageRow) => (m.from_me ? "Logger" : m.member_tag || m.push_name || m.contact_name || prettyJid(m.sender_pn || m.sender_jid))

function SessionSummary({ s }: { s: Session }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>
        {full(s.started_at)} → {s.ended_at ? full(s.ended_at) : "running"}
      </span>
      <span className="tabular-nums">{s.ended_at ? elapsed(s.started_at, s.ended_at) : elapsed(s.started_at)}</span>
      <span className="tabular-nums">
        {s.message_count} message{s.message_count === 1 ? "" : "s"}
      </span>
      {s.late_arrivals > 0 && <span className="tabular-nums">{s.late_arrivals} arrived after stop</span>}
      {s.gaps.length > 0 && (
        <span className="inline-flex items-center gap-1 text-warning-ink">
          <AlertTriangle className="size-3.5" /> Capture was interrupted during this session — messages may be missing
        </span>
      )}
    </div>
  )
}

function MessagesTable({ sessionId }: { sessionId: number }) {
  const q = useMessages(sessionId)
  if (q.isPending)
    return (
      <div className="grid gap-2 p-1" aria-busy="true">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    )
  if (q.isError)
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-sm text-danger">Couldn’t load messages: {q.error.message}</p>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}>
          <RotateCw /> Try again
        </Button>
      </div>
    )
  if (!q.data.rows.length) return <p className="py-12 text-center text-sm text-muted-foreground">No messages in this session yet.</p>
  return (
    <div className="rounded-lg border">
      <Table className="text-[13px]">
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-12 text-right">#</TableHead>
            <TableHead className="w-20">Time</TableHead>
            <TableHead className="w-36">Sender</TableHead>
            <TableHead>Message</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {q.data.rows.map((m) => (
            <TableRow key={m.seq} className="align-top">
              <TableCell className="text-right tabular-nums text-muted-foreground">{m.sno}</TableCell>
              <TableCell className="tabular-nums" title={`Sent ${full(m.wa_timestamp)} · received ${full(m.received_at)}`}>
                {timeOfDay(m.wa_timestamp)}
              </TableCell>
              <TableCell className="max-w-36 truncate font-medium" title={m.sender_pn ? prettyJid(m.sender_pn) : undefined}>
                {senderOf(m)}
              </TableCell>
              <TableCell className="whitespace-pre-wrap break-words">
                {m.quoted_body && <span className="mb-1 block truncate border-l-2 pl-2 text-xs text-muted-foreground">{m.quoted_body}</span>}
                {m.body}
                {m.source === "offline" && <span className="ml-2 text-xs text-muted-foreground">· delivered after reconnect</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {q.data.total > q.data.rows.length && (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground tabular-nums">
          Showing the latest {q.data.rows.length} of {q.data.total}
        </p>
      )}
    </div>
  )
}

export function HistorySheet({ group, open, onOpenChange }: { group: SelectedGroup | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const sessions = useSessions(open && group ? group.id : null)
  const [sessionId, setSessionId] = useState<number | null>(null)
  const list = sessions.data ?? []

  useEffect(() => {
    if (open && list.length && !list.some((s) => s.id === sessionId)) setSessionId(list[0]!.id)
    if (!open) setSessionId(null)
  }, [open, list, sessionId])

  const current = list.find((s) => s.id === sessionId) ?? null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-2">
            <History className="size-4 text-muted-foreground" /> Session history
          </SheetTitle>
          <SheetDescription className="truncate">{group?.label}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {sessions.isPending ? (
            <>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-64 w-full" />
            </>
          ) : sessions.isError ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <p className="text-sm text-danger">Couldn’t load sessions: {sessions.error.message}</p>
              <Button variant="outline" size="sm" onClick={() => sessions.refetch()}>
                <RotateCw /> Try again
              </Button>
            </div>
          ) : !list.length ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <History className="size-8 text-muted-foreground/60" />
              <p className="font-medium">No sessions found for this group</p>
              <p className="text-sm text-muted-foreground">Start logging to create the first session.</p>
            </div>
          ) : (
            <>
              <Select value={sessionId ? String(sessionId) : undefined} onValueChange={(v) => setSessionId(Number(v))}>
                <SelectTrigger className="w-full" aria-label="Session">
                  <SelectValue placeholder="Choose a session" />
                </SelectTrigger>
                <SelectContent>
                  {list.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      <span className="truncate">{sessionName(s)}</span>
                      <span className="text-muted-foreground tabular-nums">
                        · {when(s.started_at)}
                        {s.ended_at ? "" : " · running"}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {current && <SessionSummary s={current} />}
              {current && <MessagesTable sessionId={current.id} />}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
