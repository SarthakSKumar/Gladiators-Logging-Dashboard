// Time is stored in UTC ms and shown in the server's display zone (IST).
let zone = "Asia/Kolkata"
export const setTimeZone = (tz: string) => {
  zone = tz || zone
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...opts })
const dayKey = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, dateStyle: "short" }).format(ms)

export const timeOfDay = (ms: number) => fmt({ hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(ms)
export const shortTime = (ms: number) => fmt({ hour: "2-digit", minute: "2-digit", hour12: false }).format(ms)

/** "14:03" today, "Yesterday 14:03", or "8 Oct 14:03". */
export const when = (ms: number | null | undefined) => {
  if (!ms) return "—"
  if (dayKey(ms) === dayKey(Date.now())) return shortTime(ms)
  if (dayKey(ms) === dayKey(Date.now() - 86_400_000)) return `Yesterday ${shortTime(ms)}`
  return `${fmt({ day: "numeric", month: "short" }).format(ms)} ${shortTime(ms)}`
}
export const full = (ms: number | null | undefined) =>
  ms ? fmt({ dateStyle: "medium", timeStyle: "medium", hour12: false }).format(ms) : "—"

export const ago = (ms: number | null | undefined, now = Date.now()) => {
  if (!ms) return "never"
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 10) return "just now"
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86_400)} d ago`
}

/** Elapsed "1h 04m" / "12m 05s" / "45s". */
export const elapsed = (from: number, to = Date.now()) => {
  const s = Math.max(0, Math.floor((to - from) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`
  if (m) return `${m}m ${String(r).padStart(2, "0")}s`
  return `${r}s`
}

export const sessionName = (s: { label: string; race_number: number | null }) =>
  s.race_number && !new RegExp(`\\b${s.race_number}\\b`).test(s.label) ? `${s.label} · Race ${s.race_number}` : s.label

export const greeting = (now = Date.now()) => {
  const h = Number(fmt({ hour: "2-digit", hour12: false }).format(now))
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"
}

export const prettyJid = (jid: string | null | undefined) => {
  if (!jid) return "Unknown"
  const user = jid.split(/[@:]/)[0]
  return jid.includes("@lid") ? `Hidden number ·${user.slice(-4)}` : `+${user}`
}

export const bytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(0)} MB`)
export const num = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en-IN").format(n))
