// Group selection. The database is the source of truth:
//   account_groups — every group the linked account is in (cache of groupFetchAllParticipating)
//   groups         — the groups selected for logging (enabled = 1), tracked by their stable @g.us id
// config/groups.json is only imported once (upgrade path); legacy rows without an id are resolved by
// exact label match on the next refresh.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getMeta, setMeta } from '../db/index.js'

export const normLabel = s => String(s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ')
const httpError = (status, message) => Object.assign(new Error(message), { status })

export const createGroups = ({ db, log, configDir, now = Date.now }) => {
  let byJid = new Map()
  let anyUnresolved = false

  const selected = () => db.prepare('SELECT * FROM groups WHERE enabled = 1 ORDER BY id').all()
  const refresh = () => {
    const all = selected()
    byJid = new Map(all.filter(g => g.jid && (g.status === 'resolved' || g.status === 'inaccessible')).map(g => [g.jid, g]))
    anyUnresolved = all.some(g => !g.jid)
  }

  /** One-time upgrade: import config/groups.json if the table has never been populated. */
  const importLegacyConfig = () => {
    if (getMeta(db, 'groups_config_imported')) return { imported: 0 }
    const file = configDir ? join(configDir, 'groups.json') : null
    let imported = 0
    const hasRows = db.prepare('SELECT count(*) FROM groups').pluck().get() > 0
    if (!hasRows && file && existsSync(file)) {
      const cfg = JSON.parse(readFileSync(file, 'utf8'))
      const ins = db.prepare(`INSERT OR IGNORE INTO groups (config_key, label, jid, pinned, status, enabled, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)`)
      for (const g of cfg) imported += ins.run(g.key, g.label, g.jid || null, g.jid ? 1 : 0, g.jid ? 'resolved' : 'unresolved', now()).changes
    }
    setMeta(db, 'groups_config_imported', new Date(now()).toISOString())
    if (imported) log?.info({ imported }, 'groups: imported legacy config/groups.json')
    return { imported }
  }

  /**
   * Refresh the account's group list and re-check every selected group against it.
   * @param {() => Promise<Record<string, {id, subject, size?, participants?, creation?}>>} fetchAll
   */
  const refreshAccount = async fetchAll => {
    const fetched = Object.values(await fetchAll())
    const t = now()
    db.transaction(() => {
      const up = db.prepare(`INSERT INTO account_groups (jid, subject, size, creation, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET subject = excluded.subject, size = excluded.size, creation = excluded.creation, updated_at = excluded.updated_at`)
      for (const g of fetched) up.run(g.id, g.subject ?? null, g.size ?? g.participants?.length ?? null, g.creation ?? null, t)
      db.prepare('DELETE FROM account_groups WHERE updated_at < ?').run(t)
      setMeta(db, 'account_groups_fetched_at', t)

      const upd = db.prepare('UPDATE groups SET jid = ?, subject_current = ?, status = ?, action = ?, resolved_at = coalesce(resolved_at, ?), updated_at = ? WHERE id = ?')
      for (const g of selected()) {
        if (g.jid) {
          const found = fetched.find(c => c.id === g.jid)
          if (found) upd.run(g.jid, found.subject, 'resolved', null, t, t, g.id)
          else upd.run(g.jid, g.subject_current, 'inaccessible', 'The linked number is no longer a member of this group. Ask a group admin to add it back.', null, t, g.id)
        } else {
          // legacy row from groups.json: exact (normalised) label match only, never a guess
          const exact = fetched.filter(c => normLabel(c.subject) === normLabel(g.label))
          if (exact.length === 1) upd.run(exact[0].id, exact[0].subject, 'resolved', null, t, t, g.id)
          else upd.run(null, null, exact.length ? 'ambiguous' : 'missing', exact.length ? 'Several groups have this name — remove it and add the right one from the list.' : 'No group with this exact name — remove it and add the group from the list.', null, t, g.id)
        }
      }
    })()
    refresh()
    log?.info({ groups: fetched.length }, 'groups: account list refreshed')
    return fetched.length
  }

  const accountGroups = () => db.prepare(`SELECT a.jid, a.subject, a.size, a.creation, a.updated_at,
      g.id AS group_id, coalesce(g.enabled, 0) AS selected
    FROM account_groups a LEFT JOIN groups g ON g.jid = a.jid ORDER BY a.subject COLLATE NOCASE`).all()
    .map(r => ({ ...r, selected: Boolean(r.selected) }))

  const add = jid => {
    const acct = db.prepare('SELECT * FROM account_groups WHERE jid = ?').get(jid)
    if (!acct) throw httpError(404, 'That group is not in the linked account’s group list. Refresh the list and try again.')
    const t = now()
    const existing = db.prepare('SELECT * FROM groups WHERE jid = ?').get(jid)
    if (existing) {
      db.prepare("UPDATE groups SET enabled = 1, status = 'resolved', action = NULL, subject_current = ?, updated_at = ? WHERE id = ?").run(acct.subject, t, existing.id)
    } else {
      db.prepare(`INSERT INTO groups (config_key, label, jid, subject_current, status, pinned, enabled, resolved_at, updated_at)
        VALUES (?, ?, ?, ?, 'resolved', 1, 1, ?, ?)`).run(jid, acct.subject || jid, jid, acct.subject, t, t)
    }
    refresh()
    return db.prepare('SELECT * FROM groups WHERE jid = ?').get(jid)
  }

  /** Deselect (history is kept; re-adding the same group restores it). */
  const remove = id => {
    const g = db.prepare('SELECT * FROM groups WHERE id = ? AND enabled = 1').get(id)
    if (!g) throw httpError(404, 'Unknown group')
    db.prepare('UPDATE groups SET enabled = 0, updated_at = ? WHERE id = ?').run(now(), id)
    refresh()
    return g
  }

  const onGroupsUpdate = updates => {
    for (const u of updates) {
      if (!u.id || u.subject === undefined) continue
      db.prepare('UPDATE account_groups SET subject = ?, updated_at = ? WHERE jid = ?').run(u.subject, now(), u.id)
      if (!byJid.has(u.id)) continue
      db.prepare('UPDATE groups SET subject_current = ?, updated_at = ? WHERE jid = ?').run(u.subject, now(), u.id)
      log?.info({ jid: u.id, subject: u.subject }, 'groups: renamed (still tracked by id)')
    }
    refresh()
  }

  const onParticipantsUpdate = ({ id, participants, action }, meIds) => {
    if (!byJid.has(id) || action !== 'remove') return false
    const removedMe = participants.some(p => meIds.includes(typeof p === 'string' ? p : p.id) || meIds.includes(p.phoneNumber) || meIds.includes(p.lid))
    if (!removedMe) return false
    db.prepare("UPDATE groups SET status = 'inaccessible', action = ?, updated_at = ? WHERE jid = ?")
      .run('The linked number was removed from this group. Ask an admin to add it back.', now(), id)
    refresh()
    return true
  }

  refresh()
  return {
    importLegacyConfig,
    refreshAccount,
    accountGroups,
    accountFetchedAt: () => Number(getMeta(db, 'account_groups_fetched_at') || 0) || null,
    add,
    remove,
    onGroupsUpdate,
    onParticipantsUpdate,
    list: selected,
    get: id => db.prepare('SELECT * FROM groups WHERE id = ?').get(id),
    /** 'target' | 'pending' | 'non_target' — pending only while a legacy row awaits its id */
    scopeOf: jid => (byJid.has(jid) ? 'target' : anyUnresolved ? 'pending' : 'non_target'),
    targetOf: jid => byJid.get(jid) || null,
    allResolved: () => !anyUnresolved
  }
}
