# WA Group Logger

An always-on server that captures every message the linked WhatsApp account receives in the configured groups,
stores it durably (journal → SQLite), and shows it live in a small web dashboard with logical logging sessions.

## ⚠ Risks you accept by running this

- **Unofficial integration.** It uses [Baileys](https://github.com/WhiskeySockets/Baileys) (pinned `7.0.0-rc14`), a
  reverse-engineered WhatsApp Web client. This is against WhatsApp's Terms of Service. The linked number can be
  **restricted or banned** at any time. Use the dedicated spare number only — never a personal one.
- **The logger sends WhatsApp messages only for alerts** (to the admin phones in `config/admins.json`). Ask each admin
  to **save the spare number and message it once first**; unsolicited messages to strangers are a ban signal.
- **No end-to-end zero-loss guarantee.** Baileys acknowledges each message to WhatsApp *before* our code sees it. A
  crash in that window (milliseconds; at most one in-memory batch) loses those messages for good. Messages sent while
  the device is unlinked, or offline longer than WhatsApp keeps them, are never delivered. See *Guarantees* below.

## Guarantees (what is and is not promised)

| Stage | Meaning |
|---|---|
| received | Baileys handed us the event (in memory — the unavoidable loss window) |
| **captured** | appended to the journal **and fsynced** (or committed to SQLite) — survives `kill -9` and power loss |
| committed | applied to `messages.db`; the commit itself is the journal acknowledgement |
| delivered | shown in a browser — a view only; the database is the source of truth |

- At-least-once ingestion with idempotent storage (`UNIQUE(chat_jid, wa_msg_id)`): replays and duplicates are harmless.
- Every observed record gets exactly one disposition; counter identities are checked every 15 s (Settings → Counters).
- Every period not ONLINE is a **capture gap**, closed as `recovered` (WhatsApp delivered a backlog) or `unverified`.
  A gap label never proves completeness — WhatsApp offers no replay cursor.
- Crash harness: `node tools/killtest.js 100` — SIGKILLs a burst at random points; acknowledged records lost must be 0.

## Layout

```
src/ingest/   journal.js (fsync'd framed segments) · intake.js (classify, bounded queue) · committer.js (single writer)
src/wa/       connection.js (state machine, QR, backoff) · authState.js (Baileys keys in SQLite) · groups.js · normalize.js
src/web/      server.js (REST + SSE) · auth.js (email OTP) · queries.js
src/          app.js (wiring) · main.js · sessions.js · gaps.js · fencing.js · alerts.js · backup.js
public/       dashboard (vanilla HTML/CSS/JS)          config/  groups.json · admins.json (git-ignored)
spike/        isolated Phase 0 recorder (own package)   tools/   killtest.js       scripts/  restore · break-glass
data/         messages.db · auth.db · journal/          (keep all three on ONE volume)
```

## Configuration

- `config/groups.json` — `[{ "key", "label", "jid"? }]`. Labels are matched **exactly** (Unicode-normalised) to find
  the stable `@g.us` id; ambiguous/missing matches show an action on the dashboard. Add a group → *Settings → Reload config*.
- `config/admins.json` — `[{ "name", "email", "phone", "alerts" }]`: who may sign in, and who receives alerts.
- Environment (`.env` locally, `/etc/wa-logger/env` on the server, mode 600) — see `.env.example`.
  `SMTP_USER`/`SMTP_PASS`: a Gmail account with 2-Step Verification and an **App Password**. Without it, OTP login and
  email alerts are disabled (use break-glass).

## Run locally

```bash
pnpm install
pnpm test          # 34 tests incl. crash harness, burst, duplicates, fencing, end-to-end web
pnpm start         # http://localhost:3000
```

Sign in: enter an admin email → code arrives by email → 7-day session. Without SMTP, on the server run
`node scripts/break-glass-session.js you@example.com`, then use **I already have a code** on the login page.

**Linking WhatsApp:** the dashboard shows a QR whenever the device is not linked (first run, logged out from the phone,
or after *Unlink*). Scan it from the spare phone: *Settings → Linked devices → Link a device*.

## Deploy (any Ubuntu LTS VPS, ≥ 2 GB RAM)

```bash
sudo apt install -y caddy && curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
sudo npm i -g pnpm
sudo useradd --system --home /opt/wa-logger walogger
sudo mkdir -p /opt/wa-logger /etc/wa-logger && sudo chown walogger: /opt/wa-logger
# copy this folder to /opt/wa-logger (without data/, node_modules/, chrome/), then:
cd /opt/wa-logger && sudo -u walogger pnpm install --prod
sudo install -m 600 -o root .env.example /etc/wa-logger/env   # edit: PUBLIC_ORIGIN=https://<host>, SMTP_*
sudo cp deploy/wa-logger.service /etc/systemd/system/ && sudo systemctl enable --now wa-logger
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the hostname (domain, or <ip-with-dashes>.sslip.io)
sudo systemctl restart caddy
```

Firewall: allow 80/443 (and 22 from your IP only). Node listens on 127.0.0.1:3000 only. Keep the clock synced
(`timedatectl` / chrony) — session boundaries use the server clock. Snapshot the **whole data volume** (provider
snapshots or LVM) — never `messages.db` / `auth.db` separately.

## Backups & restore

- A consistent **set** (both DBs + manifest) is written nightly at 03:30 IST to `backups/`, and on *Settings → Back up now*.
- Restore (service stopped): `node scripts/restore.js backups/set-…` restores **messages.db only** by default; the
  current journal replays newer records. `--include-auth` also rolls back `auth.db`; startup then detects the key
  rollback (fencing) and asks for *Start fresh link* rather than connecting with stale keys.
- After restoring a **full-volume snapshot**, re-link from the dashboard (*Unlink* → scan) — keys may be older than WhatsApp expects.

## Operations

| Dashboard state | Meaning / action |
|---|---|
| Online | capturing |
| Catching up | connected, receiving messages WhatsApp queued while offline |
| Reconnecting | automatic retries with backoff (1 s → 60 s); email alert after 2 min |
| Link required / Not linked | scan the QR (after a logout, or 5 min without a scan click *Show QR*) |
| Replaced | another instance uses the same account — stop it, then *Restart connection* |
| Restricted | WhatsApp refused the account (403/503); retried every 5 min — check the phone |
| Paused | backpressure (disk low, journal backlog, write errors) — WhatsApp keeps queueing; resumes by itself |
| Action required | auth store older than the data (restore) — *Start fresh link* or restore a consistent set |

`systemctl status wa-logger` · `journalctl -u wa-logger -f` · exit code 2 = inconsistent data files (see Restore).

## Phase 0 (live validation)

`cd spike && pnpm install && node record.js --label baseline` links a *separate* device and records every Baileys event to
`spike/data/` (git-ignored, contains real messages — delete after). Fill `spike/FINDINGS.md` per the checklist; facts
already established from the pinned source are listed there.

## Legacy

The previous whatsapp-web.js bot (`index.js`, `chrome/`, `auth-data/`, `.wwebjs_auth/`) is archived with checksums in
`../server-legacy-backup-2026-10-10/` and will be deleted only after this replacement passes validation (cutover).
# Gladiators-Logging-Dashboard
# Gladiators-Logging-Dashboard
