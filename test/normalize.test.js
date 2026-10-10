import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proto } from 'baileys'
import { normalize } from '../src/wa/normalize.js'
import { G1, msg } from './helpers.js'

const PT = proto.Message.ProtocolMessage.Type

test('plain and extended text; sender ids and push name; ms timestamp', () => {
  const r = normalize(msg({ text: '2 w 200 p 300', ts: 1_790_000_123, pushName: 'Ravi' }), 'live')
  assert.equal(r.kind, 'message')
  assert.equal(r.msg_type, 'text')
  assert.equal(r.body, '2 w 200 p 300')
  assert.equal(r.wa_timestamp, 1_790_000_123_000)
  assert.equal(r.push_name, 'Ravi')
  assert.equal(r.sender_pn, '919000000001@s.whatsapp.net')
  const e = normalize(msg({ message: { extendedTextMessage: { text: 'reply', contextInfo: { stanzaId: 'Q1', quotedMessage: { conversation: 'orig' } } } } }), 'live')
  assert.equal(e.body, 'reply')
  assert.equal(e.quoted_wa_msg_id, 'Q1')
  assert.equal(e.quoted_body, 'orig')
})

test('LID participant with PN alternate keeps both', () => {
  const m = msg({ participant: '123456789@lid' })
  m.key.participantAlt = '919111111111@s.whatsapp.net'
  const r = normalize(m, 'live')
  assert.equal(r.sender_jid, '123456789@lid')
  assert.equal(r.sender_pn, '919111111111@s.whatsapp.net')
})

test('media becomes a placeholder with caption; binary is stripped from raw', () => {
  const r = normalize(msg({ message: { imageMessage: { caption: 'slip', jpegThumbnail: Buffer.alloc(500, 1), mediaKey: new Uint8Array(32) } } }), 'live')
  assert.equal(r.msg_type, 'image')
  assert.equal(r.body, 'slip')
  assert.ok(!r.raw.includes('"data"'))
  assert.ok(r.raw.includes('"_bin":500') || r.raw.includes('"_bin": 500'))
  const doc = normalize(msg({ message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'odds.pdf', caption: 'today' } } } } }), 'live')
  assert.equal(doc.msg_type, 'document')
  assert.equal(doc.body, 'odds.pdf — today')
})

test('edit and revoke become events keyed by the protocol message id', () => {
  const edit = normalize(msg({
    id: 'EDIT1',
    message: { protocolMessage: { type: PT.MESSAGE_EDIT, key: { id: 'ORIG1', remoteJid: G1 }, editedMessage: { conversation: 'fixed' }, timestampMs: 1_790_000_500_000 } }
  }), 'live')
  assert.equal(edit.kind, 'event')
  assert.equal(edit.event_type, 'edit')
  assert.equal(edit.target_wa_msg_id, 'ORIG1')
  assert.equal(edit.new_body, 'fixed')
  assert.equal(edit.event_ts, 1_790_000_500_000)
  assert.equal(edit.event_key, `${G1}|EDIT1`)
  const wrapped = normalize(msg({ message: { editedMessage: { message: { protocolMessage: { type: PT.MESSAGE_EDIT, key: { id: 'ORIG2' }, editedMessage: { conversation: 'v2' } } } } } }), 'live')
  assert.equal(wrapped.event_type, 'edit')
  assert.equal(wrapped.new_body, 'v2')
  const rev = normalize(msg({ id: 'REV1', message: { protocolMessage: { type: PT.REVOKE, key: { id: 'ORIG1' } } } }), 'live')
  assert.equal(rev.event_type, 'revoke')
  assert.equal(rev.target_wa_msg_id, 'ORIG1')
})

test('undecryptable, deleted, system stubs are stored; reactions/poll votes/SKDM are excluded', () => {
  const ct = normalize(msg({ message: null, messageStubType: proto.WebMessageInfo.StubType.CIPHERTEXT, messageStubParameters: ['No session'] }), 'live')
  assert.equal(ct.msg_type, 'undecryptable')
  const del = normalize(msg({ message: null, messageStubType: proto.WebMessageInfo.StubType.REVOKE }), 'history')
  assert.equal(del.msg_type, 'deleted')
  const sys = normalize(msg({ message: null, messageStubType: proto.WebMessageInfo.StubType.GROUP_CHANGE_SUBJECT, messageStubParameters: ['New name'] }), 'live')
  assert.equal(sys.msg_type, 'system')
  assert.match(sys.body, /GROUP_CHANGE_SUBJECT: New name/)
  assert.equal(normalize(msg({ message: { reactionMessage: { text: '👍' } } }), 'live').kind, 'excluded_type')
  assert.equal(normalize(msg({ message: { pollUpdateMessage: {} } }), 'live').kind, 'excluded_type')
  assert.equal(normalize(msg({ message: { senderKeyDistributionMessage: {}, messageContextInfo: {} } }), 'live').kind, 'excluded_type')
  assert.equal(normalize(msg({ message: { protocolMessage: { type: PT.EPHEMERAL_SETTING } } }), 'live').kind, 'excluded_type')
})

test('unknown content types are stored under their raw name, never dropped', () => {
  const r = normalize(msg({ message: { someFutureMessage: { text: 'x' } } }), 'live')
  assert.equal(r.kind, 'message')
  assert.equal(r.msg_type, 'someFutureMessage')
  const empty = normalize(msg({ message: null }), 'live')
  assert.equal(empty.msg_type, 'unparsed')
  assert.throws(() => normalize({ key: {} }, 'live'))
})
