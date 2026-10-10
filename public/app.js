// Dashboard. The server database is the source of truth; this page is a live view of it.
// Message text is untrusted: it is only ever inserted with textContent, never innerHTML.
const $ = id => document.getElementById(id)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }

const STATE = {
  ONLINE: ['ok', 'Online'], SYNCING: ['info pulse', 'Catching up'], CONNECTING: ['info pulse', 'Connecting'], STARTING: ['info pulse', 'Starting'],
  RECONNECTING: ['warn pulse', 'Reconnecting'], LINKING: ['info pulse', 'Linking'], NEEDS_LINK: ['bad', 'Link required'], LINK_IDLE: ['bad', 'Not linked'],
  REPLACED: ['bad', 'Replaced'], RESTRICTED: ['bad', 'Restricted'], SUSPENDED: ['warn', 'Paused'], NEEDS_OPERATOR: ['bad', 'Action required'], STOPPED: ['bad', 'Stopped']
}
const GROUP_STATUS = { resolved: ['ok', 'Resolved'], ambiguous: ['warn', 'Ambiguous'], missing: ['bad', 'Not found'], inaccessible: ['bad', 'Removed'], unresolved: ['', 'Waiting for WhatsApp'] }
const TYPE_LABEL = { image: 'Photo', video: 'Video', video_note: 'Video note', audio: 'Audio', document: 'Document', sticker: 'Sticker', location: 'Location', live_location: 'Live location', contact: 'Contact', contacts: 'Contacts', poll: 'Poll', event: 'Event', group_invite: 'Group invite', unparsed: 'Unsupported message' }

let status = null
let tz = 'Asia/Kolkata'
const view = { groupId: null, tab: 'all', sessionId: null, rows: [], total: 0, maxTs: 0, session: null }
const latestByGroup = {}
let es = null
let streamOk = false
let reloadTimer = null

