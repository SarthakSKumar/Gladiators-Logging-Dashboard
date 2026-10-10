// Shapes returned by the Node server (src/app.js, src/web/server.js). Keep in sync with the API.

export type CaptureStateName = "not_linked" | "linking" | "idle" | "starting" | "capturing" | "error"

export interface CaptureState {
  state: CaptureStateName
  phase: "down" | "connecting" | "qr" | "pairing" | "syncing" | "online" | "reconnecting" | "closing"
  logging: number
  detail: string | null
  since: number
  attempt: number
  nextRetryAt: number | null
  code: number | null
  reason?: string
  qr: string | null
  qrExpired: boolean
}

export interface Gap {
  id: number
  started_at: number
  ended_at: number | null
  cause: string
  status: "open" | "recovered" | "unverified"
  recovered_messages: number
  note?: string | null
}

export interface Session {
  id: number
  group_id: number
  label: string
  race_number: number | null
  started_at: number
  ended_at: number | null
  started_by: string | null
  ended_by: string | null
  ended_reason: string | null
  message_count: number
  late_arrivals: number
  gaps: Gap[]
}

export interface SelectedGroup {
  id: number
  jid: string | null
  label: string
  status: "resolved" | "unresolved" | "ambiguous" | "missing" | "inaccessible"
  action: string | null
  lastMessageAt: number | null
  session: Session | null
  count: number
  /** custom integration: messages of this group are forwarded to Google Sheets */
  sheets: { groupName: string } | null
}

export interface Status {
  serverTime: number
  tz: string
  linked: boolean
  me: { name: string | null; number: string } | null
  capture: CaptureState
  groups: SelectedGroup[]
  gapOpen: Gap | null
  health: { pendingApply: number; committerDegraded: boolean; pressure: string[]; invariantsOk: boolean }
}

export interface Me {
  email: string
  name: string | null
  expiresAt: number
}

export interface Kpis {
  messagesAllTime: number
  messagesToday: number
  lastMessageAt: number | null
  groupsConfigured: number
  groupsLogging: number
  sessionsToday: number
  ingestionFailuresToday: number
  gapsToday: number
  dayStart: number
}

export interface MessageRow {
  seq: number
  sno: number | null
  group_id: number
  chat_jid: string
  wa_msg_id: string
  wa_timestamp: number
  received_at: number
  sender_jid: string | null
  sender_pn: string | null
  push_name: string | null
  body: string | null
  quoted_body: string | null
  from_me: number
  source: "live" | "offline" | "history" | "resend"
  skew_flag: number
  contact_name: string | null
  member_tag: string | null
  sheet_status: "pending" | "sent" | "failed" | "skipped" | null
  sheet_row: number | null
  sheet_error: string | null
}

export interface SheetsTarget {
  key: string
  groupJid: string
  groupName: string
  endpoint: string
  pending: number
  sent: number
  failed: number
  skipped: number
  lastSentAt: number | null
  lastError: string | null
}
export interface SheetsStatus {
  enabled: boolean
  targets: SheetsTarget[]
  failures: { id: number; target: string; session_id: number; row_id: number; attempts: number; last_error: string; created_at: number; body: string; wa_timestamp: number }[]
}

export interface SheetCall {
  id: number
  ts: number
  outbox_id: number
  target: string
  session_id: number
  row_id: number
  attempt: number
  request: { id: number; sender: string; message: string; groupName: string; timestamp: number; raceNumber: string | null }
  http_status: number | null
  redirected: number
  host: string | null
  duration_ms: number | null
  result: "sent" | "rejected" | "config_error" | "network_error"
  error: string | null
  response: string | null
  message: string
  sender: string
  race: string | null
  group: string
}

export interface MessagesPage {
  total: number
  rows: MessageRow[]
}

export interface AccountGroup {
  jid: string
  subject: string | null
  size: number | null
  creation: number | null
  updated_at: number
  group_id: number | null
  selected: boolean
}

export interface OpEvent {
  id: number
  ts: number
  last_ts: number
  level: "info" | "warn" | "error"
  code: string
  message: string
  context: Record<string, unknown> | null
  noise: boolean
  count: number
}

export interface Diagnostics {
  counters: Record<string, number>
  health: {
    pendingApply: number
    pendingScopeOpen: number
    intakeDepth: { batches: number; records: number; peakRecords: number }
    inflight: number
    committerDegraded: boolean
    pressure: string[]
    invariants: { ok: boolean; i1: boolean; i2: boolean; i3: boolean }
    latency: { n: number; p50: number; p99: number; max: number }
    disk: { free: number; total: number } | null
  }
  journal: { durableJseq: number; appliedThrough: number; firstRetainedJseq: number; segments: number; bytes: number }
  auth: { writeCounter: number; registered: boolean; keyTypes: { type: string; n: number }[] }
  mailerConfigured: boolean
  connectionLog: { id: number; ts: number; state: string; code: number | null; detail: string | null }[]
  gaps: Gap[]
  process: { uptimeS: number; rssMb: number; node: string; pid: number }
}
