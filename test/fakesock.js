// Minimal stand-in for a Baileys socket: same ev.process contract, scripted connection updates.
// Boom-shaped errors (Baileys reads error.output.statusCode)
export const boom = (message, statusCode) => Object.assign(new Error(message), { output: { statusCode } });

export const makeFakeSocketFactory = ({ closeDelayMs = 0 } = {}) => {
  const sockets = [];
  const factory = (opts) => {
    let handler = null;
    let closed = false;
    const sock = {
      opts,
      ended: false,
      endedAt: null,
      user: { id: "919876543210:5@s.whatsapp.net", lid: "11111:5@lid", name: "Logger" },
      sent: [],
      ev: { process: (h) => { handler = h; } },
      emit: async (events) => handler && handler(events),
      // like Baileys: end() is async and the close event lands after the websocket has closed
      end: async (error) => {
        if (closed) return;
        closed = true;
        sock.ended = true;
        sock.endedAt = Date.now();
        if (closeDelayMs) await new Promise((r) => setTimeout(r, closeDelayMs));
        await handler?.({ "connection.update": { connection: "close", lastDisconnect: { error, date: new Date() } } });
      },
      close: (code, message = "closed") => sock.end(boom(message, code)),
      logout: async () => sock.end(boom("Intentional Logout", 401)),
      sendMessage: async (jid, content) => {
        if (closed) throw boom("Connection Closed", 428);
        sock.sent.push({ jid, content });
      },
      groupFetchAllParticipating: async () => sock.groups || {},
    };
    sockets.push(sock);
    return sock;
  };
  return { factory, sockets, last: () => sockets.at(-1), open: () => sockets.filter((s) => !s.ended) };
};
