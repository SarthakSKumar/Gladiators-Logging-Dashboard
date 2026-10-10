// Wires every component together. main.js adds the process-level concerns (lock file, signals).
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdirSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import pino from 'pino'
import { isPnUser } from 'baileys'
import { loadAdmins } from './config.js'
import { getMeta, openDb, setMeta } from './db/index.js'
import { EpochMismatchError, Journal } from './ingest/journal.js'
import { createCounters } from './ingest/counters.js'
import { createIntake } from './ingest/intake.js'
import { createCommitter } from './ingest/committer.js'
import { createAuthStore } from './wa/authState.js'
import { createGroups } from './wa/groups.js'
import { createConnection } from './wa/connection.js'
import { createCapture } from './capture.js'
import { createSessions } from './sessions.js'
import { createGaps } from './gaps.js'
import { checkAuthRollback, recordHighWater, resolveAuthRollbackByRelink, resolveEpoch } from './fencing.js'
import { createMailer } from './mailer.js'
import { createAlerts } from './alerts.js'
import { classifyBaileysLog, createOpsEvents } from './events.js'
import { runBackup } from './backup.js'
import { createWebAuth } from './web/auth.js'
import { createWebServer } from './web/server.js'

const OUTAGE_ALERT_GRACE_MS = 2 * 60_000
const httpError = (status, message) => Object.assign(new Error(message), { status })

export const maskJid = jid => {
  const d = String(jid || '').split(/[@:]/)[0]
  return d.length > 6 ? `+${d.slice(0, 2)} ${d.slice(2, 4)}••••${d.slice(-4)}` : d
}

