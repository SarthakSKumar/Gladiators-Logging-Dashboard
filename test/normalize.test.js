import { test } from "node:test";
import assert from "node:assert/strict";
import { proto } from "baileys";
import { normalize } from "../src/wa/normalize.js";
import { msg } from "./helpers.js";

const PT = proto.Message.ProtocolMessage.Type;
const Stub = proto.WebMessageInfo.StubType;

test("plain text is kept: conversation, extended text (with reply context), emoji and any characters", () => {
  const r = normalize(msg({ text: "5 w 100 🏇 ₹500 — ok?", ts: 1_790_000_123, pushName: "Ravi" }), "live");
  assert.equal(r.kind, "message");
  assert.equal(r.msg_type, "text");
  assert.equal(r.body, "5 w 100 🏇 ₹500 — ok?");
  assert.equal(r.wa_timestamp, 1_790_000_123_000);
  assert.equal(r.push_name, "Ravi");
  assert.equal(r.sender_pn, "919000000001@s.whatsapp.net");
  const e = normalize(
    msg({ message: { extendedTextMessage: { text: "reply", contextInfo: { stanzaId: "Q1", quotedMessage: { conversation: "orig" } } } } }),
    "live",
  );
  assert.equal(e.body, "reply");
  assert.equal(e.quoted_wa_msg_id, "Q1");
  assert.equal(e.quoted_body, "orig");
});

test("text inside ephemeral / view-once wrappers is unwrapped and kept", () => {
  for (const wrapped of [
    { ephemeralMessage: { message: { conversation: "eph" } } },
    { viewOnceMessage: { message: { extendedTextMessage: { text: "vo" } } } },
    { viewOnceMessageV2: { message: { conversation: "vo2" } } },
  ]) {
    const r = normalize(msg({ message: wrapped }), "live");
    assert.equal(r.kind, "message", JSON.stringify(wrapped));
    assert.ok(["eph", "vo", "vo2"].includes(r.body));
  }
});

test("LID participant with PN alternate keeps both ids", () => {
  const m = msg({ participant: "123456789@lid" });
  m.key.participantAlt = "919111111111@s.whatsapp.net";
  const r = normalize(m, "live");
  assert.equal(r.sender_jid, "123456789@lid");
  assert.equal(r.sender_pn, "919111111111@s.whatsapp.net");
});

test("every non-text type is silently ignored — including media with captions", () => {
  const ignored = {
    image: { imageMessage: { caption: "5 w 100", jpegThumbnail: Buffer.alloc(10) } },
    video: { videoMessage: { caption: "see this" } },
    gif: { videoMessage: { gifPlayback: true, caption: "lol" } },
    sticker: { stickerMessage: { isAnimated: false } },
    document: { documentMessage: { fileName: "odds.pdf", caption: "today" } },
    documentWithCaption: { documentWithCaptionMessage: { message: { documentMessage: { fileName: "x.pdf", caption: "cap" } } } },
    audio: { audioMessage: { seconds: 3 } },
    voiceNote: { audioMessage: { ptt: true } },
    contact: { contactMessage: { displayName: "Bookie" } },
    contacts: { contactsArrayMessage: { contacts: [{ displayName: "A" }] } },
    location: { locationMessage: { degreesLatitude: 12.9, degreesLongitude: 77.5 } },
    liveLocation: { liveLocationMessage: { degreesLatitude: 1, degreesLongitude: 2 } },
    poll: { pollCreationMessageV3: { name: "Winner?", options: [{ optionName: "A" }] } },
    pollVote: { pollUpdateMessage: {} },
    reaction: { reactionMessage: { text: "👍" } },
    edit: { protocolMessage: { type: PT.MESSAGE_EDIT, key: { id: "O1" }, editedMessage: { conversation: "v2" } } },
    revoke: { protocolMessage: { type: PT.REVOKE, key: { id: "O1" } } },
    editWrapper: { editedMessage: { message: { protocolMessage: { type: PT.MESSAGE_EDIT, key: { id: "O2" }, editedMessage: { conversation: "v3" } } } } },
    ephemeralSetting: { protocolMessage: { type: PT.EPHEMERAL_SETTING } },
    senderKeyOnly: { senderKeyDistributionMessage: {}, messageContextInfo: {} },
    emptyText: { conversation: "" },
    unknownFuture: { someFutureMessage: { text: "x" } },
  };
  for (const [name, message] of Object.entries(ignored)) {
    assert.deepEqual(normalize(msg({ message }), "live"), { kind: "ignored" }, name);
  }
  // system / stub messages with no content
  for (const stub of [Stub.GROUP_CHANGE_SUBJECT, Stub.GROUP_PARTICIPANT_ADD, Stub.REVOKE]) {
    assert.equal(normalize(msg({ message: null, messageStubType: stub }), "live").kind, "ignored");
  }
  assert.equal(normalize(msg({ message: null }), "live").kind, "ignored");
});

test("undecryptable messages are reported (not silently dropped), never stored as text", () => {
  const r = normalize(msg({ id: "C1", message: null, messageStubType: Stub.CIPHERTEXT, messageStubParameters: ["No session"] }), "live");
  assert.equal(r.kind, "undecryptable");
  assert.equal(r.wa_msg_id, "C1");
  assert.equal(r.reason, "No session");
});

test("a message without key/id is structurally invalid", () => {
  assert.throws(() => normalize({ key: {} }, "live"));
});
