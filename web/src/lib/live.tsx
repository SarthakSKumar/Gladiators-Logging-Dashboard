import { useQueryClient } from "@tanstack/react-query"
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { setTimeZone } from "./format"
import { notifyOpEvent } from "./notify"
import { keys } from "./queries"
import type { MessageRow, OpEvent, Status } from "./types"

interface Live {
  /** server reachable and streaming (ping within the last 25 s) */
  online: boolean
  lastMessage: MessageRow | null
}
const LiveContext = createContext<Live>({ online: false, lastMessage: null })
export const useLive = () => useContext(LiveContext)

const PING_TIMEOUT_MS = 25_000

/**
 * One EventSource per tab. The server pushes:
 *   status  → replaces the status query (capture state, groups, sessions)
 *   msg     → a newly committed text message (refreshes KPIs and open history tables)
 *   opevent → typed operator event (toast + Logs)
 *   ping    → every 10 s (drives the server-live dot)
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [online, setOnline] = useState(false)
  const [lastMessage, setLastMessage] = useState<MessageRow | null>(null)
  const lastPing = useRef(0)
  const throttle = useRef<number | null>(null)

  useEffect(() => {
    let es: EventSource | null = null
    let closed = false
    const connect = () => {
      es = new EventSource("/api/stream")
      es.addEventListener("open", () => {
        lastPing.current = Date.now()
        setOnline(true)
        // resync anything that may have changed while we were disconnected
        qc.invalidateQueries({ queryKey: keys.kpis })
        qc.invalidateQueries({ queryKey: keys.events })
      })
      es.addEventListener("error", async () => {
        setOnline(false)
        // the stream also fails when the session expired: send the user back to sign in
        const r = await fetch("/api/auth/me", { credentials: "same-origin" }).catch(() => null)
        if (r?.status === 401 && !closed) window.location.replace("/login")
      })
      es.addEventListener("ping", () => {
        lastPing.current = Date.now()
        setOnline(true)
      })
      es.addEventListener("status", (e) => {
        lastPing.current = Date.now()
        const s = JSON.parse((e as MessageEvent).data) as Status
        setTimeZone(s.tz)
        qc.setQueryData(keys.status, s)
      })
      es.addEventListener("msg", (e) => {
        const m = JSON.parse((e as MessageEvent).data) as MessageRow
        setLastMessage(m)
        if (throttle.current) return
        throttle.current = window.setTimeout(() => {
          throttle.current = null
          qc.invalidateQueries({ queryKey: keys.kpis })
          qc.invalidateQueries({ queryKey: ["messages"] })
          qc.invalidateQueries({ queryKey: ["sessions"] })
        }, 600)
      })
      es.addEventListener("opevent", (e) => {
        const ev = JSON.parse((e as MessageEvent).data) as OpEvent
        notifyOpEvent(ev)
        qc.setQueryData<OpEvent[]>(keys.events, (prev) => (prev ? [ev, ...prev.filter((p) => p.id !== ev.id)].slice(0, 500) : prev))
      })
    }
    connect()
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastPing.current > PING_TIMEOUT_MS) setOnline(false)
    }, 5000)
    return () => {
      closed = true
      es?.close()
      window.clearInterval(watchdog)
      if (throttle.current) window.clearTimeout(throttle.current)
    }
  }, [qc])

  return <LiveContext.Provider value={{ online, lastMessage }}>{children}</LiveContext.Provider>
}
