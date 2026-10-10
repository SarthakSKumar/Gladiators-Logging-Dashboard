// Pure: Baileys WAMessage → { kind: 'message' | 'event' | 'excluded_type', ... }.
// Rule: anything not on the explicit exclusion list is stored (unknown types as their raw type name,
// parse failures as 'unparsed' with raw JSON) — nothing in scope is silently dropped.
import { getContentType, isPnUser, normalizeMessageContent, proto, toNumber } from 'baileys'

export const PARSE_VERSION = 1

const StubType = proto.WebMessageInfo.StubType
const STUB_NAME = Object.fromEntries(Object.entries(StubType).map(([k, v]) => [v, k]))
const PT = proto.Message.ProtocolMessage.Type

const TYPE_NAMES = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video_note',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  locationMessage: 'location',
  liveLocationMessage: 'live_location',
  contactMessage: 'contact',
  contactsArrayMessage: 'contacts',
  pollCreationMessage: 'poll',
  pollCreationMessageV2: 'poll',
  pollCreationMessageV3: 'poll',
  pollCreationMessageV5: 'poll',
  eventMessage: 'event',
  groupInviteMessage: 'group_invite'
}

// Not participant-authored content: reactions, poll votes, pins, receipts-like protocol traffic.
// Counted as `excluded_type` (intentional), never journaled.
const EXCLUDED = new Set([
  'reactionMessage', 'encReactionMessage', 'pollUpdateMessage', 'keepInChatMessage',
  'pinInChatMessage', 'encEventResponseMessage', 'senderKeyDistributionMessage'
])
const OVERHEAD_KEYS = new Set(['senderKeyDistributionMessage', 'messageContextInfo'])

const isLong = v => v && typeof v === 'object' && typeof v.low === 'number' && typeof v.high === 'number'

/** JSON with all binary removed (media keys, thumbnails) and protobuf Longs as numbers. */
export const stripRaw = obj => JSON.stringify(obj, (k, v) => {
  if (v instanceof Uint8Array) return { _bin: v.length }
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) return { _bin: v.data.length }
  if (isLong(v)) return toNumber(v)
  return v
})

const tsMs = v => {
  const n = toNumber(v)
  return n > 0 ? n * 1000 : null
}

export const textOf = (content, type) => {
  if (!content || !type) return null
  const m = content[type]
  if (type === 'conversation') return m || null
  if (!m || typeof m !== 'object') return null
  if (type === 'extendedTextMessage') return m.text ?? null
  if (type === 'documentMessage') return [m.fileName || m.title, m.caption].filter(Boolean).join(' — ') || null
  if (m.caption) return m.caption
  if (type.startsWith('pollCreationMessage')) return [m.name, ...(m.options || []).map(o => `• ${o.optionName}`)].join('\n')
  if (type === 'locationMessage' || type === 'liveLocationMessage') {
    return [m.name, m.address, m.degreesLatitude != null ? `${m.degreesLatitude},${m.degreesLongitude}` : null].filter(Boolean).join(' — ') || null
  }
  if (type === 'contactMessage') return m.displayName ?? null
  if (type === 'contactsArrayMessage') return (m.contacts || []).map(c => c.displayName).join(', ') || null
  if (type === 'eventMessage') return m.name ?? null
  if (type === 'groupInviteMessage') return m.groupName ?? null
  return m.text || m.title || null
}

const quotedOf = (content, type) => {
  const ctx = content?.[type]?.contextInfo
  if (!ctx?.stanzaId) return { quoted_wa_msg_id: null, quoted_body: null }
  const q = normalizeMessageContent(ctx.quotedMessage)
  return { quoted_wa_msg_id: ctx.stanzaId, quoted_body: q ? textOf(q, getContentType(q)) : null }
}

/**
 * @param {object} msg WAMessage
 * @param {'live'|'offline'|'history'|'resend'} source
 */
export const normalize = (msg, source) => {
  const key = msg.key || {}
  const chat_jid = key.remoteJid
  const wa_msg_id = key.id
  if (!chat_jid || !wa_msg_id) throw new Error('message without remoteJid/id')

  const ids = [key.participant, key.participantAlt].filter(Boolean)
  const base = {
    chat_jid,
    wa_msg_id,
    from_me: key.fromMe ? 1 : 0,
    sender_jid: key.participant || (key.fromMe ? 'me' : null),
    sender_pn: ids.find(j => isPnUser(j)) || null,
    push_name: msg.pushName || null,
    wa_timestamp: tsMs(msg.messageTimestamp),
    source,
    quoted_wa_msg_id: null,
    quoted_body: null,
    parse_version: PARSE_VERSION
  }

  try {
    const stub = msg.messageStubType
    if (stub === StubType.CIPHERTEXT) {
      return { kind: 'message', ...base, msg_type: 'undecryptable', body: null, raw: stripRaw({ key, messageStubParameters: msg.messageStubParameters }) }
    }
    const content = normalizeMessageContent(msg.message)
    if (!content) {
      if (stub === StubType.REVOKE) return { kind: 'message', ...base, msg_type: 'deleted', body: null, raw: stripRaw(msg) }
      if (stub) {
        const params = (msg.messageStubParameters || []).join(', ')
        return { kind: 'message', ...base, msg_type: 'system', body: `${STUB_NAME[stub] || stub}${params ? `: ${params}` : ''}`, raw: stripRaw(msg) }
      }
      return { kind: 'message', ...base, msg_type: 'unparsed', body: null, raw: stripRaw(msg) }
    }

    const type = getContentType(content)
    if (!type) {
      if (Object.keys(content).every(k => OVERHEAD_KEYS.has(k))) return { kind: 'excluded_type', reason: 'sender_key_distribution' }
      return { kind: 'message', ...base, msg_type: 'unparsed', body: null, raw: stripRaw(msg) }
    }
    if (EXCLUDED.has(type)) return { kind: 'excluded_type', reason: type }

    if (type === 'protocolMessage') {
      const pm = content.protocolMessage
      const target = pm.key?.id
      const ev = {
        kind: 'event',
        chat_jid,
        target_wa_msg_id: target,
        actor_jid: key.participant || (key.fromMe ? 'me' : null),
        event_key: `${chat_jid}|${wa_msg_id}`, // the protocol message's own id: unique per edit/revoke
        raw: stripRaw(msg)
      }
      if (pm.type === PT.REVOKE && target) return { ...ev, event_type: 'revoke', new_body: null, event_ts: base.wa_timestamp }
      if (pm.type === PT.MESSAGE_EDIT && target) {
        const edited = normalizeMessageContent(pm.editedMessage)
        const editTs = pm.timestampMs ? toNumber(pm.timestampMs) : base.wa_timestamp
        return { ...ev, event_type: 'edit', new_body: textOf(edited, getContentType(edited)), event_ts: editTs }
      }
      return { kind: 'excluded_type', reason: `protocol:${pm.type}` }
    }

    return {
      kind: 'message',
      ...base,
      ...quotedOf(content, type),
      msg_type: TYPE_NAMES[type] || type,
      body: textOf(content, type),
      raw: stripRaw(msg)
    }
  } catch (err) {
    return { kind: 'message', ...base, msg_type: 'unparsed', body: null, raw: JSON.stringify({ error: err.message, key }) }
  }
}
