# Phase 0 findings — baileys@7.0.0-rc14

Run `node record.js --label <name>` (add `--online` for the markOnlineOnConnect A/B runs).
Each section: what was done, evidence (tape file + line refs), conclusion.

## Already established from the pinned source (no live run needed)

| Fact | Source |
|---|---|
| Receipt/ack is sent to WhatsApp **before** `messages.upsert` is emitted → crash in that window = unrecoverable loss | `lib/Socket/messages-recv.js` ~L1417 then L1432 |
| Offline backlog is emitted as `messages.upsert` with `type: 'append'`; live as `'notify'` | `messages-recv.js` L1432 |
| While logged in, events are buffered in memory from connect until the server's offline marker (`CB:ib,,offline`) or 30 s timeout, then flushed; `receivedPendingNotifications:true` is emitted at that marker | `lib/Socket/socket.js` ~L821-840, `Utils/event-buffer.js` |
| `ev.process` handlers are **not** awaited between batches (EventEmitter) → consumer must serialise | `Utils/event-buffer.js` L99-107 |
| Edits → raw `protocolMessage` (MESSAGE_EDIT) in `messages.upsert` **and** a derived `messages.update`; revokes same with REVOKE | `Utils/process-message.js` L298, L364 |
| Undecryptable → `messages.upsert` stub `messageStubType=CIPHERTEXT`; placeholder resend arrives later as `messages.upsert` with `requestId` and the same key id | `messages-recv.js` L1299-1350, `process-message.js` PDO response |
| Auth key types: pre-key, session, sender-key, sender-key-memory, app-state-sync-key, app-state-sync-version, lid-mapping, device-list, tctoken, identity-key | `lib/Types/Auth.d.ts` |
| Disconnect codes: 428 closed, 408 lost/timedOut, 440 replaced, 401 loggedOut, 500 badSession, 515 restartRequired, 411 mdMismatch, 403 forbidden, 503 unavailable | `lib/Types/index.d.ts` |
| Per-group member labels exist (`group.member-tag.update`) | `lib/Types/Events.d.ts` |

## A. Setup  ·  B. Linking  ·  C. Event inventory  ·  D. Message variety  ·  E. LID/PN identity
## F. History  ·  G. Offline backlog matrix  ·  H. Crash & loss window  ·  I. Decryption errors
## J. Groups  ·  K. Resources & key types  ·  L. Alert sending  ·  M. Exit & recommendation

_(fill per the Phase 0 checklist in the plan)_

| Outage | markOnline | Sent | Received | Path (notify/append/history) | Msgs after pending flag | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
