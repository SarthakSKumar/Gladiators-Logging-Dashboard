import { Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useSessions, useStartLogging } from "@/lib/queries"
import type { SelectedGroup } from "@/lib/types"

/** Start logging needs a session label (and optionally a race number); prefilled from the last session. */
export function StartLoggingDialog({ group, open, onOpenChange }: { group: SelectedGroup; open: boolean; onOpenChange: (o: boolean) => void }) {
  const sessions = useSessions(open ? group.id : null)
  const start = useStartLogging()
  const [label, setLabel] = useState("")
  const [race, setRace] = useState<string>("none")

  useEffect(() => {
    if (!open) return
    const last = sessions.data?.[0]
    const nextRace = last?.race_number && last.race_number < 10 ? last.race_number + 1 : null
    setRace(nextRace ? String(nextRace) : "none")
    setLabel(nextRace ? `Race ${nextRace}` : "")
  }, [open, sessions.data])

  const submit = () => {
    if (!label.trim()) return
    start.mutate({ groupId: group.id, label: label.trim(), raceNumber: race === "none" ? null : Number(race) }, { onSuccess: () => onOpenChange(false) })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>Start logging</DialogTitle>
            <DialogDescription className="truncate">{group.label}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="session-label">Session label</Label>
            <Input id="session-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="e.g. Race 3 — Mysore" autoFocus required />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="race">Race number</Label>
            <Select
              value={race}
              onValueChange={(v) => {
                if (/^Race \d+$/.test(label) || !label) setLabel(v === "none" ? "" : `Race ${v}`)
                setRace(v)
              }}
            >
              <SelectTrigger id="race" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No race number</SelectItem>
                {Array.from({ length: 10 }, (_, i) => (
                  <SelectItem key={i + 1} value={String(i + 1)}>
                    Race {i + 1}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {start.error && (
            <p role="alert" className="text-sm text-danger">
              {start.error.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!label.trim() || start.isPending}>
              {start.isPending && <Loader2 className="animate-spin" />}
              Start logging
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
