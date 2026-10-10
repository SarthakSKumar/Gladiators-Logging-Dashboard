// Process entry: single-instance lock, start, graceful shutdown.
// Exit code 2 = data-consistency problem needing an operator (systemd does not restart-loop on it).
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.js'
import { log } from './log.js'
import { startApp } from './app.js'

mkdirSync(config.dataDir, { recursive: true })
const lockFile = join(config.dataDir, 'instance.lock')
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
try {
  writeFileSync(lockFile, String(process.pid), { flag: 'wx' })
} catch {
  const other = Number(readFileSync(lockFile, 'utf8'))
  if (other && other !== process.pid && alive(other)) {
    log.fatal({ other }, 'another logger instance is running with this data directory (two instances would fight over the WhatsApp session)')
    process.exit(2)
  }
  writeFileSync(lockFile, String(process.pid)) // stale lock from a crash
}

let app
try {
  app = await startApp({ config, log })
} catch (err) {
  log.fatal({ err: err.message }, err.fatal ? 'startup refused: data files are inconsistent — see README "Restore"' : 'startup failed')
  try { unlinkSync(lockFile) } catch { /* ignore */ }
  process.exit(err.fatal ? 2 : 1)
}

let stopping = false
const stop = async signal => {
  if (stopping) return
  stopping = true
  log.info({ signal }, 'shutting down')
  try { await app.shutdown() } catch (err) { log.error({ err: err.message }, 'shutdown error') }
  try { unlinkSync(lockFile) } catch { /* ignore */ }
  process.exit(0)
}
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('unhandledRejection', err => log.error({ err: err?.stack || String(err) }, 'unhandled rejection'))
