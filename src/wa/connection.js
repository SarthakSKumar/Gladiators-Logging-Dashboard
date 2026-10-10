// WhatsApp socket driver. It only knows how to open, close and keep one socket healthy; *whether* the
// socket should be up is decided by the capture manager (src/capture.js) via shouldStayUp().
//
// phases: down · connecting · qr · pairing · syncing · online · reconnecting · closing
// blocked: { reason: 'replaced' | 'restricted' | 'bad_session' | 'operator', detail } — not reopened
//          automatically (except 'restricted', retried every 5 min) until restart().
//
// Closing is graceful: we stop using the socket ourselves, wait until WhatsApp's offline backlog has
// been flushed and the event stream has been quiet for a moment (app-state sync, receipts and message
// handlers run inside Baileys), then end it. Ending mid-sync is what caused "Connection Closed" (428)
// failures in message handling and presence updates.
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from 'baileys'
import QRCode from 'qrcode'

const MAX_BAD_SESSION = 10
const sleep = ms => new Promise(r => setTimeout(r, ms))

const defaultGetVersion = async () => {
  try {
    const r = await Promise.race([fetchLatestBaileysVersion(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))])
    return r.version
  } catch { return undefined } // fall back to the version baked into the pinned Baileys release
}

export const createConnection = ({
  authStore, intake, log, baileysLogger, events,
  onState, onOpen, onLoggedOut, onDown, shouldStayUp = () => true,
  makeSocket = makeWASocket, getVersion = defaultGetVersion, now = Date.now, random = Math.random, timing = {}
}) => {
  const T = { quietMs: 2000, maxDrainMs: 15_000, pendingFlagTimeoutMs: 60_000, stableMs: 60_000, restrictedRetryMs: 5 * 60_000, ...timing }
  let sock = null
  let intentional = null // why *we* are ending the socket: 'close' | 'restart' | 'unlink' | 'stop'
  let closing = null // in-flight graceful close promise
  let retryTimer = null; let pendingTimer = null; let stableTimer = null
  let attempt = 0
  let badSession = 0
  let pendingDone = false
  let lastEventAt = 0
  let stopped = false
  let state = {
    phase: 'down', linked: authStore.isRegistered(), qr: null, qrExpired: false, me: null,
    attempt: 0, nextRetryAt: null, code: null, detail: authStore.isRegistered() ? 'Disconnected' : 'Not linked', blocked: null, since: now()
  }

  const set = next => {
    const changed = next.phase !== undefined && next.phase !== state.phase
    state = { ...state, ...next, linked: authStore.isRegistered(), since: changed ? now() : state.since }
    onState?.(state, changed)
  }
  const clearTimers = () => { clearTimeout(retryTimer); clearTimeout(pendingTimer); clearTimeout(stableTimer) }
  const emit = e => events?.emit(e)
  const down = (detail, extra = {}) => { set({ phase: 'down', qr: null, detail, nextRetryAt: null, ...extra }); onDown?.(state) }

  const connect = async () => {
    if (stopped || state.blocked) return
    clearTimers()
    intentional = null
    pendingDone = false
    set({ phase: attempt ? 'reconnecting' : 'connecting', qr: null, qrExpired: false, detail: attempt ? `Reconnecting (attempt ${attempt})…` : 'Connecting…' })
    let s
    try {
      const version = await getVersion()
      if (stopped || state.blocked || !shouldStayUp()) return down('Disconnected')
      s = makeSocket({
        auth: { creds: authStore.creds, keys: makeCacheableSignalKeyStore(authStore.keys, baileysLogger) },
        version,
        logger: baileysLogger,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        emitOwnEvents: true,
        getMessage: async () => undefined, // we never send group messages, so no retries of our own sends
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 25_000
      })
    } catch (err) {
      emit({ level: 'error', code: 'wa.client_start_failed', message: `Could not start the WhatsApp client: ${err.message}` })
      return backoff(null, `Could not start the WhatsApp client (${err.message})`)
    }
    sock = s
    s.ev.process(async events => {
      lastEventAt = now()
      if (events['creds.update']) await authStore.saveCreds()
      // connection events from an old socket are ignored; its *messages* are still ingested below
      if (events['connection.update'] && s === sock) await onConnUpdate(events['connection.update'])
      intake.enqueue(events)
    })
  }

  const onConnUpdate = async u => {
    if (u.qr) {
      const svg = await QRCode.toString(u.qr, { type: 'svg', margin: 1, errorCorrectionLevel: 'L' })
      set({ phase: 'qr', qr: svg, qrExpired: false, code: null, detail: 'Scan this code with WhatsApp on the logger phone' })
    }
    if (u.isNewLogin) {
      set({ phase: 'pairing', qr: null, detail: 'Phone linked — finishing setup…' })
      emit({ level: 'info', code: 'wa.linked', message: 'WhatsApp linked' })
    }
    if (u.receivedPendingNotifications === true) {
      pendingDone = true
      if (state.phase === 'syncing') goOnline()
    }
    if (u.connection === 'open') {
      badSession = 0
      const me = sock.user ? { id: sock.user.id, lid: sock.user.lid, name: sock.user.name } : null
      set({ phase: 'syncing', qr: null, me, code: null, nextRetryAt: null, detail: 'Connected — receiving messages queued while offline…' })
      stableTimer = setTimeout(() => { attempt = 0 }, T.stableMs)
      pendingTimer = setTimeout(() => { if (state.phase === 'syncing') goOnline(true) }, T.pendingFlagTimeoutMs)
      if (pendingDone) goOnline()
      onOpen?.(sock)
    }
    if (u.connection === 'close') onClose(u.lastDisconnect)
  }

  const goOnline = (noMarker = false) => {
    clearTimeout(pendingTimer)
    set({ phase: 'online', attempt: 0, detail: noMarker ? 'Online (offline-backlog marker not received within 60 s)' : 'Online' })
  }

  const backoff = (code, detail) => {
    if (!shouldStayUp()) return down('Disconnected', { code })
    attempt++
    const delay = Math.round(Math.min(60_000, 1000 * 2 ** (attempt - 1)) * (0.8 + random() * 0.4))
    set({ phase: 'reconnecting', attempt, code, nextRetryAt: now() + delay, detail: `${detail} — retrying in ${Math.ceil(delay / 1000)} s (attempt ${attempt})` })
    emit({ level: attempt >= 3 ? 'warn' : 'info', code: 'wa.reconnecting', message: `WhatsApp connection lost (${detail}); reconnecting (attempt ${attempt})`, context: { code, attempt }, noise: attempt < 3 })
    retryTimer = setTimeout(connect, delay)
  }

  const block = (reason, detail, code, level = 'error', retryMs = 0) => {
    set({ blocked: { reason, detail }, code })
    down(detail, { code })
    emit({ level, code: `wa.${reason}`, message: detail, context: { code } })
    if (retryMs) retryTimer = setTimeout(() => { set({ blocked: null }); if (shouldStayUp()) connect() }, retryMs)
  }

  const onClose = lastDisconnect => {
    clearTimers()
    const err = lastDisconnect?.error
    const code = err?.output?.statusCode ?? err?.statusCode ?? null
    const message = err?.message || 'connection closed'
    log.info({ code, message, intentional }, 'wa: socket closed')

    if (intentional) {
      const why = intentional
      intentional = null
      if (why === 'restart') return void connect()
      if (why === 'unlink') {
        authStore.wipe()
        onLoggedOut?.('unlinked')
        emit({ level: 'info', code: 'wa.unlinked', message: 'WhatsApp unlinked from the dashboard' })
        return down('Not linked', { me: null })
      }
      return down(why === 'stop' ? 'Stopped' : 'Disconnected', { code })
    }

    switch (code) {
      case DisconnectReason.loggedOut:
        authStore.wipe()
        onLoggedOut?.('logged_out')
        emit({ level: 'error', code: 'wa.logged_out', message: 'WhatsApp logged this device out (removed from the phone or expired). Link it again.' })
        return down('Not linked', { me: null, code })
      case DisconnectReason.connectionReplaced:
        return block('replaced', 'Another session using this account replaced this one. Make sure only one logger runs, then restart the connection.', code)
      case DisconnectReason.restartRequired:
        // expected right after pairing (and occasionally later): restart cleanly, nothing to show
        emit({ level: 'info', code: 'wa.restart_required', message: 'WhatsApp requested a connection restart (expected after linking)', noise: true })
        return void connect()
      case DisconnectReason.forbidden:
      case DisconnectReason.unavailableService:
        return block('restricted', `WhatsApp refused the connection (${code}). The account may be restricted; retrying every 5 minutes.`, code, 'error', T.restrictedRetryMs)
      case DisconnectReason.badSession:
        if (++badSession >= MAX_BAD_SESSION) return block('bad_session', `The session failed ${badSession} times in a row. Unlink and link WhatsApp again.`, code)
        return backoff(code, 'Bad session')
      default:
        if (!authStore.isRegistered()) {
          if (code === DisconnectReason.timedOut || /QR refs/i.test(message)) {
            emit({ level: 'warn', code: 'wa.qr_expired', message: 'The QR code expired before it was scanned. Generate a new one to link.' })
            return down('QR expired', { qrExpired: true, code })
          }
          return shouldStayUp() ? void connect() : down('Not linked', { code })
        }
        if (shouldStayUp()) emit({ level: 'warn', code: 'wa.disconnected', message: `WhatsApp connection dropped (${message}${code ? `, ${code}` : ''})`, context: { code }, noise: true })
        return backoff(code, message)
    }
  }

  /** Graceful close: let Baileys finish in-flight sync/handlers, then end the socket. Idempotent. */
  const close = (reason = 'close') => {
    if (closing) return closing
    clearTimers()
    if (!sock || state.phase === 'down') { if (state.phase !== 'down') down('Disconnected'); return Promise.resolve() }
    const s = sock
    const opened = ['syncing', 'online'].includes(state.phase)
    set({ phase: 'closing', detail: 'Stopping capture safely…' })
    closing = (async () => {
      const t0 = now()
      while (opened && now() - t0 < T.maxDrainMs && (!pendingDone || now() - lastEventAt < T.quietMs)) await sleep(Math.min(250, T.quietMs))
      intentional = reason
      await s.end(undefined)
      if (state.phase === 'closing') down('Disconnected') // end() on an already-dead socket emits nothing
    })().finally(() => { closing = null })
    return closing
  }

  const usable = () => Boolean(sock) && !closing && ['syncing', 'online'].includes(state.phase)
  const waitUsable = async (ms = 30_000) => {
    const t0 = now()
    while (!usable() && now() - t0 < ms) {
      if (state.blocked || (state.phase === 'down' && !retryTimer)) break
      await sleep(200)
    }
    return usable()
  }

  return {
    state: () => state,
    socket: () => sock,
    usable,
    waitUsable,
    open: () => { if (!stopped && !state.blocked && state.phase === 'down') return connect() },
    close,
    /** Clears a blocked state and reconnects (if the capture manager wants the socket up). */
    restart: async () => {
      set({ blocked: null })
      attempt = 0; badSession = 0
      if (sock && !['down', 'closing'].includes(state.phase)) { await close('restart'); return }
      if (shouldStayUp()) await connect()
    },
    stop: async () => { stopped = true; clearTimers(); await close('stop') },
    /** Unlink on WhatsApp's side (needs a usable socket), then wipe local credentials. */
    unlink: async () => {
      clearTimers()
      if (usable()) {
        intentional = 'unlink'
        try { await sock.logout('Unlinked from dashboard'); return { remote: true } } catch (err) {
          log.warn({ err: err.message }, 'wa: logout request failed; wiping locally')
        }
      }
      intentional = null
      if (sock && state.phase !== 'down') await close('close')
      authStore.wipe()
      onLoggedOut?.('unlinked')
      emit({ level: 'warn', code: 'wa.unlinked_locally', message: 'Local WhatsApp credentials removed. If the device still shows under Linked devices on the phone, remove it there.' })
      down('Not linked', { me: null })
      return { remote: false }
    },
    operatorBlocked: detail => { set({ blocked: { reason: 'operator', detail } }); down(detail) },
    clearOperatorBlock: () => set({ blocked: null }),
    sendText: async (jid, text) => {
      if (!usable() || state.phase !== 'online') throw new Error('WhatsApp is not connected')
      return sock.sendMessage(jid, { text })
    },
    fetchGroups: async () => {
      if (!usable()) throw Object.assign(new Error('WhatsApp is not connected'), { status: 409 })
      return sock.groupFetchAllParticipating()
    }
  }
}
