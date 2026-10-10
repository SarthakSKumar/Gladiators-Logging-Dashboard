// Down/degraded alerts to the admins in config/admins.json (plan §9).
// WhatsApp cannot announce its own outage, so outage alerts go by email; WhatsApp (from the logger's own
// number) is used for degraded-but-connected conditions and recovery notices. Deduplicated per
// condition, repeated at most hourly while active, daily-capped, bounded queue. Never includes message content.
const REPEAT_MS = 60 * 60_000
const DAY_MS = 24 * 3600_000
const CAPS = { email: 60, whatsapp: 10 }
const MAX_QUEUE = 100

export const createAlerts = ({ loadAdmins, mailer, whatsapp, tz, log, now = Date.now }) => {
  const active = new Map()
  const sentLog = { email: [], whatsapp: [] }
  let queue = Promise.resolve()
  let queued = 0
  let dropped = 0

  const fmt = t => new Date(t).toLocaleString('en-IN', { timeZone: tz, hour12: false })
  const underCap = ch => {
    const cutoff = now() - DAY_MS
    sentLog[ch] = sentLog[ch].filter(t => t > cutoff)
    return sentLog[ch].length < CAPS[ch]
  }

  const dispatch = (channels, subject, text) => {
    if (queued >= MAX_QUEUE) { dropped++; return }
    queued++
    queue = queue.then(async () => {
      const admins = loadAdmins().filter(a => a.alerts)
      for (const ch of channels) {
        if (!underCap(ch)) { log.warn({ ch }, 'alerts: daily cap reached'); continue }
        for (const a of admins) {
          try {
            if (ch === 'email' && mailer.configured && a.email) await mailer.send({ to: a.email, subject, text })
            else if (ch === 'whatsapp' && a.phone && whatsapp.isOnline()) await whatsapp.send(`${a.phone}@s.whatsapp.net`, `${subject}\n${text}`)
            else continue
            sentLog[ch].push(now())
          } catch (err) { log.warn({ err: err.message, ch }, 'alerts: delivery failed') }
        }
      }
    }).finally(() => { queued-- })
  }

  return {
    /** channels: which to use when raised; outages must include 'email' */
    raise (key, { title, detail = '', channels = ['email'], severity = 'critical' }) {
      const t = now()
      const a = active.get(key)
      if (a) {
        a.detail = detail
        if (t - a.lastSent < REPEAT_MS) return
        a.lastSent = t
      } else {
        active.set(key, { key, title, detail, severity, since: t, lastSent: t, channels })
      }
      const subject = `[WA Logger] ${severity === 'critical' ? 'ALERT' : 'Warning'}: ${title}`
      dispatch(channels, subject, `${detail}\nSince: ${fmt(active.get(key).since)} IST`)
    },
    clear (key) {
      const a = active.get(key)
      if (!a) return
      active.delete(key)
      const mins = Math.max(1, Math.round((now() - a.since) / 60_000))
      dispatch(['email', 'whatsapp'], `[WA Logger] Resolved: ${a.title}`, `Resolved after ~${mins} min (since ${fmt(a.since)} IST).`)
    },
    /** one-shot informational message (no active state, no resolved notice) */
    notify ({ title, detail = '', channels = ['email'] }) {
      dispatch(channels, `[WA Logger] ${title}`, detail)
    },
    list: () => [...active.values()],
    stats: () => ({ queued, dropped, sentToday: { email: sentLog.email.length, whatsapp: sentLog.whatsapp.length } }),
    idle: () => queue
  }
}
