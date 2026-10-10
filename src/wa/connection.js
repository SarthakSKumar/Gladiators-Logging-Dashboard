// WhatsApp socket lifecycle + state machine (plan §7). Every state is pushed to the UI.
//   STARTING → NEEDS_LINK (QR) → LINKING → SYNCING (offline backlog) → ONLINE
//   ONLINE → RECONNECTING (backoff) | NEEDS_LINK (logged out) | REPLACED | RESTRICTED | NEEDS_OPERATOR
//   SUSPENDED (backpressure: we deliberately disconnect so WhatsApp keeps queueing for us)
//   LINK_IDLE (QR not scanned for 5 min, or unlinked from the dashboard) · STOPPED
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from 'baileys'
import QRCode from 'qrcode'

const LINK_WINDOW_MS = 5 * 60_000
const STABLE_MS = 60_000
const PENDING_FLAG_TIMEOUT_MS = 60_000
const RESTRICTED_RETRY_MS = 5 * 60_000
const MAX_BAD_SESSION = 10

const defaultGetVersion = async () => {
  try {
    const r = await Promise.race([fetchLatestBaileysVersion(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))])
    return r.version
  } catch { return undefined } // fall back to the version baked into the pinned Baileys release
}

export const createConnection = ({
  authStore, intake, log, baileysLogger, onState, onOpen, onLoggedOut,
  makeSocket = makeWASocket, getVersion = defaultGetVersion, now = Date.now, random = Math.random
}) => {
  let sock = null
  let intentional = null // why *we* closed the socket: 'stop' | 'restart' | 'suspend' | 'unlink' | 'idle'
  let retryTimer = null
  let pendingTimer = null
  let stableTimer = null
  let linkStartedAt = null
  let attempt = 0
  let badSession = 0
  let pendingDone = false
  let state = { state: 'STARTING', detail: 'Starting…', since: now(), code: null, attempt: 0, nextRetryAt: null, qr: null, me: null, suspendReason: null }

  const set = next => {
    const changed = next.state && next.state !== state.state
    state = { ...state, ...next, since: changed ? now() : state.since }
    onState?.(state, changed)
  }
  const clearTimers = () => { clearTimeout(retryTimer); clearTimeout(pendingTimer); clearTimeout(stableTimer) }

  let stopped = false
  const connect = async () => {
    if (stopped) return
    clearTimers()
    intentional = null
    pendingDone = false
    if (!authStore.isRegistered() && linkStartedAt === null) linkStartedAt = now()
    let s
    try {
      const version = await getVersion()
      if (stopped) return
      s = makeSocket({
        auth: { creds: authStore.creds, keys: makeCacheableSignalKeyStore(authStore.keys, baileysLogger) },
        version,
        logger: baileysLogger,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false, // see Phase 0 item G (A/B)
        syncFullHistory: false,
        emitOwnEvents: true,
        getMessage: async () => undefined, // we never send group messages, so no retries of our own sends
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 25_000
      })
    } catch (err) {
      log.error({ err: err.message }, 'wa: could not create socket')
      return backoff(null, `Could not start the WhatsApp client (${err.message})`)
    }
    sock = s
    s.ev.process(async events => {
      if (events['creds.update']) await authStore.saveCreds()
      // connection events from an old socket are ignored; its *messages* are still ingested below
      if (events['connection.update'] && s === sock) await onConnUpdate(events['connection.update'])
      intake.enqueue(events)
    })
  }

  const onConnUpdate = async u => {
    if (u.qr) {
      if (now() - (linkStartedAt ?? now()) > LINK_WINDOW_MS) return goIdle('QR was not scanned for 5 minutes')
      const svg = await QRCode.toString(u.qr, { type: 'svg', margin: 1, errorCorrectionLevel: 'L' })
      set({ state: 'NEEDS_LINK', qr: svg, detail: 'Open WhatsApp on the logger phone → Linked devices → Link a device, and scan this code.', code: null })
    }
    if (u.isNewLogin) set({ state: 'LINKING', qr: null, detail: 'Phone linked — finishing setup…' })
    if (u.receivedPendingNotifications === true) {
      pendingDone = true
      if (state.state === 'SYNCING') goOnline()
    }
    if (u.connection === 'connecting' && authStore.isRegistered() && state.state !== 'LINKING') {
      set({ state: attempt ? 'RECONNECTING' : 'CONNECTING', qr: null, detail: attempt ? `Reconnecting (attempt ${attempt})…` : 'Connecting…' })
    }
    if (u.connection === 'open') {
      linkStartedAt = null
      badSession = 0
      const me = sock.user ? { id: sock.user.id, lid: sock.user.lid, name: sock.user.name } : null
      set({ state: 'SYNCING', qr: null, me, code: null, nextRetryAt: null, detail: 'Connected — receiving messages queued while offline…' })
      stableTimer = setTimeout(() => { attempt = 0 }, STABLE_MS)
      pendingTimer = setTimeout(() => { if (state.state === 'SYNCING') goOnline(true) }, PENDING_FLAG_TIMEOUT_MS)
      if (pendingDone) goOnline()
      onOpen?.(sock)
    }
    if (u.connection === 'close') onClose(u.lastDisconnect)
  }

  const goOnline = (noMarker = false) => {
    clearTimeout(pendingTimer)
    set({ state: 'ONLINE', detail: noMarker ? 'Online (offline-backlog marker not received within 60 s)' : 'Online — capturing', attempt: 0 })
  }

  const goIdle = reason => {
    intentional = 'idle'
    linkStartedAt = null
    set({ state: 'LINK_IDLE', qr: null, detail: `${reason}. Click "Show QR" to link.` })
    sock?.end(undefined)
  }

  const backoff = (code, detail) => {
    attempt++
    const base = Math.min(60_000, 1000 * 2 ** (attempt - 1))
    const delay = Math.round(base * (0.8 + random() * 0.4))
    set({ state: 'RECONNECTING', attempt, code, nextRetryAt: now() + delay, detail: `${detail} — retrying in ${Math.ceil(delay / 1000)} s (attempt ${attempt})` })
    retryTimer = setTimeout(connect, delay)
  }

  const onClose = lastDisconnect => {
    clearTimers()
    const err = lastDisconnect?.error
    const code = err?.output?.statusCode ?? err?.statusCode ?? null
    const message = err?.message || 'connection closed'
    log.warn({ code, message, intentional }, 'wa: connection closed')

    if (intentional) {
      const why = intentional
      intentional = null
      if (why === 'stop') return set({ state: 'STOPPED', detail: 'Stopped', code })
      if (why === 'suspend') return set({ state: 'SUSPENDED', detail: `Paused to protect data: ${state.suspendReason}. WhatsApp keeps queueing messages meanwhile.`, code })
      if (why === 'restart') return void connect()
      if (why === 'idle') return
      if (why === 'unlink') {
        authStore.wipe()
        onLoggedOut?.('unlinked')
        return set({ state: 'LINK_IDLE', qr: null, me: null, detail: 'Device unlinked from the dashboard. Click "Show QR" to link again.' })
      }
    }

    switch (code) {
      case DisconnectReason.loggedOut:
        authStore.wipe()
        onLoggedOut?.('logged_out')
        linkStartedAt = now()
        set({ state: 'NEEDS_LINK', qr: null, me: null, code, detail: 'WhatsApp logged this device out (removed from the phone or expired). Scan the QR to link again.' })
        return void connect()
      case DisconnectReason.connectionReplaced:
        return set({ state: 'REPLACED', code, detail: 'Another session using this account replaced this one. Not reconnecting automatically — make sure only one logger runs, then click Reconnect.' })
      case DisconnectReason.restartRequired:
        return void connect()
      case DisconnectReason.forbidden:
      case DisconnectReason.unavailableService:
        set({ state: 'RESTRICTED', code, nextRetryAt: now() + RESTRICTED_RETRY_MS, detail: `WhatsApp refused the connection (${code}). The account may be restricted. Retrying every 5 minutes.` })
        retryTimer = setTimeout(connect, RESTRICTED_RETRY_MS)
        return
      case DisconnectReason.badSession:
        if (++badSession >= MAX_BAD_SESSION) {
          return set({ state: 'NEEDS_OPERATOR', code, detail: `Session failed ${badSession} times in a row (bad session). Unlink and link again from Settings.` })
        }
        return backoff(code, 'Bad session')
      default:
        if (!authStore.isRegistered()) {
          // QR refs exhausted (408) or a drop while linking: new QR within the link window, else idle
          if (now() - (linkStartedAt ?? now()) > LINK_WINDOW_MS) return goIdle('QR was not scanned for 5 minutes')
          return void connect()
        }
        return backoff(code, message)
    }
  }

  return {
    start: connect,
    state: () => state,
    socket: () => sock,
    stop: async () => {
      stopped = true
      clearTimers()
      if (sock && state.state !== 'STOPPED') { intentional = 'stop'; await sock.end(undefined) } else set({ state: 'STOPPED' })
    },
    restart: () => { clearTimers(); attempt = 0; if (sock && !['RECONNECTING', 'LINK_IDLE', 'REPLACED', 'RESTRICTED', 'SUSPENDED', 'STOPPED'].includes(state.state)) { intentional = 'restart'; sock.end(undefined) } else connect() },
    suspend: reason => {
      if (['SUSPENDED', 'STOPPED', 'NEEDS_OPERATOR'].includes(state.state)) return
      clearTimers()
      state.suspendReason = reason
      if (sock) { intentional = 'suspend'; sock.end(undefined) } else set({ state: 'SUSPENDED', detail: `Paused: ${reason}` })
    },
    resume: () => { if (state.state === 'SUSPENDED') { state.suspendReason = null; connect() } },
    showQr: () => { if (['LINK_IDLE', 'NEEDS_LINK'].includes(state.state)) { linkStartedAt = now(); intentional = null; connect() } },
    /** Unlink this device on WhatsApp's side, then wipe local credentials. */
    unlink: async () => {
      clearTimers()
      if (sock && ['ONLINE', 'SYNCING'].includes(state.state)) {
        intentional = 'unlink'
        try { await sock.logout('Unlinked from dashboard'); return } catch (err) {
          log.warn({ err: err.message }, 'wa: logout request failed; wiping locally')
        }
      }
      intentional = null
      try { sock?.end(undefined) } catch { /* already closed */ }
      authStore.wipe()
      onLoggedOut?.('unlinked')
      set({ state: 'LINK_IDLE', qr: null, me: null, detail: 'Local credentials removed. If the device still shows under Linked devices on the phone, remove it there. Click "Show QR" to link again.' })
    },
    operatorBlocked: detail => set({ state: 'NEEDS_OPERATOR', detail }),
    isOnline: () => state.state === 'ONLINE',
    sendText: async (jid, text) => {
      if (state.state !== 'ONLINE') throw new Error('not online')
      return sock.sendMessage(jid, { text })
    },
    fetchGroups: () => sock.groupFetchAllParticipating()
  }
}
