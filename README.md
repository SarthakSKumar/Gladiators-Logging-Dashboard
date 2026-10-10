# WA Group Logger

A server that captures the plain-text messages the linked WhatsApp account receives in the selected groups, stores them
durably (journal → SQLite), and shows them live in the Gladiators dashboard. Capture runs automatically while at least
one group is logging (has an open session) and stops when none is.

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
- Every period capture is not running is a **capture gap**, closed as `recovered` (WhatsApp delivered a backlog) or
  `unverified`. Only gaps that *begin while a session is logging* (a dropped connection, a server crash) are reported as
  interruptions; idle time between sessions is expected. A gap label never proves completeness.
- Only messages **sent during a logging session** of their group are stored (whole-second window from Start to
  Stop). Anything sent before Start, after Stop, or while no group was logging is dropped — including what WhatsApp
  delivers on reconnect from idle time.
- Only plain text is stored (`conversation` / `extendedTextMessage`, after unwrapping ephemeral/view-once). Media (even
  with captions), stickers, documents, audio, contacts, locations, polls, reactions, edits/deletes and system messages
  are ignored by design. Undecryptable messages are reported as operator events, never silently dropped.
- Operator events (`ops_events`): every error/warning that matters is stored with level, code, message and context,
  pushed live (SSE `opevent`), toasted in the dashboard and listed under *Settings → Logs*. Expected noise (e.g. the
  515 restart after pairing) is marked as such and never toasted.
- Crash harness: `node tools/killtest.js 100` — SIGKILLs a burst at random points; acknowledged records lost must be 0.

## Layout

```
src/ingest/   journal.js (fsync'd framed segments) · intake.js (classify, bounded queue) · committer.js (single writer)
src/wa/       connection.js (state machine, QR, backoff) · authState.js (Baileys keys in SQLite) · groups.js · normalize.js
src/web/      server.js (REST + SSE + serves web/dist) · auth.js (email OTP) · queries.js
src/          app.js (wiring) · capture.js (when the socket runs) · events.js (operator events) · main.js
              sessions.js · gaps.js · fencing.js · alerts.js · backup.js
web/          dashboard: Vite + React + TS + shadcn/ui + TanStack Query + sonner (own package, builds to web/dist)
config/       admins.json (git-ignored) · groups.json (legacy, imported once)
spike/        isolated Phase 0 recorder (own package)
tools/        killtest.js · ui-harness.js (dev/QA only: real server code + scripted socket on a data copy)
scripts/      restore · break-glass
data/         messages.db · auth.db · journal/          (keep all three on ONE volume)
```

## Configuration

- **Groups** are chosen in the dashboard (*Settings → Groups*) from the linked account's own group list and tracked by
  their stable `@g.us` id (renames keep working). The selection lives in `messages.db`. `config/groups.json` is only
  imported once on upgrade (legacy rows resolve by exact label on the first refresh).
- `config/admins.json` — `[{ "name", "email", "phone", "alerts" }]`: who may sign in, and who receives alerts.
- Environment (`.env` locally, `/etc/wa-logger/env` on the server, mode 600) — see `.env.example`.
  `SMTP_USER`/`SMTP_PASS`: a Gmail account with 2-Step Verification and an **App Password** — put them in `.env` only,
  never in `.env.example`. **OTP delivery:** with SMTP set, codes are emailed. Without SMTP and with `NODE_ENV` not
  `production`, codes are printed to the server console (`[dev] Sign-in code for …`). In production without SMTP,
  sign-in needs the break-glass script.

## Run locally

```bash
pnpm install
pnpm build:web     # installs web/ deps and builds the dashboard into web/dist
pnpm test          # server tests: crash harness, burst, duplicates, capture state machine, races, text filter, e2e
pnpm start         # server + built dashboard on http://localhost:3000
```

