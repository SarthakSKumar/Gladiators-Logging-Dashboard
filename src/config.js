// All runtime configuration. Secrets come from the environment (systemd EnvironmentFile or
// `node --env-file`); group/admin lists come from JSON files so they can change without code edits.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const env = process.env

const num = (v, d) => (v === undefined || v === '' ? d : Number(v))

export const config = {
  root: ROOT,
  dataDir: resolve(ROOT, env.DATA_DIR || 'data'),
  backupDir: resolve(ROOT, env.BACKUP_DIR || 'backups'),
  configDir: resolve(ROOT, env.CONFIG_DIR || 'config'),
  host: env.HOST || '127.0.0.1',
  port: num(env.PORT, 3000),
  publicOrigin: (env.PUBLIC_ORIGIN || `http://localhost:${num(env.PORT, 3000)}`).replace(/\/$/, ''),
  displayTz: env.DISPLAY_TZ || 'Asia/Kolkata',
  logLevel: env.LOG_LEVEL || 'info',
  smtp: {
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port: num(env.SMTP_PORT, 465),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.SMTP_USER || ''
  },
  journal: {
    retainDays: num(env.JOURNAL_RETAIN_DAYS, 14),
    maxSegmentBytes: num(env.JOURNAL_SEGMENT_BYTES, 64 * 1024 * 1024),
    reserveBytes: num(env.JOURNAL_RESERVE_BYTES, 32 * 1024 * 1024)
  },
  limits: {
    // §4 of the plan: every queue we own is bounded; crossing a high-water mark suspends the socket
    intakeMaxBatches: 4,
    intakeMaxRecords: 20000,
    chunkSize: 500,
    chunkRetryMs: 5000,
    unappliedHighWater: num(env.UNAPPLIED_HIGH_WATER, 200000),
    diskMinFreeBytes: num(env.DISK_MIN_FREE_BYTES, 2 * 1024 ** 3),
    diskMinFreeRatio: 0.10,
    sseMaxBufferBytes: 1024 * 1024
  },
  sessionTtlMs: 7 * 24 * 3600 * 1000,
  pendingScopeTtlMs: 24 * 3600 * 1000
}
config.cookieSecure = env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : config.publicOrigin.startsWith('https://')
// Without SMTP, outside production, OTP codes are printed to the server console instead of emailed.
config.devOtpToConsole = !(config.smtp.user && config.smtp.pass) && env.NODE_ENV !== 'production'

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(join(config.configDir, file), 'utf8')) } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback
    throw new Error(`config/${file}: ${err.message}`)
  }
}

/** [{ name, email, phone, alerts }] — login allow-list and alert recipients */
export const loadAdmins = () => readJson('admins.json', []).map(a => ({
  name: a.name,
  email: String(a.email || '').trim().toLowerCase(),
  phone: String(a.phone || '').replace(/[^\d]/g, ''),
  alerts: a.alerts !== false
}))
