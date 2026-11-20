import { API } from '../shared/protocol.js';

// noVNC attaches to a WebSocket-shaped raw channel. Its open handler
// must run after the ticket has been sent, not before.
export function createStreamChannel(ticket, openWebSocket) {
  const socket = openWebSocket(`${API}/stream`);
  if (!('binaryType' in socket)) {
    socket.close();
    throw new Error('Workspace Browser requires a binary WebSocket');
  }
  let bootstrapSent = false;
  let closing = false;
  const channel = {
    get readyState() {
      return !bootstrapSent && socket.readyState === WebSocket.OPEN ? WebSocket.CONNECTING : socket.readyState;
    },
    get protocol() { return socket.protocol; },
    get binaryType() { return socket.binaryType; },
    set binaryType(value) { socket.binaryType = value; },
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send(bytes) {
      if (!closing && bootstrapSent && ArrayBuffer.isView(bytes) && socket.readyState === WebSocket.OPEN) socket.send(bytes);
    },
    close() {
      closing = true;
      ticket = undefined;
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    },
  };
  socket.binaryType = 'arraybuffer';
  socket.onopen = (event) => {
    if (ticket === undefined || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ ticket }));
      bootstrapSent = true;
    } catch {
      channel.close();
      return;
    } finally {
      ticket = undefined;
    }
    channel.onopen?.(event);
  };
  socket.onmessage = (event) => {
    if (closing) return;
    if (bootstrapSent && event.data instanceof ArrayBuffer) channel.onmessage?.(event);
    else channel.close();
  };
  socket.onerror = (event) => channel.onerror?.(event);
  socket.onclose = (event) => {
    ticket = undefined;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    channel.onclose?.(event);
  };
  return channel;
}
