// Pure: Baileys WAMessage → one of
//   { kind: 'message', ... }        plain text (conversation / extendedTextMessage, after unwrapping
//                                   ephemeral / view-once / edited wrappers) — the only thing stored
//   { kind: 'undecryptable', ... }  WhatsApp could not decrypt it: not stored, but reported (never silent)
//   { kind: 'ignored' }             everything else: media (even with captions), stickers, documents,
//                                   audio, contacts, locations, polls, reactions, protocol/system messages,
//                                   and text longer than MAX_LINES lines (balance sheets, bank details, essays:
//                                   not bets — never stored, parsed, shown or forwarded)
import { getContentType, isPnUser, normalizeMessageContent, proto, toNumber } from 'baileys'

export const PARSE_VERSION = 2

const CIPHERTEXT = proto.WebMessageInfo.StubType.CIPHERTEXT
const TEXT_TYPES = new Set(['conversation', 'extendedTextMessage'])
const IGNORED = Object.freeze({ kind: 'ignored' })

/** Bet messages are short. Text with more lines than this is ignored completely. */
export const MAX_LINES = 3
/** Lines as the sender sees them: surrounding blank space is not counted, blank lines in between are. */
export const lineCount = text => text.trim().split(/\r?\n/).length

const isLong = v => v && typeof v === 'object' && typeof v.low === 'number' && typeof v.high === 'number'

/** JSON with all binary removed and protobuf Longs as numbers. */
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

/** Text of a plain-text message content, or null when it is not plain text. */
export const plainText = content => {
  const type = getContentType(content)
  if (!TEXT_TYPES.has(type)) return null
  const text = type === 'conversation' ? content.conversation : content.extendedTextMessage?.text
  if (typeof text !== 'string' || !text.trim()) return null
  return lineCount(text) > MAX_LINES ? null : text
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
  const who = {
    sender_jid: key.participant || (key.fromMe ? 'me' : null),
    sender_pn: ids.find(j => isPnUser(j)) || null,
    push_name: msg.pushName || null
  }

  if (msg.messageStubType === CIPHERTEXT) {
    return { kind: 'undecryptable', chat_jid, wa_msg_id, ...who, wa_timestamp: tsMs(msg.messageTimestamp), reason: msg.messageStubParameters?.[0] || null }
  }
  let content
  try { content = normalizeMessageContent(msg.message) } catch { return IGNORED }
  const body = content ? plainText(content) : null
  if (body === null) return IGNORED

  const ctx = content.extendedTextMessage?.contextInfo
  const quoted = ctx?.stanzaId ? normalizeMessageContent(ctx.quotedMessage) : null
  return {
    kind: 'message',
    chat_jid,
    wa_msg_id,
    from_me: key.fromMe ? 1 : 0,
    ...who,
    wa_timestamp: tsMs(msg.messageTimestamp),
    source,
    msg_type: 'text',
    body,
    quoted_wa_msg_id: ctx?.stanzaId || null,
    quoted_body: quoted ? plainText(quoted) : null,
    parse_version: PARSE_VERSION,
    raw: stripRaw(msg)
  }
}
