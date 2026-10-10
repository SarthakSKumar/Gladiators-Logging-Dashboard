// Read-side queries for the dashboard. The browser is a view: everything comes from messages.db.
import { sessionWindow } from '../sessions.js'

const ROW_COLUMNS = `v.seq, v.sno, v.group_id, v.chat_jid, v.wa_msg_id, v.wa_timestamp, v.received_at, v.sender_jid, v.sender_pn,
  v.push_name, v.msg_type, v.body, v.source, v.skew_flag, v.quoted_body, v.from_me,
  (SELECT e.new_body FROM message_events e WHERE e.chat_jid = v.chat_jid AND e.target_wa_msg_id = v.wa_msg_id
     AND e.event_type IN ('edit','content_resolved') ORDER BY e.event_ts DESC, e.seq DESC LIMIT 1) AS latest_body,
  EXISTS (SELECT 1 FROM message_events e WHERE e.chat_jid = v.chat_jid AND e.target_wa_msg_id = v.wa_msg_id AND e.event_type = 'edit') AS edited,
  EXISTS (SELECT 1 FROM message_events e WHERE e.chat_jid = v.chat_jid AND e.target_wa_msg_id = v.wa_msg_id AND e.event_type = 'revoke') AS deleted,
  c.push_name AS contact_name, t.label AS member_tag`

const JOINS = `LEFT JOIN contacts c ON c.jid = v.sender_jid
  LEFT JOIN member_tags t ON t.group_jid = v.chat_jid AND t.participant = v.sender_jid`

/**
 * Page of a group's messages (whole group, or one session's window), newest first.
 * S. No. = position in send order (wa_timestamp, seq) within the view.
 */
export const listMessages = (db, { groupId, session, beforeSno, limit = 200 }) => {
  const w = session ? sessionWindow(session) : { sql: 'm.group_id = ?', params: [groupId] }
  const total = db.prepare(`SELECT count(*) FROM messages m WHERE ${w.sql}`).pluck().get(...w.params)
  const rows = db.prepare(`WITH v AS (
      SELECT m.*, ROW_NUMBER() OVER (ORDER BY m.wa_timestamp, m.seq) AS sno FROM messages m WHERE ${w.sql})
    SELECT ${ROW_COLUMNS} FROM v ${JOINS}
    WHERE (? IS NULL OR v.sno < ?) ORDER BY v.sno DESC LIMIT ?`).all(...w.params, beforeSno ?? null, beforeSno ?? null, Math.min(limit, 500))
  return { total, rows }
}

/** New messages after a stream cursor (all groups), for SSE. */
export const messagesAfter = (db, seq, limit = 500) => db.prepare(`WITH v AS (SELECT m.*, NULL AS sno FROM messages m WHERE m.seq > ? ORDER BY m.seq LIMIT ?)
  SELECT ${ROW_COLUMNS} FROM v ${JOINS} ORDER BY v.seq`).all(seq, limit)

export const eventsAfter = (db, seq, limit = 500) =>
  db.prepare('SELECT seq, group_id, chat_jid, target_wa_msg_id, event_type, new_body, event_ts FROM message_events WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit)

export const maxSeqs = db => ({
  msg: db.prepare('SELECT coalesce(max(seq), 0) FROM messages').pluck().get(),
  evt: db.prepare('SELECT coalesce(max(seq), 0) FROM message_events').pluck().get()
})

export const messageHistory = (db, seq) => {
  const m = db.prepare('SELECT seq, chat_jid, wa_msg_id, wa_timestamp, received_at, sender_jid, sender_pn, push_name, msg_type, body, source FROM messages WHERE seq = ?').get(seq)
  if (!m) return null
  const events = db.prepare('SELECT event_type, new_body, actor_jid, event_ts, received_at FROM message_events WHERE chat_jid = ? AND target_wa_msg_id = ? ORDER BY event_ts, seq')
    .all(m.chat_jid, m.wa_msg_id)
  return { message: m, events }
}

export const latestPerGroup = db => db.prepare(`SELECT m.group_id, m.wa_timestamp, m.received_at, m.msg_type, substr(m.body, 1, 120) AS body,
    coalesce(t.label, m.push_name, c.push_name, m.sender_pn, m.sender_jid) AS sender
  FROM messages m JOIN (SELECT group_id, max(seq) AS seq FROM messages GROUP BY group_id) x ON x.seq = m.seq
  LEFT JOIN contacts c ON c.jid = m.sender_jid
  LEFT JOIN member_tags t ON t.group_jid = m.chat_jid AND t.participant = m.sender_jid`).all()
