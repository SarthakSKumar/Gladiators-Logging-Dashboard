// Group configuration + preflight resolution (plan §9). Groups are identified by their stable
// @g.us id; labels are only used to *find* that id, with exact matching after Unicode normalisation.
import { loadGroupsConfig } from '../config.js'

export const normLabel = s => String(s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ')
const loose = s => normLabel(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

export const createGroups = ({ db, log, now = Date.now, loadConfig = loadGroupsConfig }) => {
  let byJid = new Map() // jid → row (resolved/inaccessible, enabled)
  let anyUnresolved = true
  let lastFetchAt = 0

  const rows = () => db.prepare('SELECT * FROM groups WHERE enabled = 1 ORDER BY id').all()
  const refresh = () => {
    const all = rows()
    byJid = new Map(all.filter(g => g.jid && (g.status === 'resolved' || g.status === 'inaccessible')).map(g => [g.jid, g]))
    anyUnresolved = all.some(g => !g.jid)
  }

  /** Sync config/groups.json into the table. Removed entries are disabled, never deleted (history stays). */
  const syncConfig = () => {
    const cfg = loadConfig()
    const t = now()
    db.transaction(() => {
      const upsert = db.prepare(`INSERT INTO groups (config_key, label, jid, pinned, status, enabled, updated_at)
        VALUES (@key, @label, @jid, @pinned, @status, 1, @t)
        ON CONFLICT(config_key) DO UPDATE SET label = excluded.label, enabled = 1, updated_at = excluded.updated_at,
          jid = CASE WHEN excluded.pinned = 1 THEN excluded.jid ELSE groups.jid END,
          pinned = CASE WHEN excluded.pinned = 1 THEN 1 ELSE groups.pinned END,
          status = CASE WHEN excluded.pinned = 1 AND groups.jid IS NOT excluded.jid THEN 'resolved' ELSE groups.status END`)
      for (const g of cfg) {
        upsert.run({ key: g.key, label: g.label, jid: g.jid || null, pinned: g.jid ? 1 : 0, status: g.jid ? 'resolved' : 'unresolved', t })
      }
      const keys = cfg.map(g => g.key)
      db.prepare(`UPDATE groups SET enabled = 0, updated_at = ? WHERE config_key NOT IN (${keys.map(() => '?').join(',') || "''"})`).run(t, ...keys)
    })()
    refresh()
  }

  /**
   * Preflight: fetch every group the linked account participates in, resolve each configured label to
   * exactly one id, report ambiguous/missing matches with the action needed.
   * @param {() => Promise<Record<string, {id,subject,size?,participants?,creation?}>>} fetchAll
   */
  const preflight = async (fetchAll, { force = false, me } = {}) => {
    if (!force && now() - lastFetchAt < 60_000) return { skipped: true }
    lastFetchAt = now()
    const fetched = Object.values(await fetchAll())
    const t = now()
    const update = db.prepare(`UPDATE groups SET jid = @jid, subject_current = @subject, status = @status,
      candidates_json = @candidates, action = @action, resolved_at = @resolved_at, updated_at = @t WHERE id = @id`)
    const summary = []
    db.transaction(() => {
      for (const g of rows()) {
        const card = c => ({ id: c.id, subject: c.subject, size: c.size ?? c.participants?.length ?? null, creation: c.creation ?? null })
        let next
        if (g.jid && (g.pinned || g.status === 'resolved' || g.status === 'inaccessible')) {
          const found = fetched.find(c => c.id === g.jid)
          next = found
            ? { jid: g.jid, subject: found.subject, status: 'resolved', candidates: null, action: null, resolved_at: g.resolved_at ?? t }
            : { jid: g.jid, subject: g.subject_current, status: 'inaccessible', candidates: null, resolved_at: g.resolved_at,
                action: `The linked number is no longer a participant of "${g.label}". Ask a group admin to add ${me || 'the linked number'} back, then click Re-check.` }
        } else {
          const exact = fetched.filter(c => normLabel(c.subject) === normLabel(g.label))
          if (exact.length === 1) {
            next = { jid: exact[0].id, subject: exact[0].subject, status: 'resolved', candidates: null, action: null, resolved_at: t }
          } else if (exact.length > 1) {
            next = { jid: null, subject: null, status: 'ambiguous', candidates: JSON.stringify(exact.map(card)), resolved_at: null,
                     action: `${exact.length} groups are named "${g.label}". Pick the right one below (compare member count / creation date).` }
          } else {
            const near = fetched.filter(c => loose(c.subject) === loose(g.label) || loose(c.subject).includes(loose(g.label)))
            next = { jid: null, subject: null, status: 'missing', candidates: near.length ? JSON.stringify(near.map(card)) : null, resolved_at: null,
                     action: `No group named exactly "${g.label}". Ask a group admin to add ${me || 'the linked number'} to it, then click Re-check.` +
                       (near.length ? ' Similar names are listed as suggestions (not auto-selected).' : '') }
          }
        }
        update.run({ id: g.id, t, ...next })
        summary.push({ key: g.config_key, label: g.label, status: next.status })
      }
    })()
    refresh()
    log?.info({ summary }, 'groups: preflight')
    return { summary }
  }

  /** Operator picks one candidate for an ambiguous group (or confirms a near-match). */
  const pick = (configKey, jid) => {
    const g = db.prepare('SELECT * FROM groups WHERE config_key = ?').get(configKey)
    if (!g) throw Object.assign(new Error('unknown group'), { status: 404 })
    const candidates = JSON.parse(g.candidates_json || '[]')
    const c = candidates.find(x => x.id === jid)
    if (!c) throw Object.assign(new Error('jid is not one of the listed candidates'), { status: 400 })
    db.prepare(`UPDATE groups SET jid = ?, subject_current = ?, status = 'resolved', pinned = 1, candidates_json = NULL,
      action = NULL, resolved_at = ?, updated_at = ? WHERE id = ?`).run(jid, c.subject, now(), now(), g.id)
    refresh()
  }

  const onGroupsUpdate = updates => {
    for (const u of updates) {
      if (!u.id || !byJid.has(u.id) || u.subject === undefined) continue
      db.prepare('UPDATE groups SET subject_current = ?, updated_at = ? WHERE jid = ?').run(u.subject, now(), u.id)
      log?.info({ jid: u.id, subject: u.subject }, 'groups: renamed (still tracked by id)')
    }
    refresh()
  }

  const onParticipantsUpdate = ({ id, participants, action }, meIds) => {
    if (!byJid.has(id) || action !== 'remove') return
    const removedMe = participants.some(p => meIds.includes(typeof p === 'string' ? p : p.id) || meIds.includes(p.phoneNumber) || meIds.includes(p.lid))
    if (!removedMe) return
    db.prepare(`UPDATE groups SET status = 'inaccessible', action = ?, updated_at = ? WHERE jid = ?`)
      .run('The linked number was removed from this group. Ask an admin to add it back, then click Re-check.', now(), id)
    refresh()
  }

  refresh()
  return {
    syncConfig,
    preflight,
    pick,
    onGroupsUpdate,
    onParticipantsUpdate,
    list: rows,
    /** 'target' | 'pending' | 'non_target' — pending while any configured group is unresolved */
    scopeOf: jid => (byJid.has(jid) ? 'target' : anyUnresolved ? 'pending' : 'non_target'),
    targetOf: jid => byJid.get(jid) || null,
    allResolved: () => !anyUnresolved
  }
}