Dashboard development with hot reload: run `pnpm dev` (server on :3000) and `pnpm dev:web` (Vite on
http://localhost:5173, proxies `/api` to :3000).

Sign in: admin email → code (email, or the server console in dev) → 7-day session. Break-glass:
`node scripts/break-glass-session.js you@example.com`, then **I already have a code** on the login page.

**Linking WhatsApp:** after sign-in, an unlinked account always lands on the Link page (QR, expiry with *Generate new
code*, pairing progress). Scan from the spare phone: *Settings → Linked devices → Link a device*.

**QA without a phone:** `node tools/ui-harness.js data 3100` runs the real server code on a *copy* of `data/` with a
scripted socket (`unlinked` as a third argument starts on the Link page). The copy contains your keys and messages in
the OS temp folder — delete it afterwards.

## Deploy (any Ubuntu LTS VPS, ≥ 2 GB RAM)

```bash
sudo apt install -y caddy && curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
sudo npm i -g pnpm
sudo useradd --system --home /opt/wa-logger walogger
sudo mkdir -p /opt/wa-logger /etc/wa-logger && sudo chown walogger: /opt/wa-logger
# copy this folder to /opt/wa-logger (without data/, node_modules/, chrome/), then:
cd /opt/wa-logger && sudo -u walogger pnpm install --prod && sudo -u walogger pnpm build:web
sudo install -m 600 -o root .env.example /etc/wa-logger/env   # edit: PUBLIC_ORIGIN=https://<host>, SMTP_*
sudo cp deploy/wa-logger.service /etc/systemd/system/ && sudo systemctl enable --now wa-logger
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the hostname (domain, or <ip-with-dashes>.sslip.io)
sudo systemctl restart caddy
```

Firewall: allow 80/443 (and 22 from your IP only). Node listens on 127.0.0.1:3000 only. Keep the clock synced
(`timedatectl` / chrony) — session boundaries use the server clock. Snapshot the **whole data volume** (provider
snapshots or LVM) — never `messages.db` / `auth.db` separately.

## Google Sheets forwarding (Gladiators groups)

A separate, custom integration (`src/integrations/sheets.js`, config in git-ignored `config/sheets.json`, see
`config/sheets.example.json`). Every message logged in a configured group is POSTed to that group's Apps Script
endpoint in the same format the Android app used:

```json
{ "id": 1, "sender": "Ravi", "message": "5 w 100", "groupName": "Gladiators Indian Racing 🏇", "timestamp": 1790000110000, "raceNumber": "3" }
```

- `raceNumber` is the session's race number and selects the sheet `RACE <n>` — it is required when starting logging
  in these groups. `id` is 1, 2, 3… per session in arrival order; the script writes it to row `id + 2`, so a retry
  rewrites the same row (no duplicates). `timestamp` is when the message was sent; `sender` is the WhatsApp name.
- `groupName` is the exact string the Apps Script routes on (not the WhatsApp subject, which differs by an emoji
  modifier). Both groups currently use the same deployment URL; the script picks the spreadsheet from `groupName`.
- Delivery is durable (outbox table `sheet_outbox`): retried with backoff, resumed after restarts, failures shown in
  *Settings → Logs → Google Sheets* (with *Retry failed*) and as toasts. Messages logged before the integration was
  enabled are not back-filled.

### The Apps Script (`appscript/Code.gs`)

Deploy this file as the web app that the endpoint URL points to (*Deploy → Manage deployments → Edit → New
version* keeps the same `/exec` URL). It reads each bet with **deterministic rules first** (`2w200`, `3p1kw5k`,
`4 ew 100`, `9 each way 3k`, `10w100 10plc100`, …) and only asks Cloudflare Workers AI for messages the rules cannot
read. Rows it cannot read keep Horse/Win/Place **empty**, get a red message cell with a note, and the reply carries
`"parsed": false`, which the dashboard shows as *Sent · not read*. Several bets in one message are never guessed.

- AI fallback is optional: set script properties `CF_API_TOKEN` and `CF_ACCOUNT_ID` (never put the token in the
  code). Run `checkSetup()` and `runSelfTest()` from the Apps Script editor after deploying.
- Tested: `test/appscript.test.js` runs the real file in a sandbox with a mocked Google environment, including
  the AI reply shapes, hallucination checks and formula-injection protection.

## API (changed in v2.1)

Added: `POST /api/wa/link` (start linking / regenerate QR), `GET /api/wa/groups`, `POST /api/wa/groups/refresh`,
`GET /api/groups`, `POST /api/groups {jid}`, `DELETE /api/groups/:id`, `GET /api/kpis`, `GET /api/events`,
`GET /api/health` (public liveness), `GET /api/integrations/sheets`, `POST /api/integrations/sheets/retry`,
SSE events `opevent` and `ping`. `POST /api/sessions` and
`POST /api/sessions/:id/stop` are idempotent. Removed: `/api/wa/resume`, `/api/wa/show-qr`, `/api/groups/recheck`,
`/api/groups/:key/pick`, `/api/config/reload`, `/api/backup`.

## Backups & restore

- A consistent **set** (both DBs + manifest) is written nightly at 03:30 IST to `backups/` (automatic; there is no button).
- Restore (service stopped): `node scripts/restore.js backups/set-…` restores **messages.db only** by default; the
  current journal replays newer records. `--include-auth` also rolls back `auth.db`; startup then detects the key
  rollback (fencing) and asks for *Start fresh link* rather than connecting with stale keys.
- After restoring a **full-volume snapshot**, re-link from the dashboard (*Unlink* → scan) — keys may be older than WhatsApp expects.

## Operations

| Capture badge | Meaning / action |
|---|---|
| Capturing | a group is logging and the socket is online |
| Starting | a group is logging; connecting / receiving the offline backlog / reconnecting (backoff 1 s → 60 s) |
| Idle | linked, no group is logging — the socket is closed; WhatsApp queues messages until capture restarts |
| Linking / Not linked | the Link page is shown; QR expiry needs *Generate new code* |
| Error | replaced (another instance — stop it, then *Restart connection*), restricted (403/503, retried every 5 min), paused to protect data (disk low / journal backlog / write errors — resumes by itself), auth rollback (*Start fresh link*), or reconnect failing after 3+ attempts (email alert after 2 min) |

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