export const startApp = async ({ config, log, makeSocket, getVersion, mailer: mailerOverride, listen = true, connectionTiming }) => {
  const timers = []
  let closed = false
  const every = (ms, fn) => timers.push(setInterval(() => { try { fn() } catch (err) { log.error({ err: err.stack }, 'periodic task failed') } }, ms))
  const bus = new EventEmitter()
  bus.setMaxListeners(100)

  mkdirSync(join(config.dataDir, 'journal'), { recursive: true })
  const msgDb = openDb(join(config.dataDir, 'messages.db'), 'messages')
  const authDb = openDb(join(config.dataDir, 'auth.db'), 'auth')

  if (!getMeta(msgDb, 'app_secret')) setMeta(msgDb, 'app_secret', randomBytes(32).toString('hex'))
  const ep = resolveEpoch({ msgDb, authDb })
  if (!ep.ok) throw Object.assign(new Error(`${ep.reason}: ${ep.detail}`), { fatal: true })

  const journal = new Journal({ dir: join(config.dataDir, 'journal'), epoch: ep.epoch, maxSegmentBytes: config.journal.maxSegmentBytes, reserveBytes: config.journal.reserveBytes, log })
  try { journal.open() } catch (err) {
    if (err instanceof EpochMismatchError) throw Object.assign(new Error(`journal: ${err.message}`), { fatal: true })
    throw err
  }

  const ops = createOpsEvents({ db: msgDb, bus, log })
  const counters = createCounters()
  counters.c.torn_tail_bytes = journal.stats.tornTailBytes
  counters.c.quarantined_ranges = journal.stats.quarantinedRanges
  if (journal.stats.tornTailBytes) ops.emit({ level: 'info', code: 'journal.torn_tail', message: `Recovered from an interrupted write (${journal.stats.tornTailBytes} unacknowledged bytes set aside)`, noise: true })
  if (journal.stats.quarantinedRanges) ops.emit({ level: 'error', code: 'journal.corruption', message: `Journal corruption found and quarantined (${journal.stats.quarantinedRanges} range(s)); valid records were kept`, context: journal.stats })

  const authStore = createAuthStore(authDb, { log })
  const rollback = checkAuthRollback({ msgDb, authStore, journal })
  if (rollback.ok && ep.authEpochMissing) setMeta(authDb, 'data_epoch', ep.epoch)

  const mailer = mailerOverride ?? createMailer({ smtp: config.smtp, log })
  const groups = createGroups({ db: msgDb, log, configDir: config.configDir })
  groups.importLegacyConfig()

  // ---- status fan-out (debounced) ----
  let statusTimer = null
  let getStatus = null
  const pushStatus = () => {
    if (statusTimer || closed) return
    statusTimer = setTimeout(() => { statusTimer = null; if (!closed) { bus.emit('status', getStatus()); onCaptureMaybeChanged() } }, 150)
  }

  let connection = null
  let capture = null
  const alerts = createAlerts({
    loadAdmins, mailer, tz: config.displayTz, log,
    whatsapp: { isOnline: () => connection?.state().phase === 'online' && connection.usable(), send: (jid, text) => connection.sendText(jid, text) }
  })

  const gaps = createGaps({
    db: msgDb, log,
    onClosed: g => {
      pushStatus()
      if (g.status === 'unverified' && !['idle', 'not_linked', 'linking'].includes(g.cause)) {
        const detail = `Capture was not running from ${new Date(g.started_at).toISOString()} to ${new Date(g.ended_at).toISOString()} (${g.cause}) while a group was logging. WhatsApp gives no way to prove nothing was missed.`
        ops.emit({ level: 'warn', code: 'capture.gap_unverified', message: 'A capture gap could not be verified', context: { gapId: g.id, cause: g.cause, from: g.started_at, to: g.ended_at } })
        alerts.notify({ title: 'Capture gap could not be verified', channels: ['email', 'whatsapp'], detail })
      }
    }
  })

  const committer = createCommitter({
    db: msgDb, journal, groups, counters, log,
    onCommitted: () => bus.emit('committed'),
    onHealth: (ok, err) => {
      if (ok) {
        alerts.clear('commit')
        ops.emit({ level: 'info', code: 'db.recovered', message: 'Database writes recovered; journaled messages applied' })
      } else {
        alerts.raise('commit', { title: 'Database writes failing', channels: ['email', 'whatsapp'], detail: `Messages are safe in the journal and will be applied when the database recovers. Error: ${err?.code || err?.message}` })
        ops.emit({ level: 'error', code: 'db.commit_failed', message: `Database writes failing (${err?.code || err?.message}). Messages are safe in the journal and will be applied automatically.` })
      }
      pushStatus()
    }
  })
  counters.c.replay_backlog_at_start = committer.pendingApply()
  counters.c.pending_scope_open_at_start = committer.pendingScopeOpen()
  if (committer.appliedThrough() < journal.firstRetainedJseq() - 1) {
    const lastSeen = msgDb.prepare('SELECT max(received_at) FROM messages').pluck().get() || Date.now()
    gaps.recordRestoreGap(lastSeen, `messages.db is behind the retained journal (applied ${committer.appliedThrough()}, journal starts at ${journal.firstRetainedJseq()})`)
  }

  const contactUpsert = msgDb.prepare(`INSERT INTO contacts (jid, push_name, pn_jid, updated_at) VALUES (@jid, @push_name, @pn_jid, @t)
    ON CONFLICT(jid) DO UPDATE SET push_name = coalesce(excluded.push_name, contacts.push_name), pn_jid = coalesce(excluded.pn_jid, contacts.pn_jid), updated_at = excluded.updated_at`)
  const meIds = () => { const me = connection?.state().me; return [me?.id, me?.lid, me?.id?.replace(/:\d+@/, '@'), me?.lid?.replace(/:\d+@/, '@')].filter(Boolean) }

  // refresh the account's group list on an open socket (single-flight)
  let groupRefresh = null
  const refreshGroupsOnOpenSocket = () => {
    groupRefresh ??= groups.refreshAccount(() => connection.fetchGroups())
      .then(n => { committer.promotePending({ allResolved: groups.allResolved(), ttlMs: config.pendingScopeTtlMs }); pushStatus(); return n })
      .finally(() => { groupRefresh = null })
    return groupRefresh
  }

  const onMetadata = (name, data) => {
    const t = Date.now()
    if (name === 'contacts.upsert' || name === 'contacts.update') {
      for (const ct of data) if (ct.id) contactUpsert.run({ jid: ct.id, push_name: ct.notify || ct.name || null, pn_jid: ct.phoneNumber || (isPnUser(ct.id) ? ct.id : null), t })
    } else if (name === 'lid-mapping.update') {
      if (data?.lid) contactUpsert.run({ jid: data.lid, push_name: null, pn_jid: data.pn || null, t })
    } else if (name === 'groups.update') {
      groups.onGroupsUpdate(data); pushStatus()
    } else if (name === 'groups.upsert') {
      if (connection.usable()) refreshGroupsOnOpenSocket().catch(() => {})
    } else if (name === 'group-participants.update') {
      if (groups.onParticipantsUpdate(data, meIds())) {
        const g = groups.targetOf(data.id)
        ops.emit({ level: 'error', code: 'group.removed_from', message: `The linked number was removed from "${g?.label || data.id}". Messages there can no longer be captured.`, context: { jid: data.id } })
      }
      pushStatus()
    } else if (name === 'group.member-tag.update') {
      msgDb.prepare(`INSERT INTO member_tags (group_jid, participant, label, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(group_jid, participant) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`).run(data.groupId, data.participant, data.label || null, t)
    }
  }

  const intake = createIntake({
    journal, groups, counters, limits: config.limits, log,
    onDurable: () => committer.tick(),
    onPressure: (on, reason, detail) => capture?.setPressure(reason, on, detail),
    onMetadata,
    onUndecryptable: rec => {
      const g = groups.targetOf(rec.chat_jid)
      ops.emit({
        level: 'warn', code: 'ingest.undecryptable',
        message: `A message in "${g?.label || rec.chat_jid}" could not be decrypted${rec.reason ? ` (${rec.reason})` : ''}. WhatsApp may resend it; if it arrives it is logged normally.`,
        context: { group: g?.label, jid: rec.chat_jid, id: rec.wa_msg_id, sender: rec.sender_pn || rec.sender_jid, push_name: rec.push_name }
      })
    }
  })

  // Baileys reports some failures only through its logger: classify those into operator events.
  const baileysLogger = pino({
    level: config.logLevel === 'debug' ? 'debug' : 'warn',
    base: { mod: 'baileys' },
    hooks: {
      logMethod (args, method, level) {
        try { if (!closed) classifyBaileysLog(level, args, { emit: ops.emit, groupOf: jid => groups.targetOf(jid) }) } catch { /* never break logging */ }
        return method.apply(this, args)
      }
    }
  })

  const loggingCount = () => msgDb.prepare(`SELECT count(*) FROM sessions s JOIN groups g ON g.id = s.group_id
    WHERE s.ended_at IS NULL AND g.enabled = 1 AND g.jid IS NOT NULL`).pluck().get()

  // ---- connection + capture manager ----
  let wasLinked = authStore.isRegistered()
  connection = createConnection({
    authStore, intake, log, baileysLogger, makeSocket, getVersion, events: ops, timing: connectionTiming,
    shouldStayUp: () => capture.desiredUp(),
    onOpen: () => refreshGroupsOnOpenSocket().catch(err => log.warn({ err: err.message }, 'groups: refresh on open failed')),
    onLoggedOut: cause => {
      gaps.open(cause)
      if (cause === 'logged_out') alerts.raise('needs_link', { title: 'WhatsApp was logged out', detail: 'The logger device was removed or expired. Sign in to the dashboard and link it again.' })
    },
    onDown: s => {
      if (!s.linked) capture.linkSettled() // QR expired / link failed: wait for "Regenerate"
      capture.reconcile()
    },
    onState: (s, changed) => {
      if (closed) return
      if (changed) msgDb.prepare('INSERT INTO connection_log (ts, state, code, detail) VALUES (?, ?, ?, ?)').run(Date.now(), s.phase.toUpperCase(), s.code ?? null, s.detail ?? null)
      if (s.linked && !wasLinked) {
        // just linked: keep the socket up while WhatsApp finishes the initial sync and we read the group list
        capture.linkSettled()
        capture.lease('post-link-sync', 120_000)
        alerts.clear('needs_link')
      }
      wasLinked = s.linked
      capture?.observe()
      pushStatus()
    }
  })
  capture = createCapture({ connection, loggingCount, events: ops, log, onChange: pushStatus })

  // gap + alert bookkeeping follows the *capture* state (gaps are recorded whenever capture is off)
  let lastCapture = null
  let outageTimer = null
  const onCaptureMaybeChanged = () => {
    const cs = capture.captureState()
    if (cs.state === lastCapture) return
    lastCapture = cs.state
    if (cs.state === 'capturing') {
      gaps.close()
      clearTimeout(outageTimer); outageTimer = null
      for (const k of ['not_online', 'capture_error']) alerts.clear(k)
    } else {
      gaps.open({ idle: 'idle', not_linked: 'not_linked', linking: 'linking', starting: 'connecting', error: cs.reason || 'error' }[cs.state] || cs.state)
      if (cs.logging > 0 && !outageTimer && ['starting', 'error'].includes(cs.state)) {
        outageTimer = setTimeout(() => {
          outageTimer = null
          const now = capture.captureState()
          if (now.logging > 0 && now.state !== 'capturing') alerts.raise(now.state === 'error' ? 'capture_error' : 'not_online', { title: 'WhatsApp capture is not running while a group is logging', detail: now.detail })
        }, OUTAGE_ALERT_GRACE_MS)
      }
    }
  }

  const sessions = createSessions({ db: msgDb, onChange: () => { capture.reconcile(); pushStatus() } })

  // ---- status / diagnostics ----
  const diskFree = () => {
    try { const s = statfsSync(config.dataDir); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize } } catch { return null }
  }
  const health = () => {
    const pending_apply = committer.pendingApply()
    const pending_scope_open = committer.pendingScopeOpen()
    return {
      pendingApply: pending_apply,
      pendingScopeOpen: pending_scope_open,
      intakeDepth: intake.depth(),
      inflight: counters.c.inflight,
      committerDegraded: committer.degraded(),
      pressure: capture.pressureReasons(),
      invariants: counters.check({ pending_apply, pending_scope_open }),
      latency: counters.latencyStats(),
      disk: diskFree()
    }
  }
  const textCount = msgDb.prepare("SELECT count(*) FROM messages WHERE group_id = ? AND msg_type = 'text'").pluck()
  getStatus = () => {
    const s = connection.state()
    const active = Object.fromEntries(sessions.active().map(x => [x.group_id, sessions.stats(x)]))
    const cs = capture.captureState()
    const h = health()
    return {
      serverTime: Date.now(),
      tz: config.displayTz,
      linked: s.linked,
      me: s.linked && s.me ? { name: s.me.name || null, number: maskJid(s.me.id) } : null,
      capture: { ...cs, qr: cs.state === 'linking' ? s.qr : null, qrExpired: Boolean(s.qrExpired) },
      groups: groups.list().map(g => ({
        id: g.id, jid: g.jid, label: g.subject_current || g.label, status: g.status, action: g.action,
        lastMessageAt: g.last_message_at, session: active[g.id] || null, count: textCount.get(g.id)
      })),
      gapOpen: gaps.current() || null,
      health: { pendingApply: h.pendingApply, committerDegraded: h.committerDegraded, pressure: h.pressure, invariantsOk: h.invariants.ok }
    }
  }

  const dayStartIst = () => {
    const t = Date.now() + 5.5 * 3600_000
    return t - (t % 86_400_000) - 5.5 * 3600_000
  }
  const getKpis = () => {
    const q = (sql, ...p) => msgDb.prepare(sql).pluck().get(...p)
    const sel = "group_id IN (SELECT id FROM groups WHERE enabled = 1)"
    const today = dayStartIst()
    return {
      messagesAllTime: q(`SELECT count(*) FROM messages WHERE msg_type = 'text' AND ${sel}`),
      messagesToday: q(`SELECT count(*) FROM messages WHERE msg_type = 'text' AND ${sel} AND wa_timestamp >= ?`, today),
      lastMessageAt: q(`SELECT max(received_at) FROM messages WHERE msg_type = 'text' AND ${sel}`) || null,
      groupsConfigured: q('SELECT count(*) FROM groups WHERE enabled = 1'),
      groupsLogging: loggingCount(),
      sessionsToday: q(`SELECT count(*) FROM sessions WHERE started_at >= ? AND ${sel}`, today),
      ingestionFailuresToday: ops.countSince('ingest.', today, 'error') + ops.countSince('ingest.', today, 'warn'),
      gapsToday: q("SELECT count(*) FROM capture_gaps WHERE started_at >= ? AND cause NOT IN ('idle','not_linked','linking')", today),
      dayStart: today
    }
  }

  const getDiagnostics = () => ({
    counters: counters.c,
    health: health(),
    journal: { durableJseq: journal.durableJseq, appliedThrough: committer.appliedThrough(), firstRetainedJseq: journal.firstRetainedJseq(), segments: journal.segments.length, bytes: journal.sizeBytes(), maxAuthMark: journal.maxAuthMark, stats: journal.stats },
    auth: { writeCounter: authStore.writeCounter(), keyTypes: authStore.keyTypes(), registered: authStore.isRegistered() },
    alerts: { active: alerts.list(), ...alerts.stats() },
    mailerConfigured: mailer.configured,
    connectionLog: msgDb.prepare('SELECT * FROM connection_log ORDER BY id DESC LIMIT 200').all(),
    gaps: gaps.list(),
    process: { uptimeS: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version, pid: process.pid }
  })

  const backup = () => runBackup({ msgDb, authDb, journal, dir: config.backupDir, log })

  // ---- group selection actions ----
  const requireLinked = () => { if (!connection.state().linked) throw httpError(409, 'Link WhatsApp first') }
  const refreshAccountGroups = async () => {
    requireLinked()
    const release = capture.lease('groups-refresh', 90_000)
    try {
      if (!(await connection.waitUsable(60_000))) throw httpError(503, `Could not reach WhatsApp to refresh groups (${connection.state().detail})`)
      await refreshGroupsOnOpenSocket()
      return { groups: groups.accountGroups(), fetchedAt: groups.accountFetchedAt() }
    } finally { release() }
  }

  const auth = createWebAuth({ db: msgDb, loadAdmins, mailer, secret: getMeta(msgDb, 'app_secret'), sessionTtlMs: config.sessionTtlMs, log, devOtpToConsole: config.devOtpToConsole })
  const web = createWebServer({
    config, db: msgDb, auth, bus, log, getStatus, getDiagnostics, getKpis, ops,
    actions: {
      sessions: {
        ...sessions,
        start: args => {
          requireLinked()
          const g = groups.get(args.groupId)
          if (!g?.enabled) throw httpError(404, 'Unknown group')
          if (!g.jid || g.status !== 'resolved') throw httpError(409, g.action || 'This group is not available in the linked account')
          const s = sessions.start(args)
          ops.emit({ level: 'info', code: 'session.started', message: `Logging started for "${g.subject_current || g.label}"`, context: { group: g.id, session: s.id }, noise: true })
          return s
        },
        stop: args => {
          const s = sessions.stop(args)
          ops.emit({ level: 'info', code: 'session.stopped', message: 'Logging stopped', context: { session: s.id }, noise: true })
          return s
        }
      },
      accountGroups: () => ({ groups: groups.accountGroups(), fetchedAt: groups.accountFetchedAt() }),
      refreshAccountGroups,
      addGroup: jid => { const g = groups.add(jid); committer.promotePending({ allResolved: groups.allResolved(), ttlMs: config.pendingScopeTtlMs }); pushStatus(); return g },
      removeGroup: (id, by) => {
        const active = sessions.active().find(s => s.group_id === id)
        if (active) sessions.stop({ id: active.id, by, reason: 'group_removed' })
        const g = groups.remove(id)
        capture.reconcile(); pushStatus()
        return g
      },
      link: async () => {
        if (connection.state().blocked?.reason === 'operator') throw httpError(409, connection.state().blocked.detail)
        await capture.requestLink()
        return getStatus().capture
      },
      restart: async () => { await connection.restart(); await capture.reconcile(); return getStatus().capture },
      unlink: async by => {
        log.warn({ by }, 'wa: unlink requested from dashboard')
        // unlinking on WhatsApp's side needs a connection: hold one briefly if capture is idle
        const release = connection.state().linked ? capture.lease('unlink', 60_000) : () => {}
        try {
          await connection.waitUsable(20_000)
          for (const s of sessions.active()) sessions.stop({ id: s.id, by, reason: 'unlinked' })
          return await connection.unlink()
        } finally { release(); capture.reconcile() }
      },
      operatorRelink: by => {
        if (connection.state().blocked?.reason !== 'operator') throw httpError(409, 'No operator action pending')
        log.warn({ by }, 'fencing: operator chose fresh link')
        resolveAuthRollbackByRelink({ msgDb, authDb, authStore, journal, epoch: ep.epoch })
        gaps.open('auth_rollback')
        connection.clearOperatorBlock()
        return capture.requestLink()
      }
    }
  })

  // ---- boot sequence ----
  committer.tick() // replay anything journaled but not yet applied (crash recovery)
  gaps.onStartup()
  if (listen) await web.listen()
  if (!rollback.ok) {
    connection.operatorBlocked(`${rollback.detail} Choose "Start fresh link" (wipes keys, needs a QR scan) or restore a consistent backup set.`)
    ops.emit({ level: 'error', code: 'auth.rollback', message: rollback.detail })
    alerts.raise('needs_link', { title: 'Authentication store rollback detected', detail: rollback.detail })
  }
  await capture.start()
  log.info({ port: config.port, host: config.host, epoch: ep.epoch, replay: counters.c.replay_backlog_at_start }, 'app: started')

  // ---- periodic tasks ----
  let invariantsOk = true
  every(10_000, () => {
    gaps.beat()
    if (authStore.writeCounter() >= Number(getMeta(msgDb, 'auth_counter_hwm') || 0) && connection.state().blocked?.reason !== 'operator') recordHighWater({ msgDb, authStore, journal })
  })
  every(15_000, () => {
    const d = diskFree()
    const floor = d ? Math.max(config.limits.diskMinFreeBytes, d.total * config.limits.diskMinFreeRatio) : 0
    if (d) capture.setPressure('disk_low', d.free < floor, { free: d.free })
    if (d && d.free > floor * 1.2) journal.ensureReserve()
    capture.setPressure('journal_backlog', committer.pendingApply() > config.limits.unappliedHighWater)
    const h = health()
    if (h.invariants.ok !== invariantsOk) {
      invariantsOk = h.invariants.ok
      if (!invariantsOk) {
        ops.emit({ level: 'error', code: 'ingest.invariant', message: 'Ingestion counters do not reconcile — a message may have been lost in processing', context: h.invariants })
        alerts.raise('invariant', { title: 'Ingestion counters do not reconcile', channels: ['email', 'whatsapp'], detail: JSON.stringify(h.invariants) })
      } else alerts.clear('invariant')
    }
    pushStatus()
  })
  every(60_000, () => {
    committer.promotePending({ allResolved: groups.allResolved(), ttlMs: config.pendingScopeTtlMs })
    auth.purgeExpired()
  })
  every(3600_000, () => journal.prune(committer.appliedThrough(), config.journal.retainDays * 86400_000))
  let lastBackupDay = null
  every(60_000, () => {
    // nightly backup set at 03:30 IST (internal; no longer exposed as a button)
    const ist = new Date(Date.now() + 5.5 * 3600_000)
    const day = ist.toISOString().slice(0, 10)
    if (ist.getUTCHours() === 3 && ist.getUTCMinutes() >= 30 && lastBackupDay !== day) {
      lastBackupDay = day
      try { backup() } catch (err) {
        ops.emit({ level: 'error', code: 'backup.failed', message: `Nightly backup failed: ${err.message}` })
        alerts.raise('backup', { title: 'Nightly backup failed', detail: err.message, severity: 'warning' })
      }
    }
  })

  const shutdown = async () => {
    timers.forEach(clearInterval)
    clearTimeout(outageTimer)
    await capture.stop()
    await connection.stop()
    closed = true
    clearTimeout(statusTimer)
    let raceTimer
    await Promise.race([intake.idle(), new Promise(r => { raceTimer = setTimeout(r, 5000) })])
    clearTimeout(raceTimer)
    committer.tick()
    committer.stop()
    gaps.beat()
    if (listen) await web.close()
    journal.close()
    msgDb.pragma('wal_checkpoint(TRUNCATE)')
    msgDb.close()
    authDb.close()
  }

  return { config, msgDb, authDb, journal, counters, intake, committer, groups, sessions, gaps, connection, capture, alerts, ops, web, bus, authStore, getStatus, getKpis, getDiagnostics, shutdown, backup }
}
