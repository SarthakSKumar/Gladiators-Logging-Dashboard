// HTTP: static UI, REST API, SSE stream. Binds to localhost; Caddy terminates HTTPS in front.
import express from 'express'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { eventsAfter, latestPerGroup, listMessages, maxSeqs, messageHistory, messagesAfter } from './queries.js'

const PUBLIC = join(import.meta.dirname, '..', '..', 'public')

export const createWebServer = (deps) => {
  const { config, db, auth, bus, log, getStatus, getDiagnostics, actions } = deps
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback') // req.ip = client address forwarded by Caddy

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store'
    })
    next()
  })
  app.use(express.json({ limit: '16kb' }))

  // State-changing requests: same-origin only (SameSite=Strict cookie + custom header + Origin check)
  app.use('/api', (req, res, next) => {
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

  // ---- pages ----
  app.get(['/', '/index.html'], (req, res) => {
    if (!auth.sessionOf(req)) return res.redirect('/login.html')
    res.sendFile(join(PUBLIC, 'index.html'))
  })
  app.get('/login.html', (req, res) => (auth.sessionOf(req) ? res.redirect('/') : res.sendFile(join(PUBLIC, 'login.html'))))
  app.use(express.static(PUBLIC, { index: false }))

  // ---- everything below requires a session ----
  app.use('/api', (req, res, next) => {
    const s = auth.sessionOf(req)
    if (!s) return res.status(401).json({ error: 'Not signed in' })
    req.admin = s
    next()
  })

  app.get('/api/auth/me', wrap(req => ({ email: req.admin.email, name: req.admin.name, expiresAt: req.admin.expiresAt })))
  app.get('/api/status', wrap(() => getStatus()))
  app.get('/api/diagnostics', wrap(() => getDiagnostics()))

  const int = v => (v === undefined || v === '' ? undefined : Number.parseInt(v, 10))
  app.get('/api/messages', wrap(req => {
    const groupId = int(req.query.group)
    const sessionId = int(req.query.session)
    const session = sessionId ? actions.sessions.get(sessionId) : null
    if (sessionId && !session) throw Object.assign(new Error('Unknown session'), { status: 404 })
    return { ...listMessages(db, { groupId: session?.group_id ?? groupId, session, beforeSno: int(req.query.beforeSno), limit: int(req.query.limit) ?? 200 }), cursor: maxSeqs(db) }
  }))
  app.get('/api/messages/:seq/history', wrap(req => messageHistory(db, int(req.params.seq)) ?? Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))))

  app.get('/api/sessions', wrap(req => actions.sessions.list({ groupId: int(req.query.group) })))
  app.post('/api/sessions', wrap(req => actions.sessions.start({ groupId: int(req.body?.groupId), label: req.body?.label, raceNumber: req.body?.raceNumber, by: req.admin.email })))
  app.post('/api/sessions/:id/stop', wrap(req => actions.sessions.stop({ id: int(req.params.id), by: req.admin.email })))

  app.post('/api/groups/recheck', wrap(() => actions.recheckGroups()))
  app.post('/api/groups/:key/pick', wrap(req => actions.pickGroup(req.params.key, req.body?.jid)))
  app.post('/api/config/reload', wrap(() => actions.reloadConfig()))

  app.post('/api/wa/restart', wrap(() => actions.wa('restart')))
  app.post('/api/wa/show-qr', wrap(() => actions.wa('showQr')))
  app.post('/api/wa/resume', wrap(() => actions.wa('resume')))
  app.post('/api/wa/unlink', wrap(req => {
    if (req.body?.confirm !== 'UNLINK') throw Object.assign(new Error('Type UNLINK to confirm'), { status: 400 })
    return actions.wa('unlink', req.admin.email)
  }))
  app.post('/api/wa/operator-relink', wrap(req => {
    if (req.body?.confirm !== 'RELINK') throw Object.assign(new Error('Type RELINK to confirm'), { status: 400 })
    return actions.operatorRelink(req.admin.email)
  }))
  app.post('/api/backup', wrap(() => actions.backup()))

  // ---- live stream (SSE). The DB is the source; each client tails it from its own cursor. ----
  app.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
    const start = maxSeqs(db)
    const last = int(req.headers['last-event-id']) ?? int(req.query.since)
    let cur = { msg: last ?? start.msg, evt: int(req.query.sinceEvt) ?? start.evt }
    let closed = false
    const send = (event, data, id) => {
      if (closed) return
      if (res.writableLength > config.limits.sseMaxBufferBytes) { closed = true; res.end(); return } // slow client: drop, it resumes by cursor
      res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    const pump = () => {
      for (let rows; !closed && (rows = messagesAfter(db, cur.msg)).length;) {
        for (const r of rows) send('msg', r, r.seq)
        cur.msg = rows.at(-1).seq
      }
      for (let evs; !closed && (evs = eventsAfter(db, cur.evt)).length;) {
        for (const e of evs) send('evt', e)
        cur.evt = evs.at(-1).seq
      }
    }
    const onStatus = s => send('status', s)
    bus.on('committed', pump)
    bus.on('status', onStatus)
    send('status', getStatus())
    pump()
    const ping = setInterval(() => !closed && res.write(': ping\n\n'), 15_000)
    req.on('close', () => { closed = true; clearInterval(ping); bus.off('committed', pump); bus.off('status', onStatus) })
  })

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))

  const server = createServer(app)
  return {
    app,
    listen: () => new Promise(resolve => server.listen(config.port, config.host, resolve)),
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }),
    port: () => server.address()?.port,
    latestPerGroup: () => latestPerGroup(db)
  }
}
