// Dashboard login: email → one-time code by email → 7-day session (fixed, not sliding).
// Only emails listed in config/admins.json may sign in. Unrelated to WhatsApp linking.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

const OTP_TTL_MS = 10 * 60_000
const OTP_MAX_ATTEMPTS = 5
const httpError = (status, message) => Object.assign(new Error(message), { status })
const sha256 = s => createHash('sha256').update(s).digest('hex')
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const createWebAuth = ({ db, loadAdmins, mailer, secret, sessionTtlMs, log, devOtpToConsole = false, now = Date.now }) => {
  const hits = new Map()
  /** sliding-window limiter: at most `max` events per `windowMs` for `key` */
  const allow = (key, max, windowMs) => {
    const t = now()
    const arr = (hits.get(key) || []).filter(x => x > t - windowMs)
    if (arr.length >= max) { hits.set(key, arr); return false }
    arr.push(t)
    hits.set(key, arr)
    return true
  }
  const hmac = (email, code) => createHmac('sha256', secret).update(`${email}|${code}`).digest()
  const audit = (email, event, ip, detail = null) =>
    db.prepare('INSERT INTO auth_events (ts, email, event, ip, detail) VALUES (?, ?, ?, ?, ?)').run(now(), email, event, ip, detail)

  const requestOtp = async (rawEmail, ip) => {
    const email = String(rawEmail || '').trim().toLowerCase()
    if (!EMAIL_RE.test(email)) throw httpError(400, 'Enter a valid email address')
    if (!allow(`ip:${ip}`, 20, 3600_000) || !allow('global', 60, 3600_000)) throw httpError(429, 'Too many requests. Try again later.')
    const admin = loadAdmins().find(a => a.email === email)
    if (!admin) { audit(email, 'otp_denied', ip); throw httpError(403, 'This email is not authorised to sign in.') }
    if (!allow(`email-min:${email}`, 1, 60_000)) throw httpError(429, 'A code was just sent. Wait a minute before requesting another.')
    if (!allow(`email-hour:${email}`, 5, 3600_000)) throw httpError(429, 'Too many codes requested for this email. Try again in an hour.')
    if (!mailer.configured && !devOtpToConsole) throw httpError(503, 'Email sending is not configured on the server (SMTP_USER / SMTP_PASS).')
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    db.prepare(`INSERT INTO otps (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`)
      .run(email, hmac(email, code).toString('hex'), now() + OTP_TTL_MS, now())
    if (!mailer.configured) {
      // development only (no SMTP, NODE_ENV != production): print the code instead of emailing it
      console.log(`[dev] Sign-in code for ${email}: ${code}  (valid 10 minutes)`)
      audit(email, 'otp_console', ip)
      return
    }
    try {
      await mailer.send({
        to: email,
        subject: `WA Logger sign-in code: ${code}`,
        text: `Hi ${admin.name || ''},\n\nYour sign-in code is ${code}\nIt expires in 10 minutes and works once.\n\nIf you did not request this, ignore this email.`
      })
    } catch (err) {
      db.prepare('DELETE FROM otps WHERE email = ?').run(email)
      log.error({ err: err.message }, 'auth: OTP email failed')
      throw httpError(502, 'Could not send the email. Try again in a moment.')
    }
    audit(email, 'otp_sent', ip)
  }

  const verifyOtp = (rawEmail, rawCode, ip, ua) => {
    const email = String(rawEmail || '').trim().toLowerCase()
    const code = String(rawCode || '').replace(/\D/g, '')
    if (!allow(`verify-ip:${ip}`, 30, 3600_000)) throw httpError(429, 'Too many attempts. Try again later.')
    const row = db.prepare('SELECT * FROM otps WHERE email = ?').get(email)
    if (!row || row.expires_at < now()) throw httpError(400, 'Code expired or not requested. Request a new code.')
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      db.prepare('DELETE FROM otps WHERE email = ?').run(email)
      throw httpError(429, 'Too many wrong attempts. Request a new code.')
    }
    const ok = code.length === 6 && timingSafeEqual(hmac(email, code), Buffer.from(row.code_hash, 'hex'))
    if (!ok) {
      db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE email = ?').run(email)
      audit(email, 'otp_failed', ip)
      const left = OTP_MAX_ATTEMPTS - row.attempts - 1
      throw httpError(400, left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Incorrect code. Request a new code.')
    }
    db.prepare('DELETE FROM otps WHERE email = ?').run(email)
    const token = randomBytes(32).toString('base64url')
    const expires = now() + sessionTtlMs
    db.prepare('INSERT INTO web_sessions (token_hash, email, created_at, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), email, now(), expires, ip, String(ua || '').slice(0, 200))
    audit(email, 'login', ip)
    return { token, expires }
  }

  const parseCookie = header => Object.fromEntries(String(header || '').split(';').map(p => p.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]))

  /** → { email, name } or null */
  const sessionOf = req => {
    const token = parseCookie(req.headers.cookie).sid
    if (!token) return null
    const row = db.prepare('SELECT email, expires_at FROM web_sessions WHERE token_hash = ?').get(sha256(token))
    if (!row || row.expires_at <= now()) return null
    const admin = loadAdmins().find(a => a.email === row.email)
    if (!admin) return null // removed from config → access revoked immediately
    return { email: row.email, name: admin.name, expiresAt: row.expires_at, token }
  }

  return {
    requestOtp,
    verifyOtp,
    sessionOf,
    logout: token => db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(sha256(token)),
    purgeExpired: () => {
      db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(now())
      db.prepare('DELETE FROM otps WHERE expires_at <= ?').run(now())
    },
    cookie: (token, maxAgeMs, secure) =>
      `sid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`
  }
}
