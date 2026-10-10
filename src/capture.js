// Capture manager: decides whether the WhatsApp socket should be up and makes it so.
//
// Level-triggered, not edge-triggered: every input change (session start/stop, group add/remove,
// link request, pressure, socket closed) calls reconcile(), which compares *desired* with *actual*
// and acts. Reconciles run one at a time (promise chain), and a 5 s safety tick re-runs it — so a
// "resume" can never be lost the way the old suspend()/resume() pair could, and rapid start/stop
// clicks can't leave the socket half open.
//
// desired up  ⇔  not blocked  ∧  no pressure  ∧  ( linking requested ∧ ¬linked
//                                                  ∨ linked ∧ (a group is logging ∨ a lease is held) )
//
// UI capture states: not_linked · linking · idle · starting · capturing · error
export const createCapture = ({ connection, loggingCount, events, log, onChange, now = Date.now, tickMs = 5000 }) => {
  const leases = new Map() // name → expiry
  const pressure = new Map() // reason → detail
  let linkRequested = false
  let chain = Promise.resolve()
  let wasCapturing = false
  let timer = null

  const linked = () => connection.state().linked
  const activeLeases = () => {
    const t = now()
    for (const [k, exp] of leases) if (exp <= t) leases.delete(k)
    return leases.size
  }
  const desiredUp = () => {
    const s = connection.state()
    if (s.blocked || pressure.size) return false
    if (!s.linked) return linkRequested
    return loggingCount() > 0 || activeLeases() > 0
  }

  /** Emits capture.started / capture.stopped on transitions; called after every reconcile and socket state change. */
  const observe = () => {
    const capturing = captureState().state === 'capturing'
    if (capturing === wasCapturing) return
    wasCapturing = capturing
    events.emit(capturing
      ? { level: 'info', code: 'capture.started', message: 'Capture started' }
      : { level: 'info', code: 'capture.stopped', message: loggingCount() > 0 ? 'Capture interrupted' : 'Capture stopped (no group is logging)', noise: loggingCount() > 0 })
  }

  const doReconcile = async () => {
    const want = desiredUp()
    const { phase } = connection.state()
    if (want && phase === 'down') await connection.open()
    else if (!want && !['down', 'closing'].includes(phase)) await connection.close()
    observe()
    onChange?.()
  }

  const reconcile = () => {
    chain = chain.then(doReconcile).catch(err => {
      log.error({ err: err.stack }, 'capture: reconcile failed')
      events.emit({ level: 'error', code: 'capture.reconcile_failed', message: `Capture control failed: ${err.message}` })
    })
    return chain
  }

  /** What the dashboard shows. */
  const captureState = () => {
    const s = connection.state()
    const logging = loggingCount()
    const base = { phase: s.phase, logging, detail: s.detail, since: s.since, attempt: s.attempt, nextRetryAt: s.nextRetryAt, code: s.code }
    if (s.blocked) return { ...base, state: 'error', reason: s.blocked.reason, detail: s.blocked.detail }
    if (!s.linked) {
      if (['qr', 'pairing', 'connecting', 'reconnecting'].includes(s.phase) && linkRequested) return { ...base, state: 'linking', qr: s.qr, qrExpired: false }
      return { ...base, state: 'not_linked', qrExpired: s.qrExpired }
    }
    if (s.phase === 'pairing') return { ...base, state: 'linking' }
    if (pressure.size) return { ...base, state: 'error', reason: 'paused', detail: `Capture paused to protect data: ${[...pressure.keys()].join(', ')}. It resumes automatically.` }
    if (!logging) return { ...base, state: 'idle', detail: s.phase === 'down' ? 'No group is logging' : 'No group is logging (syncing account data)' }
    if (s.phase === 'online') return { ...base, state: 'capturing' }
    if (s.phase === 'reconnecting' && s.attempt >= 3) return { ...base, state: 'error', reason: 'reconnecting' }
    return { ...base, state: 'starting' }
  }

  return {
    reconcile,
    observe,
    captureState,
    desiredUp,
    start () { timer = setInterval(reconcile, tickMs); return reconcile() },
    async stop () { clearInterval(timer); await chain },
    requestLink () { if (!linked()) { linkRequested = true; return reconcile() } return chain },
    cancelLink () { linkRequested = false; return reconcile() },
    /** called when linking ends (linked, expired or failed) */
    linkSettled () { linkRequested = false },
    /** keep the socket up for `ms` (e.g. refreshing the account's group list); returns a release fn */
    lease (name, ms) {
      leases.set(name, now() + ms)
      reconcile()
      return () => { leases.delete(name); reconcile() }
    },
    setPressure (reason, on, detail) {
      const had = pressure.has(reason)
      if (on) pressure.set(reason, detail ?? true); else pressure.delete(reason)
      if (on !== had) {
        events.emit(on
          ? { level: 'error', code: 'capture.paused', message: `Capture paused to protect data (${reason}). WhatsApp keeps queueing messages; capture resumes automatically.`, context: { reason, detail } }
          : { level: 'info', code: 'capture.resumed', message: `Capture resumed (${reason} cleared)` })
        reconcile()
      }
    },
    pressureReasons: () => [...pressure.keys()]
  }
}
