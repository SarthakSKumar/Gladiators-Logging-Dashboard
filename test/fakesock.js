// Minimal stand-in for a Baileys socket: same ev.process contract, scripted connection updates.
// Boom-shaped errors (Baileys reads error.output.statusCode)
export const boom = (message, statusCode) => Object.assign(new Error(message), { output: { statusCode } })

export const makeFakeSocketFactory = () => {
  const sockets = []
  const factory = opts => {
    let handler = null
    let closed = false
    const sock = {
      opts,
      user: { id: '919876543210:5@s.whatsapp.net', lid: '11111:5@lid', name: 'Logger' },
      sent: [],
      ev: { process: h => { handler = h } },
      emit: async events => handler && handler(events),
      end: async error => {
        if (closed) return
        closed = true
        await handler?.({ 'connection.update': { connection: 'close', lastDisconnect: { error, date: new Date() } } })
      },
      close: code => sock.end(boom('closed', code)),
      logout: async () => sock.end(boom('Intentional Logout', 401)),
      sendMessage: async (jid, content) => { sock.sent.push({ jid, content }) },
      groupFetchAllParticipating: async () => sock.groups || {}
    }
    sockets.push(sock)
    return sock
  }
  return { factory, sockets, last: () => sockets.at(-1) }
}