// ---------- helpers ----------
const api = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch', ...(opts.headers || {}) } })
  if (r.status === 401) { location.replace('/login.html'); throw new Error('Signed out') }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return data
}
const post = (url, body) => api(url, { method: 'POST', body: JSON.stringify(body || {}) })
const dayKey = ms => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
const fmtTime = ms => {
  if (!ms) return '—'
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(ms)
  if (dayKey(ms) === dayKey(Date.now())) return t
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short' }).format(ms)} ${t}`
}
const fmtFull = ms => (ms ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'medium', hour12: false }).format(ms) : '—')
const ago = ms => {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
const dur = ms => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(r).padStart(2, '0')}`
}
const prettyJid = jid => {
  if (!jid) return 'Unknown'
  const user = jid.split(/[@:]/)[0]
  return jid.includes('@lid') ? `~${user.slice(-6)}` : `+${user}`
}
const senderOf = r => (r.from_me ? 'Logger (this device)' : r.member_tag || r.push_name || r.contact_name || prettyJid(r.sender_pn || r.sender_jid))
const sec = ms => Math.floor(ms / 1000) * 1000
const inSession = (r, s) => s && r.group_id === s.group_id && r.wa_timestamp >= sec(s.started_at) && (s.ended_at == null || r.wa_timestamp < sec(s.ended_at))
const group = id => status?.groups.find(g => g.id === id)

// ---------- dialogs ----------
const confirmAction = ({ title, text, word, button = 'Confirm' }) => new Promise(resolve => {
  const d = $('confirmDlg')
  $('confirmTitle').textContent = title
  $('confirmText').textContent = text
  $('confirmErr').textContent = ''
  $('confirmTypeWrap').classList.toggle('hidden', !word)
  $('confirmWord').textContent = word || ''
  $('confirmInput').value = ''
  $('confirmSubmit').textContent = button
  d.onclose = () => resolve(d.returnValue === 'ok' && (!word || $('confirmInput').value.trim() === word))
  d.showModal()
  if (word) $('confirmInput').focus()
})

// ---------- top bar, banners, link panel ----------
const renderTop = () => {
  const c = status.connection
  const [cls, label] = STATE[c.state] || ['', c.state]
  const pill = $('connPill')
  pill.className = `pill ${cls}`
  pill.textContent = label
  pill.title = c.detail || ''
  $('meInfo').textContent = c.me ? `${c.me.name ? `${c.me.name} · ` : ''}${c.me.number}` : ''
  document.title = `${c.state === 'ONLINE' && !status.alerts.length ? '' : '⚠ '}WA Group Logger`
}

const banner = (kind, title, text, action) => {
  const b = el('div', `banner ${kind}`)
  const t = el('div', 'text')
  t.append(el('b', null, title))
  if (text) t.append(document.createTextNode(` — ${text}`))
  b.append(t)
  if (action) b.append(action)
  return b
}

const renderBanners = () => {
  const box = $('banners')
  box.replaceChildren()
  const c = status.connection
  const h = status.health
  if (!streamOk) box.append(banner('warn', 'Live updates reconnecting', 'Showing the last known data. Nothing is lost — the server keeps capturing.'))
  if (!['ONLINE', 'SYNCING', 'NEEDS_LINK', 'LINK_IDLE', 'LINKING'].includes(c.state)) {
    const kind = ['RECONNECTING', 'CONNECTING', 'STARTING', 'SUSPENDED'].includes(c.state) ? 'warn' : 'bad'
    const retry = c.nextRetryAt && c.nextRetryAt > Date.now() ? ` Next attempt in ${Math.ceil((c.nextRetryAt - Date.now()) / 1000)} s.` : ''
    box.append(banner(kind, `WhatsApp: ${STATE[c.state]?.[1] || c.state}`, `${c.detail || ''}${retry}`))
  }
  if (c.state === 'SYNCING') box.append(banner('info', 'Catching up', 'Receiving messages WhatsApp queued while the logger was offline.'))
  if (status.gapOpen && c.state !== 'ONLINE') box.append(banner('warn', 'Capture gap open', `Not capturing since ${fmtFull(status.gapOpen.started_at)} (${status.gapOpen.cause}). Messages queued by WhatsApp will be recovered on reconnect when possible.`))
  if (h.committerDegraded) box.append(banner('bad', 'Database writes failing', 'Messages are safe in the durable journal and will be applied automatically.'))
  if (h.pressure.length) box.append(banner('warn', 'Capture paused to protect data', `Reasons: ${h.pressure.join(', ')}. WhatsApp keeps queueing messages; capture resumes automatically.`))
  if (!h.invariants.ok) box.append(banner('bad', 'Counters do not reconcile', 'See Settings → Counters. An alert has been sent.'))
  if (h.disk && h.disk.free < 2 * 1024 ** 3) box.append(banner('warn', 'Low disk space', `${(h.disk.free / 1024 ** 3).toFixed(1)} GB free.`))
  for (const a of status.alerts) {
    if (['needs_link', 'not_online', 'suspended', 'commit', 'invariant'].includes(a.key)) continue
    box.append(banner(a.severity === 'critical' ? 'bad' : 'warn', a.title, a.detail))
  }
}

const renderLinkPanel = () => {
  const c = status.connection
  const show = ['NEEDS_LINK', 'LINK_IDLE', 'LINKING', 'NEEDS_OPERATOR'].includes(c.state)
  $('linkPanel').classList.toggle('hidden', !show)
  if (!show) return
  $('linkDetail').textContent = c.detail || ''
  $('linkDetail').classList.toggle('hidden', c.state === 'NEEDS_LINK') // the numbered steps say the same thing
  const qr = $('qrBox')
  if (c.state === 'NEEDS_LINK' && c.qr) qr.innerHTML = c.qr // server-generated SVG (trusted), never message content
  else qr.replaceChildren(el('div', 'muted small', c.state === 'LINKING' ? 'Linked — finishing setup…' : c.state === 'NEEDS_LINK' ? 'Generating QR…' : 'No QR shown'))
  $('linkSteps').classList.toggle('hidden', c.state !== 'NEEDS_LINK')
  $('showQrBtn').classList.toggle('hidden', c.state !== 'LINK_IDLE')
  $('freshLinkBtn').classList.toggle('hidden', c.state !== 'NEEDS_OPERATOR')
  $('linkTitle').textContent = c.state === 'NEEDS_OPERATOR' ? 'Action required' : "Link the logger's WhatsApp"
}

// ---------- group cards ----------
const renderGroups = () => {
  const box = $('groups')
  box.replaceChildren()
  for (const g of status.groups) {
    const card = el('article', `card group-card${g.id === view.groupId ? ' selected' : ''}`)
    const h = el('h3', null, g.label)
    const [cls, label] = GROUP_STATUS[g.status] || ['', g.status]
    h.append(el('span', `pill ${cls}`, label))
    card.append(h)
    if (g.subject && g.subject !== g.label) card.append(el('div', 'muted small', `Now named “${g.subject}” in WhatsApp (tracked by id)`))

    const kv = el('dl', 'kv')
    const row = (k, v) => { kv.append(el('dt', null, k)); const dd = el('dd'); if (v instanceof Node) dd.append(v); else dd.textContent = v; kv.append(dd) }
    const capturing = g.status === 'resolved' && status.connection.state === 'ONLINE'
    row('Capture', capturing ? 'Capturing · always on' : g.status === 'resolved' ? `Paused (${STATE[status.connection.state]?.[1] || status.connection.state})` : 'Waiting for group resolution')
    if (g.session) {
      const s = el('span', 'session-live')
      s.append(document.createTextNode(`● ${g.session.label}${g.session.race_number ? ` · Race ${g.session.race_number}` : ''} · `))
      const t = el('span', null, dur(Date.now() - g.session.started_at)); t.dataset.since = g.session.started_at
      s.append(t)
      row('Logging', s)
      row('Session msgs', String(g.session.message_count))
    } else row('Logging', 'Idle')
    const latest = latestByGroup[g.id] || g.latest
    row('Last message', latest ? `${ago(latest.received_at)} · ${fmtTime(latest.wa_timestamp)}` : 'none yet')
    row('Total', String(g.count))
    card.append(kv)
    if (latest) {
      const p = el('div', 'preview')
      p.append(el('b', null, `${latest.sender || senderOf(latest)}: `))
      p.append(document.createTextNode(latest.body || `[${TYPE_LABEL[latest.msg_type] || latest.msg_type}]`))
      card.append(p)
    }
    if (g.action) card.append(el('div', 'banner warn small', g.action))
    if (g.candidates?.length) {
      const list = el('div', 'candidates')
      for (const c of g.candidates) {
        const item = el('div', 'candidate')
        item.append(el('span', null, `${c.subject} · ${c.size ?? '?'} members${c.creation ? ` · created ${new Date(c.creation * 1000).toLocaleDateString()}` : ''}`))
        const use = el('button', 'btn small', 'Use this group')
        use.onclick = () => post(`/api/groups/${encodeURIComponent(g.key)}/pick`, { jid: c.id }).catch(e => alert(e.message))
        item.append(use)
        list.append(item)
      }
      card.append(list)
    }
    const actions = el('div', 'actions')
    if (g.session) {
      const stop = el('button', 'btn danger', 'Stop logging')
      stop.onclick = async () => {
        if (!await confirmAction({ title: 'Stop logging session?', text: `“${g.session.label}” will end now. Capture continues; messages sent before this moment stay in the session.`, button: 'Stop logging' })) return
        post(`/api/sessions/${g.session.id}/stop`).then(refreshStatus).catch(e => alert(e.message))
      }
      actions.append(stop)
    } else {
      const start = el('button', 'btn primary', 'Start logging')
      start.disabled = !g.jid
      start.title = g.jid ? '' : 'Resolve the group first'
      start.onclick = () => openStart(g)
      actions.append(start)
    }
    const open = el('button', 'btn', g.id === view.groupId ? 'Viewing' : 'View messages')
    open.onclick = () => selectGroup(g.id)
    actions.append(open)
    card.append(actions)
    box.append(card)
  }
}

const openStart = g => {
  $('startGroupName').textContent = g.label
  $('sessLabel').value = ''
  $('sessRace').value = ''
  $('startErr').textContent = ''
  const d = $('startDlg')
  d.dataset.groupId = g.id
  d.showModal()
  $('sessLabel').focus()
}
$('startForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'ok') return
  e.preventDefault()
  const d = $('startDlg')
  try {
    await post('/api/sessions', { groupId: Number(d.dataset.groupId), label: $('sessLabel').value, raceNumber: $('sessRace').value || null })
    d.close()
    await refreshStatus()
    selectGroup(Number(d.dataset.groupId), 'session')
  } catch (err) { $('startErr').textContent = err.message }
})
for (let i = 1; i <= 10; i++) $('sessRace').append(new Option(`Race ${i}`, String(i)))

// ---------- messages ----------
const typeBadges = r => {
  const out = []
  const b = (cls, text, title) => { const s = el('span', `badge ${cls}`, text); if (title) s.title = title; out.push(s); return s }
  if (TYPE_LABEL[r.msg_type]) b('info', TYPE_LABEL[r.msg_type])
  if (r.msg_type === 'undecryptable') b('warn', r.latest_body ? 'Decrypted late' : 'Could not decrypt yet', 'WhatsApp could not decrypt this message on arrival; the phone may resend it.')
  if (r.msg_type === 'deleted') b('bad', 'Deleted before capture')
  if (r.deleted) b('bad', 'Deleted for everyone', 'The sender deleted this message. The original text is preserved.')
  if (r.edited) { const s = b('', 'Edited · history'); s.classList.add('clickable'); s.tabIndex = 0; s.onclick = () => showHistory(r.seq) }
  if (r.source === 'offline') b('', 'Recovered', 'Delivered by WhatsApp after a disconnection')
  if (r.source === 'history') b('', 'History sync')
  if (r.skew_flag) b('warn', 'Clock skew', "The sender's phone clock differs from the server by more than a minute")
  return out
}

const rowEl = (r, isNew) => {
  const tr = el('tr', isNew ? 'new' : null)
  tr.dataset.key = `${r.chat_jid}|${r.wa_msg_id}`
  tr.title = `Sent ${fmtFull(r.wa_timestamp)} · Received ${fmtFull(r.received_at)}`
  tr.append(el('td', 'sno', String(r.sno ?? '')))
  tr.append(el('td', 'time', fmtTime(r.wa_timestamp)))
  const s = el('td', 'sender', senderOf(r))
  if (r.sender_pn && (r.push_name || r.member_tag)) s.append(el('span', 'sub', prettyJid(r.sender_pn)))
  tr.append(s)
  const m = el('td', 'msg')
  if (r.quoted_body) m.append(el('span', 'quote', r.quoted_body))
  m.append(...typeBadges(r))
  const text = r.latest_body ?? r.body
  if (r.msg_type === 'system') m.append(el('span', 'system', text || 'Group update'))
  else if (text) m.append(el('span', r.deleted ? 'strike' : null, text))
  else if (!TYPE_LABEL[r.msg_type] && !['undecryptable', 'deleted'].includes(r.msg_type)) m.append(el('span', 'muted', `[${r.msg_type}]`))
  tr.append(m)
  return tr
}

const renderRows = () => {
  const body = $('msgBody')
  body.replaceChildren(...view.rows.map(r => rowEl(r)))
  $('emptyMsg').classList.toggle('hidden', view.rows.length > 0)
  $('olderBtn').classList.toggle('hidden', !view.rows.length || view.rows.at(-1).sno <= 1)
  const g = group(view.groupId)
  $('viewInfo').textContent = view.tab === 'sessions' ? '' : `${view.total} message${view.total === 1 ? '' : 's'}${view.session ? ` · ${view.session.label}${view.session.ended_at ? ' (ended)' : ' (live)'}` : g ? ' · all time' : ''}`
}

const loadView = async () => {
  const g = group(view.groupId)
  if (!g) return
  $('messagesPanel').classList.remove('hidden')
  $('msgTitle').textContent = g.label
  for (const [id, tab] of [['tabSession', 'session'], ['tabAll', 'all'], ['tabSessions', 'sessions']]) $(id).setAttribute('aria-selected', String(view.tab === tab))
  $('tabSession').textContent = view.sessionId && g.session?.id !== view.sessionId ? 'Session' : 'Current session'
  $('tabSession').disabled = !g.session && !view.sessionId
  $('msgTable').classList.toggle('hidden', view.tab === 'sessions')
  $('sessTable').classList.toggle('hidden', view.tab !== 'sessions')
  $('newPill').classList.add('hidden')
  if (view.tab === 'sessions') {
    $('emptyMsg').classList.add('hidden'); $('olderBtn').classList.add('hidden'); $('viewInfo').textContent = ''
    const list = await api(`/api/sessions?group=${g.id}`)
    $('sessBody').replaceChildren(...list.map(s => {
      const tr = el('tr', 'clickable')
      tr.append(el('td', null, s.label), el('td', null, s.race_number ? String(s.race_number) : '—'), el('td', null, fmtFull(s.started_at)),
        el('td', null, s.ended_at ? fmtFull(s.ended_at) : 'running'), el('td', null, String(s.message_count)))
      const notes = el('td')
      if (s.late_arrivals) notes.append(el('span', 'badge info', `${s.late_arrivals} arrived after stop`))
      if (s.gaps.length) notes.append(el('span', 'badge warn', `${s.gaps.length} capture gap${s.gaps.length > 1 ? 's' : ''} — possible missing messages`))
      tr.append(notes)
      tr.tabIndex = 0
      tr.onclick = () => { view.tab = 'session'; view.sessionId = s.id; loadView() }
      return tr
    }))
    if (!list.length) { const td = el('td', 'empty', 'No sessions yet. Use “Start logging” on the group card.'); td.colSpan = 6; $('sessBody').replaceChildren(el('tr')); $('sessBody').firstChild.append(td) }
    return
  }
  const sessionId = view.tab === 'session' ? (view.sessionId || g.session?.id) : null
  if (view.tab === 'session' && !sessionId) { view.tab = 'all'; return loadView() }
  const data = await api(`/api/messages?group=${g.id}${sessionId ? `&session=${sessionId}` : ''}&limit=200`)
  view.session = sessionId ? (g.session?.id === sessionId ? g.session : (await api(`/api/sessions?group=${g.id}`)).find(s => s.id === sessionId)) : null
  view.rows = data.rows
  view.total = data.total
  view.maxTs = data.rows[0]?.wa_timestamp ?? 0
  renderRows()
}

const selectGroup = (id, tab) => {
  view.groupId = id
  const g = group(id)
  view.tab = tab || (g?.session ? 'session' : 'all')
  view.sessionId = null
  renderGroups()
  loadView().catch(e => console.error(e))
  $('messagesPanel').scrollIntoView({ behavior: 'smooth', block: 'start' })
}
$('tabAll').onclick = () => { view.tab = 'all'; view.sessionId = null; loadView() }
$('tabSession').onclick = () => { view.tab = 'session'; loadView() }
$('tabSessions').onclick = () => { view.tab = 'sessions'; loadView() }
$('olderBtn').onclick = async () => {
  const g = group(view.groupId)
  const sessionId = view.tab === 'session' ? (view.sessionId || g.session?.id) : null
  const data = await api(`/api/messages?group=${g.id}${sessionId ? `&session=${sessionId}` : ''}&beforeSno=${view.rows.at(-1).sno}&limit=200`)
  view.rows.push(...data.rows)
  renderRows()
}
$('newPill').onclick = () => { $('tableWrap').scrollTo({ top: 0, behavior: 'smooth' }); $('newPill').classList.add('hidden') }
$('tableWrap').addEventListener('scroll', () => { if ($('tableWrap').scrollTop < 40) $('newPill').classList.add('hidden') })

const showHistory = async seq => {
  const h = await api(`/api/messages/${seq}/history`)
  const box = $('histBody')
  box.replaceChildren()
  const item = (title, text, ts) => { const d = el('div', 'preview'); d.append(el('b', null, `${title} · ${fmtFull(ts)}`), el('div', null, text ?? '(no text)')); box.append(d, el('div', null, ' ')) }
  item('Original', h.message.body, h.message.wa_timestamp)
  for (const e of h.events) item(e.event_type === 'edit' ? 'Edited' : e.event_type === 'revoke' ? 'Deleted for everyone' : 'Content received later', e.new_body, e.event_ts)
  $('histDlg').showModal()
}

const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => loadView().catch(() => {}), 300) }

const onMessage = r => {
  latestByGroup[r.group_id] = r
  if (r.group_id !== view.groupId || view.tab === 'sessions') return
  if (view.tab === 'session' && !inSession(r, view.session)) return
  if (r.wa_timestamp < view.maxTs) return scheduleReload() // arrived out of order: renumber from the server
  view.total++
  r.sno = view.total
  view.maxTs = r.wa_timestamp
  view.rows.unshift(r)
  $('msgBody').prepend(rowEl(r, true))
  $('emptyMsg').classList.add('hidden')
  $('viewInfo').textContent = `${view.total} message${view.total === 1 ? '' : 's'}${view.session ? ` · ${view.session.label}` : ''}`
  if ($('tableWrap').scrollTop > 40) $('newPill').classList.remove('hidden')
}

const onEvent = e => {
  const r = view.rows.find(x => x.chat_jid === e.chat_jid && x.wa_msg_id === e.target_wa_msg_id)
  if (!r) return
  if (e.event_type === 'revoke') r.deleted = 1
  else { r.latest_body = e.new_body; if (e.event_type === 'edit') r.edited = 1 }
  const old = $('msgBody').querySelector(`tr[data-key="${CSS.escape(`${r.chat_jid}|${r.wa_msg_id}`)}"]`)
  old?.replaceWith(rowEl(r, true))
}

// ---------- status + stream ----------
const renderAll = () => {
  tz = status.tz || tz
  renderTop(); renderBanners(); renderLinkPanel(); renderGroups()
}
const refreshStatus = async () => { status = await api('/api/status'); renderAll() }

const connectStream = cursor => {
  es?.close()
  es = new EventSource(cursor ? `/api/stream?since=${cursor.msg}&sinceEvt=${cursor.evt}` : '/api/stream')
  es.addEventListener('open', () => {
    const wasDown = !streamOk
    streamOk = true
    $('liveInfo').textContent = '● Live'
    if (wasDown && status) { renderBanners(); if (view.groupId) loadView().catch(() => {}) } // resync after a drop
  })
  es.addEventListener('error', () => { streamOk = false; $('liveInfo').textContent = 'Reconnecting…'; if (status) renderBanners() })
  es.addEventListener('status', e => {
    const prevSession = group(view.groupId)?.session?.id
    status = JSON.parse(e.data)
    renderAll()
    const nowSession = group(view.groupId)?.session?.id
    if (view.groupId && view.tab === 'session' && !view.sessionId && prevSession !== nowSession) loadView().catch(() => {})
  })
  es.addEventListener('msg', e => { onMessage(JSON.parse(e.data)); renderGroups() })
  es.addEventListener('evt', e => onEvent(JSON.parse(e.data)))
}

// ---------- settings / actions ----------
let diagTimer = null
const loadDiag = async () => {
  const d = await api('/api/diagnostics')
  $('diagHealth').textContent = JSON.stringify({ ...d.health, journal: d.journal, auth: d.auth, process: d.process, mailerConfigured: d.mailerConfigured, alerts: d.alerts }, null, 2)
  $('diagCounters').textContent = JSON.stringify(d.counters, null, 2)
  $('diagGaps').textContent = d.gaps.map(g => `${fmtFull(g.started_at)} → ${g.ended_at ? fmtFull(g.ended_at) : 'open'}  ${g.cause}  ${g.status}${g.recovered_messages ? ` (${g.recovered_messages} recovered)` : ''}`).join('\n') || 'No gaps recorded.'
  $('diagLog').textContent = d.connectionLog.map(l => `${fmtFull(l.ts)}  ${l.state}${l.code ? ` [${l.code}]` : ''}  ${l.detail || ''}`).join('\n')
}
$('settingsBtn').onclick = () => {
  const s = $('settings')
  const open = s.classList.toggle('hidden') === false
  $('settingsBtn').setAttribute('aria-expanded', String(open))
  clearInterval(diagTimer)
  if (open) { loadDiag(); diagTimer = setInterval(loadDiag, 10_000); s.scrollIntoView({ behavior: 'smooth' }) }
}
const act = (btn, fn) => { btn.onclick = async () => { btn.disabled = true; try { await fn() } catch (e) { alert(e.message) } finally { btn.disabled = false } } }
act($('restartBtn'), () => post('/api/wa/restart'))
act($('resumeBtn'), () => post('/api/wa/resume'))
act($('showQrBtn'), () => post('/api/wa/show-qr'))
act($('recheckBtn'), () => post('/api/groups/recheck'))
act($('reloadBtn'), () => post('/api/config/reload'))
act($('backupBtn'), async () => { const m = await post('/api/backup'); alert(`Backup written (${m.created}).`) })
act($('unlinkBtn'), async () => {
  if (!await confirmAction({ title: 'Unlink WhatsApp?', text: 'This removes the logger from the phone’s Linked devices and wipes its keys. Capture stops until you scan a new QR, and messages sent in between can never be recovered.', word: 'UNLINK', button: 'Unlink' })) return
  await post('/api/wa/unlink', { confirm: 'UNLINK' })
})
act($('freshLinkBtn'), async () => {
  if (!await confirmAction({ title: 'Start a fresh link?', text: 'Wipes the stored WhatsApp keys (they are older than the rest of the data) and shows a new QR to scan. Messages sent before the new link completes cannot be recovered.', word: 'RELINK', button: 'Start fresh link' })) return
  await post('/api/wa/operator-relink', { confirm: 'RELINK' })
})
act($('signOutBtn'), async () => { await post('/api/auth/logout'); location.replace('/login.html') })

// live clocks (session timers, retry countdown)
setInterval(() => {
  document.querySelectorAll('[data-since]').forEach(n => { n.textContent = dur(Date.now() - Number(n.dataset.since)) })
  if (status?.connection.nextRetryAt) renderBanners()
}, 1000)

// ---------- boot ----------
;(async () => {
  const me = await api('/api/auth/me')
  $('userName').textContent = me.name || me.email
  status = await api('/api/status')
  renderAll()
  const first = status.groups.find(g => g.session) || status.groups.find(g => g.jid)
  // align the stream cursor with what the first page shows, so nothing falls between the two
  const cursor = first ? (await api(`/api/messages?group=${first.id}&limit=1`)).cursor : null
  if (first) selectGroup(first.id)
  connectStream(cursor)
})().catch(err => console.error(err))
