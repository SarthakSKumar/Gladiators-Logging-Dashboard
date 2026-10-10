// HTTP: built dashboard (web/dist), REST API, SSE stream. Binds to localhost; Caddy terminates HTTPS.
import express from 'express'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { eventsAfter, listMessages, maxSeqs, messageHistory, messagesAfter } from './queries.js'

const DIST = join(import.meta.dirname, '..', '..', 'web', 'dist')

export const createWebServer = (deps) => {
  const { config, db, auth, bus, log, getStatus, getDiagnostics, getKpis, ops, actions } = deps
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback') // req.ip = client address forwarded by Caddy

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    })
    next()
  })
  app.use(express.json({ limit: '16kb' }))

  // State-changing requests: same-origin only (SameSite=Strict cookie + custom header + Origin check)
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (req.method === 'GET') return next()
    const origin = req.headers.origin
    const okOrigin = !origin || origin === config.publicOrigin || origin === `${req.protocol}://${req.headers.host}`
    if (req.headers['x-requested-with'] !== 'fetch' || !okOrigin) return res.status(403).json({ error: 'Cross-site request blocked' })
    next()
  })

  const wrap = fn => async (req, res) => {
    try {
      const out = await fn(req, res)
      if (!res.headersSent) res.json(out ?? { ok: true })
    } catch (err) {
      if (!err.status) log.error({ err: err.stack, path: req.path }, 'http: unhandled error')
      if (!res.headersSent) res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal error' })
    }
  }
  const int = v => (v === undefined || v === '' ? undefined : Number.parseInt(v, 10))
  const notFound = msg => Object.assign(new Error(msg), { status: 404 })

  // ---- auth (public) ----
  app.post('/api/auth/request-otp', wrap(async req => { await auth.requestOtp(req.body?.email, req.ip); return { ok: true } }))
  app.post('/api/auth/verify-otp', wrap((req, res) => {
    const { token } = auth.verifyOtp(req.body?.email, req.body?.code, req.ip, req.headers['user-agent'])
    res.setHeader('Set-Cookie', auth.cookie(token, config.sessionTtlMs, config.cookieSecure))
    return { ok: true }
  }))
  app.post('/api/auth/logout', wrap((req, res) => {
    const s = auth.sessionOf(req)
    if (s) auth.logout(s.token)
    res.setHeader('Set-Cookie', auth.cookie('', 0, config.cookieSecure))
    return { ok: true }
  }))
  app.get('/api/health', (req, res) => res.json({ ok: true, serverTime: Date.now() })) // liveness only, no data

  // ---- everything below requires a session ----
  app.use('/api', (req, res, next) => {
    const s = auth.sessionOf(req)
    if (!s) return res.status(401).json({ error: 'Not signed in' })
    req.admin = s
    next()
  })

  app.get('/api/auth/me', wrap(req => ({ email: req.admin.email, name: req.admin.name, expiresAt: req.admin.expiresAt })))
  app.get('/api/status', wrap(() => getStatus()))
  app.get('/api/kpis', wrap(() => getKpis()))
  app.get('/api/diagnostics', wrap(() => getDiagnostics()))
  app.get('/api/events', wrap(req => ops.list({ limit: int(req.query.limit) ?? 200, beforeId: int(req.query.beforeId), minLevel: req.query.minLevel })))

  // messages (text only) — a group's whole history or one session's window
  app.get('/api/messages', wrap(req => {
    const sessionId = int(req.query.session)
    const session = sessionId ? actions.sessions.get(sessionId) : null
    if (sessionId && !session) throw notFound('Unknown session')
    const groupId = session?.group_id ?? int(req.query.group)
    if (!groupId) throw Object.assign(new Error('group or session is required'), { status: 400 })
    return { ...listMessages(db, { groupId, session, beforeSno: int(req.query.beforeSno), limit: int(req.query.limit) ?? 200 }), cursor: maxSeqs(db) }
  }))
  app.get('/api/messages/:seq/history', wrap(req => messageHistory(db, int(req.params.seq)) ?? Promise.reject(notFound('Not found'))))

  // sessions (= "logging" for a group)
  app.get('/api/sessions', wrap(req => actions.sessions.list({ groupId: int(req.query.group), limit: int(req.query.limit) ?? 100 })))
  app.post('/api/sessions', wrap(req => actions.sessions.start({ groupId: int(req.body?.groupId), label: req.body?.label, raceNumber: req.body?.raceNumber, by: req.admin.email })))
  app.post('/api/sessions/:id/stop', wrap(req => actions.sessions.stop({ id: int(req.params.id), by: req.admin.email })))

  // groups: the linked account's groups, and the selection
  app.get('/api/wa/groups', wrap(() => actions.accountGroups()))
  app.post('/api/wa/groups/refresh', wrap(() => actions.refreshAccountGroups()))
  app.get('/api/groups', wrap(() => getStatus().groups))
  app.post('/api/groups', wrap(req => {
    if (typeof req.body?.jid !== 'string' || !req.body.jid.endsWith('@g.us')) throw Object.assign(new Error('jid must be a group id (…@g.us)'), { status: 400 })
    return actions.addGroup(req.body.jid)
  }))
  app.delete('/api/groups/:id', wrap(req => actions.removeGroup(int(req.params.id), req.admin.email)))

  // WhatsApp link lifecycle
  app.post('/api/wa/link', wrap(() => actions.link()))
  app.post('/api/wa/restart', wrap(() => actions.restart()))
  app.post('/api/wa/unlink', wrap(req => {
    if (req.body?.confirm !== 'UNLINK') throw Object.assign(new Error('Type UNLINK to confirm'), { status: 400 })
    return actions.unlink(req.admin.email)
  }))
  app.post('/api/wa/operator-relink', wrap(req => {
    if (req.body?.confirm !== 'RELINK') throw Object.assign(new Error('Type RELINK to confirm'), { status: 400 })
    return actions.operatorRelink(req.admin.email)
  }))

  // ---- live stream (SSE): status, new messages, operator events, ping ----
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const start = maxSeqs(db)
    const last = int(req.headers['last-event-id']) ?? int(req.query.since)
    const cur = { msg: last ?? start.msg, evt: int(req.query.sinceEvt) ?? start.evt }
    let closed = false
    const send = (event, data, id) => {
      if (closed) return
      if (res.writableLength > config.limits.sseMaxBufferBytes) { closed = true; res.end(); return } // slow client: drop, it resumes by cursor
      res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const pump = () => {
      for (let rows; !closed && (rows = messagesAfter(db, cur.msg)).length;) {
        for (const r of rows) if (r.msg_type === 'text') send('msg', r, r.seq)
        cur.msg = rows.at(-1).seq
      }
      for (let evs; !closed && (evs = eventsAfter(db, cur.evt)).length;) {
        for (const e of evs) send('evt', e)
        cur.evt = evs.at(-1).seq
      }
    }
    const onStatus = s => send('status', s)
    const onOp = e => send('opevent', e)
    bus.on('committed', pump)
    bus.on('status', onStatus)
    bus.on('opevent', onOp)
    send('status', getStatus())
    pump()
    const ping = setInterval(() => send('ping', { t: Date.now() }), 10_000)
    req.on('close', () => { closed = true; clearInterval(ping); bus.off('committed', pump); bus.off('status', onStatus); bus.off('opevent', onOp) })
  })

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))

  // ---- dashboard (built SPA). Hashed assets are immutable; every other path serves index.html ----
  if (existsSync(DIST)) {
    app.use('/assets', express.static(join(DIST, 'assets'), { immutable: true, maxAge: '1y' }))
    app.use(express.static(DIST, { index: false }))
    app.get(/^\/(?!api\/).*/, (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(join(DIST, 'index.html')) })
  } else {
    app.get('/', (req, res) => res.status(503).type('text').send('Dashboard not built. Run: pnpm build:web'))
  }

  const server = createServer(app)
  return {
    app,
    listen: () => new Promise(resolve => server.listen(config.port, config.host, resolve)),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }),
    port: () => server.address()?.port
  }
}
