import { toast } from "sonner"
import type { OpEvent } from "./types"

// One toast per problem: identical messages within the window are dropped, and a coalesced
// server event (same id, count+1) never re-toasts.
const WINDOW_MS = 30_000
const seen = new Map<string, number>()
const shouldShow = (key: string) => {
  const now = Date.now()
  for (const [k, t] of seen) if (now - t > WINDOW_MS) seen.delete(k)
  if (seen.has(key)) return false
  seen.set(key, now)
  return true
}

export const notifyError = (message: string, description?: string) => {
  if (shouldShow(`err|${message}`)) toast.error(message, { description })
}
export const notifySuccess = (message: string, description?: string) => {
  if (shouldShow(`ok|${message}|${description ?? ""}`)) toast.success(message, { description })
}

/** Live operator events: errors/warnings always, info only when it is not expected noise. */
export const notifyOpEvent = (e: OpEvent) => {
  if (e.noise) return
  if (!shouldShow(`ev|${e.id}`) || !shouldShow(`evmsg|${e.code}|${e.message}`)) return
  const opts = { description: e.count > 1 && e.level !== "info" ? `Repeated ${e.count}× in the last minute` : undefined }
  if (e.level === "error") toast.error(e.message, opts)
  else if (e.level === "warn") toast.warning(e.message, opts)
  else if (e.code === "capture.started" || e.code === "wa.linked") toast.success(e.message, opts)
  else toast.info(e.message, opts)
}
