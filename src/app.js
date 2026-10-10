// Wires every component together. main.js adds the process-level concerns (lock file, signals).
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdirSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
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
import { createSessions } from './sessions.js'
import { createGaps } from './gaps.js'
import { checkAuthRollback, recordHighWater, resolveAuthRollbackByRelink, resolveEpoch } from './fencing.js'
import { createMailer } from './mailer.js'
import { createAlerts } from './alerts.js'
import { runBackup } from './backup.js'
import { createWebAuth } from './web/auth.js'
import { createWebServer } from './web/server.js'

const OFFLINE_ALERT_GRACE_MS = 2 * 60_000

export const maskJid = jid => {
  const d = String(jid || '').split(/[@:]/)[0]
  return d.length > 6 ? `+${d.slice(0, 2)} ${d.slice(2, 4)}••••${d.slice(-4)}` : d
}

export const startApp = async ({ config, log, makeSocket, getVersion, mailer: mailerOverride, listen = true }) => {
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

  const counters = createCounters()
  counters.c.torn_tail_bytes = journal.stats.tornTailBytes
  counters.c.quarantined_ranges = journal.stats.quarantinedRanges

  const authStore = createAuthStore(authDb, { log })
  const rollback = checkAuthRollback({ msgDb, authStore, journal })
  if (rollback.ok && ep.authEpochMissing) setMeta(authDb, 'data_epoch', ep.epoch)

  const mailer = mailerOverride ?? createMailer({ smtp: config.smtp, log })
  const groups = createGroups({ db: msgDb, log })
  groups.syncConfig()

  // ---- alerts + status fan-out ----
  let connection = null
  const alerts = createAlerts({
    loadAdmins, mailer, tz: config.displayTz, log,
    whatsapp: { isOnline: () => connection?.isOnline(), send: (jid, text) => connection.sendText(jid, text) }
  })
  let statusTimer = null
  const pushStatus = () => {
    if (statusTimer) return
    statusTimer = setTimeout(() => { statusTimer = null; if (!closed) bus.emit('status', getStatus()) }, 250)
  }

  const gaps = createGaps({
    db: msgDb, log,
    onClosed: g => {
      pushStatus()
      if (g.status === 'unverified') {
        alerts.notify({ title: 'Capture gap could not be verified', channels: ['email', 'whatsapp'],
          detail: `Not capturing from ${new Date(g.started_at).toISOString()} to ${new Date(g.ended_at).toISOString()} (${g.cause}). WhatsApp gives no way to prove nothing was missed in this window.` })
      }
    }
  })

  // ---- backpressure: any active reason suspends the socket (WhatsApp keeps queueing for us) ----
  const pressure = new Map()
  const setPressure = (reason, on, detail) => {
    const had = pressure.size > 0
    if (on) pressure.set(reason, detail ?? true); else pressure.delete(reason)
    if (!connection) return
    if (pressure.size && !had) {
      connection.suspend([...pressure.keys()].join(', '))
      alerts.raise('suspended', { title: 'Capture paused to protect data', detail: `Reasons: ${[...pressure.keys()].join(', ')}. The socket is disconnected so WhatsApp keeps queueing messages; capture resumes automatically.` })
    } else if (!pressure.size && had) {
      connection.resume()
      alerts.clear('suspended')
    }
    pushStatus()
  }

  const committer = createCommitter({
    db: msgDb, journal, groups, counters, log,
    onCommitted: () => bus.emit('committed'),
    onHealth: (ok, err) => {
      if (ok) alerts.clear('commit'); else alerts.raise('commit', { title: 'Database writes failing', channels: ['email', 'whatsapp'], detail: `Messages are safe in the journal and will be applied when the database recovers. Error: ${err?.code || err?.message}` })
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

  let preflightRunning = null
  const runPreflight = async (force = false) => {
    if (!connection?.socket() || !['ONLINE', 'SYNCING'].includes(connection.state().state)) throw Object.assign(new Error('WhatsApp is not connected'), { status: 409 })
    preflightRunning ??= groups.preflight(() => connection.fetchGroups(), { force, me: maskJid(connection.state().me?.id) })
      .then(r => { committer.promotePending({ allResolved: groups.allResolved(), ttlMs: config.pendingScopeTtlMs }); pushStatus(); return r })
      .finally(() => { preflightRunning = null })
    return preflightRunning
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
      if (!groups.allResolved()) runPreflight(true).catch(() => {})
    } else if (name === 'group-participants.update') {
      groups.onParticipantsUpdate(data, meIds())
      if (data.action === 'add' && !groups.allResolved()) runPreflight(true).catch(() => {})
      pushStatus()
    } else if (name === 'group.member-tag.update') {
      msgDb.prepare(`INSERT INTO member_tags (group_jid, participant, label, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(group_jid, participant) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`).run(data.groupId, data.participant, data.label || null, t)
    } else if (name === 'messaging-history.status') {
      log.info({ ...data }, 'wa: history sync status')
    }
  }

  const intake = createIntake({
    journal, groups, counters, limits: config.limits, log,
    onDurable: () => committer.tick(),
    onPressure: (on, reason, detail) => setPressure(reason, on, detail),
    onMetadata
  })

  // ---- connection + state-driven alerts/gaps ----
  let offlineTimer = null
  const OUTAGE_NOW = { NEEDS_LINK: 'WhatsApp needs to be linked (scan the QR in the dashboard)', REPLACED: 'Session replaced by another instance', RESTRICTED: 'WhatsApp refused the connection (account may be restricted)', NEEDS_OPERATOR: 'Operator action required', LINK_IDLE: 'WhatsApp is not linked' }
  connection = createConnection({
    authStore, intake, log, makeSocket, getVersion,
    baileysLogger: log.child({ mod: 'baileys' }, { level: config.logLevel === 'debug' ? 'debug' : 'warn' }),
    onOpen: () => runPreflight(true).catch(err => log.warn({ err: err.message }, 'groups: preflight failed')),
    onLoggedOut: cause => gaps.open(cause),
    onState: (s, changed) => {
      if (closed) return
      if (changed) {
        msgDb.prepare('INSERT INTO connection_log (ts, state, code, detail) VALUES (?, ?, ?, ?)').run(Date.now(), s.state, s.code ?? null, s.detail ?? null)
        if (s.state === 'ONLINE') {
          gaps.close()
          clearTimeout(offlineTimer); offlineTimer = null
          for (const k of ['not_online', 'needs_link']) alerts.clear(k)
        } else if (!['SYNCING'].includes(s.state)) {
          gaps.open(s.state === 'SUSPENDED' ? 'suspended' : s.state.toLowerCase())
          if (OUTAGE_NOW[s.state]) alerts.raise('needs_link', { title: OUTAGE_NOW[s.state], detail: s.detail })
          else if (!offlineTimer && s.state !== 'STOPPED') {
            offlineTimer = setTimeout(() => {
              offlineTimer = null
              if (connection.state().state !== 'ONLINE') alerts.raise('not_online', { title: 'WhatsApp capture is offline', detail: connection.state().detail })
            }, OFFLINE_ALERT_GRACE_MS)
          }
        }
      }
      pushStatus()
    }
  })

  const sessions = createSessions({ db: msgDb, onChange: pushStatus })

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
      pressure: [...pressure.keys()],
      invariants: counters.check({ pending_apply, pending_scope_open }),
      latency: counters.latencyStats(),
      disk: diskFree()
    }
  }
  let web = null
  const getStatus = () => {
    const s = connection.state()
    const latest = Object.fromEntries((web?.latestPerGroup() || []).map(r => [r.group_id, r]))
    const active = Object.fromEntries(sessions.active().map(x => [x.group_id, sessions.stats(x)]))
    return {
      serverTime: Date.now(),
      tz: config.displayTz,
      connection: { state: s.state, detail: s.detail, since: s.since, attempt: s.attempt, nextRetryAt: s.nextRetryAt, code: s.code, qr: s.qr, me: s.me ? { number: maskJid(s.me.id), name: s.me.name } : null },
      groups: groups.list().map(g => ({
        id: g.id, key: g.config_key, label: g.label, jid: g.jid, subject: g.subject_current, status: g.status, action: g.action,
        candidates: g.candidates_json ? JSON.parse(g.candidates_json) : null, lastMessageAt: g.last_message_at,
        latest: latest[g.id] || null, session: active[g.id] || null,
        count: msgDb.prepare('SELECT count(*) FROM messages WHERE group_id = ?').pluck().get(g.id)
      })),
      gapOpen: gaps.current() || null,
      alerts: alerts.list(),
      health: health()
    }
  }
  const getDiagnostics = () => ({
    counters: counters.c,
    health: health(),
    journal: { durableJseq: journal.durableJseq, appliedThrough: committer.appliedThrough(), firstRetainedJseq: journal.firstRetainedJseq(), segments: journal.segments.length, bytes: journal.sizeBytes(), maxAuthMark: journal.maxAuthMark, stats: journal.stats },
    auth: { writeCounter: authStore.writeCounter(), keyTypes: authStore.keyTypes(), registered: authStore.isRegistered() },
    alerts: { active: alerts.list(), ...alerts.stats() },
    mailerConfigured: mailer.configured,
    connectionLog: msgDb.prepare('SELECT * FROM connection_log ORDER BY id DESC LIMIT 100').all(),
    gaps: gaps.list(),
    process: { uptimeS: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576), node: process.version, pid: process.pid },
    db: { pageCount: msgDb.pragma('page_count', { simple: true }), pageSize: msgDb.pragma('page_size', { simple: true }) }
  })

  const backup = () => runBackup({ msgDb, authDb, journal, dir: config.backupDir, log })

  const auth = createWebAuth({ db: msgDb, loadAdmins, mailer, secret: getMeta(msgDb, 'app_secret'), sessionTtlMs: config.sessionTtlMs, log })
  web = createWebServer({
    config, db: msgDb, auth, bus, log, getStatus, getDiagnostics,
    actions: {
      sessions,
      recheckGroups: () => runPreflight(true),
      pickGroup: (key, jid) => { groups.pick(key, jid); committer.promotePending({ allResolved: groups.allResolved(), ttlMs: config.pendingScopeTtlMs }); pushStatus() },
      reloadConfig: () => { groups.syncConfig(); pushStatus(); return runPreflight(true).catch(() => ({ preflight: 'deferred until connected' })) },
      wa: async (op, by) => {
        if (op === 'unlink') { log.warn({ by }, 'wa: unlink requested from dashboard'); await connection.unlink() } else connection[op]()
        return { state: connection.state().state }
      },
      operatorRelink: by => {
        if (connection.state().state !== 'NEEDS_OPERATOR') throw Object.assign(new Error('No operator action pending'), { status: 409 })
        log.warn({ by }, 'fencing: operator chose fresh link')
        resolveAuthRollbackByRelink({ msgDb, authDb, authStore, journal, epoch: ep.epoch })
        gaps.open('auth_rollback')
        connection.start()
        return { ok: true }
      },
      backup: () => backup().manifest
    }
  })

  // ---- boot sequence ----
  committer.tick() // replay anything journaled but not yet applied (crash recovery)
  gaps.onStartup()
  if (listen) await web.listen()
  if (rollback.ok) connection.start()
  else {
    connection.operatorBlocked(`${rollback.detail} Choose "Start fresh link" (wipes keys, needs a QR scan) or restore a consistent backup set.`)
    alerts.raise('needs_link', { title: 'Authentication store rollback detected', detail: rollback.detail })
  }
  log.info({ port: config.port, host: config.host, epoch: ep.epoch, replay: counters.c.replay_backlog_at_start }, 'app: started')

  // ---- periodic tasks ----
  every(10_000, () => {
    gaps.beat()
    if (authStore.writeCounter() >= Number(getMeta(msgDb, 'auth_counter_hwm') || 0) && connection.state().state !== 'NEEDS_OPERATOR') recordHighWater({ msgDb, authStore, journal })
  })
  every(15_000, () => {
    const d = diskFree()
    if (d) setPressure('disk_low', d.free < Math.max(config.limits.diskMinFreeBytes, d.total * config.limits.diskMinFreeRatio))
    if (d && d.free > Math.max(config.limits.diskMinFreeBytes, d.total * config.limits.diskMinFreeRatio) * 1.2) journal.ensureReserve()
    setPressure('journal_backlog', committer.pendingApply() > config.limits.unappliedHighWater)
    const h = health()
    if (!h.invariants.ok) alerts.raise('invariant', { title: 'Ingestion counters do not reconcile', channels: ['email', 'whatsapp'], detail: JSON.stringify(h.invariants) })
    else alerts.clear('invariant')
    pushStatus()
  })
  every(60_000, () => {
    committer.promotePending({ allResolved: groups.allResolved(), ttlMs: config.pendingScopeTtlMs })
    auth.purgeExpired()
  })
  every(3600_000, () => journal.prune(committer.appliedThrough(), config.journal.retainDays * 86400_000))
  let lastBackupDay = null
  every(60_000, () => {
    const ist = new Date(Date.now() + 5.5 * 3600_000) // 03:30 IST daily
    const day = ist.toISOString().slice(0, 10)
    if (ist.getUTCHours() === 3 && ist.getUTCMinutes() >= 30 && lastBackupDay !== day) {
      lastBackupDay = day
      try { backup() } catch (err) { alerts.raise('backup', { title: 'Nightly backup failed', detail: err.message, severity: 'warning' }) }
    }
  })

  const shutdown = async () => {
    timers.forEach(clearInterval)
    clearTimeout(offlineTimer)
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

  return { config, msgDb, authDb, journal, counters, intake, committer, groups, sessions, gaps, connection, alerts, web, bus, authStore, getStatus, getDiagnostics, shutdown, backup }
}
