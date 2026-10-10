// Cross-file consistency checks (plan §6). messages.db, auth.db and the journal carry the same
// data_epoch; auth.db carries a monotonic write counter whose high-water mark is recorded in
// messages.db (heartbeat) AND in the journal (mark frames). If auth.db is older than either witness,
// its Signal keys were rolled back: connecting with them can break encryption sessions, so we refuse.
import { randomUUID } from 'node:crypto'
import { getMeta, setMeta } from './db/index.js'

/** Decide the install epoch before the journal is opened. */
export const resolveEpoch = ({ msgDb, authDb }) => {
  const m = getMeta(msgDb, 'data_epoch')
  const a = getMeta(authDb, 'data_epoch')
  if (m && a && m !== a) return { ok: false, reason: 'mixed_installs', detail: `messages.db is install ${m} but auth.db is install ${a}` }
  const epoch = m || a || randomUUID()
  if (!m) setMeta(msgDb, 'data_epoch', epoch)
  return { ok: true, epoch, authEpochMissing: !a }
}

export const checkAuthRollback = ({ msgDb, authStore, journal }) => {
  const counter = authStore.writeCounter()
  const hwm = Math.max(Number(getMeta(msgDb, 'auth_counter_hwm') || 0), journal.maxAuthMark || 0)
  if (counter < hwm) {
    return {
      ok: false,
      reason: 'auth_rollback',
      detail: `auth.db write counter ${counter} is behind the recorded high-water mark ${hwm}: the authentication store is older than ` +
        'the rest of the data (restored or replaced). Connecting with stale keys can break encryption sessions.',
      counter,
      hwm
    }
  }
  return { ok: true, counter, hwm }
}

/** Operator chose "start a fresh link": wipe keys and move the counter past every witness. */
export const resolveAuthRollbackByRelink = ({ msgDb, authDb, authStore, journal, epoch }) => {
  const hwm = Math.max(Number(getMeta(msgDb, 'auth_counter_hwm') || 0), journal.maxAuthMark || 0)
  authStore.wipe()
  authStore.raiseCounterTo(hwm + 1)
  setMeta(authDb, 'data_epoch', epoch)
}

export const recordHighWater = ({ msgDb, authStore, journal }) => {
  const counter = authStore.writeCounter()
  setMeta(msgDb, 'auth_counter_hwm', counter)
  journal.mark(counter)
}
