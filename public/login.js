const $ = id => document.getElementById(id)
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`)
  return data
}
const showError = msg => { $('error').textContent = msg || '' }
let email = ''
let cooldown = 0

const tickCooldown = () => {
  const b = $('resendBtn')
  b.disabled = cooldown > 0
  b.textContent = cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'
  if (cooldown > 0) { cooldown--; setTimeout(tickCooldown, 1000) }
}

const send = async () => {
  showError('')
  $('sendBtn').disabled = true
  try {
    await post('/api/auth/request-otp', { email })
    $('sentTo').textContent = email
    $('emailForm').classList.add('hidden')
    $('codeForm').classList.remove('hidden')
    $('code').value = ''
    $('code').focus()
    cooldown = 60; tickCooldown()
  } catch (err) { showError(err.message) } finally { $('sendBtn').disabled = false }
}

$('emailForm').addEventListener('submit', e => {
  e.preventDefault()
  email = $('email').value.trim().toLowerCase()
  if (!email) return showError('Enter your email')
  send()
})
$('codeForm').addEventListener('submit', async e => {
  e.preventDefault()
  showError('')
  $('verifyBtn').disabled = true
  try {
    await post('/api/auth/verify-otp', { email, code: $('code').value })
    location.replace('/')
  } catch (err) { showError(err.message); $('code').select() } finally { $('verifyBtn').disabled = false }
})
$('code').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6)
  if (e.target.value.length === 6) $('codeForm').requestSubmit()
})
$('resendBtn').addEventListener('click', send)
$('haveCodeBtn').addEventListener('click', () => {
  email = $('email').value.trim().toLowerCase()
  if (!email) return showError('Enter your email first')
  showError('')
  $('sentTo').textContent = email
  $('emailForm').classList.add('hidden')
  $('codeForm').classList.remove('hidden')
  $('code').focus()
})
$('backBtn').addEventListener('click', () => {
  showError('')
  $('codeForm').classList.add('hidden')
  $('emailForm').classList.remove('hidden')
  $('email').focus()
})
