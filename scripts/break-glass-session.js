// Break-glass sign-in when email (SMTP) is unavailable. Run ON THE SERVER (SSH):
//   node --env-file-if-exists=.env scripts/break-glass-session.js you@example.com
// Prints a one-time 6-digit code (10 min) for an admin listed in config/admins.json; enter it on the
// normal login page after typing that email. The code is never emailed or logged.
import { createHmac, randomInt } from 'node:crypto'
import { join } from 'node:path'
import { config, loadAdmins } from '../src/config.js'
import { getMeta, openDb } from '../src/db/index.js'

const email = String(process.argv[2] || '').trim().toLowerCase()
if (!loadAdmins().some(a => a.email === email)) {
  console.error(`"${email}" is not in config/admins.json`)
  process.exit(1)
}
const db = openDb(join(config.dataDir, 'messages.db'), 'messages')
const secret = getMeta(db, 'app_secret')
if (!secret) { console.error('Start the app once first (no app secret yet).'); process.exit(1) }
const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
db.prepare(`INSERT INTO otps (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)
  ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`)
  .run(email, createHmac('sha256', secret).update(`${email}|${code}`).digest('hex'), Date.now() + 10 * 60_000, Date.now())
db.prepare('INSERT INTO auth_events (ts, email, event, ip, detail) VALUES (?, ?, ?, ?, ?)').run(Date.now(), email, 'break_glass_code', 'local', null)
db.close()
console.log(`One-time code for ${email}: ${code}  (valid 10 minutes, single use)`)
console.log('On the login page: type the email, click "I already have a code", and enter this code.')
