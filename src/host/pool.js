import { randomBytes } from 'node:crypto';
import { BrowserError, validId } from '../shared/protocol.js';

const TICKET_MS = 15_000;
const IDLE_MS = 120_000;
const MAX_INSTANCES = 4;
const MAX_TICKETS = 32;
const MAX_VIEWS = 4;

const missingWorkspace = () => new BrowserError('workspace_missing', 'The workspace is no longer registered.', 404);

export function createPool(registry, startRunner) {
  const rooms = new Map();
  const stopping = new Set();
  const tickets = new Map();
  let closed = false;

  function workspace(id) {
    const row = validId(id) && registry.get(id);
    if (!row) throw missingWorkspace();
    return row;
  }

  function findSession(sessionId) {
    if (!validId(sessionId)) return null;
    const matches = registry.list().filter((row) => row.sessionIds.includes(sessionId));
    if (matches.length !== 1 || !validId(matches[0].id)) return null;
    const row = registry.get(matches[0].id);
    return row?.id === matches[0].id && row.sessionIds.includes(sessionId) ? row : null;
  }

  function invalidate(room) {
    room.grantRevision = (room.grantRevision ?? 0) + 1;
    room.access?.controller.abort();
    room.access = null;
    room.snapshot = null;
    room.pending?.decide(false);
  }

  function remove(room) {
    if (rooms.get(room.id) === room) rooms.delete(room.id);
    for (const [key, ticket] of tickets) if (ticket.room === room) tickets.delete(key);
    invalidate(room);
  }

  function retire(room) {
    remove(room);
    if (room.closing) return room.closing;
    room.closing = Promise.resolve().then(() => room.runner.stop());
    stopping.add(room);
    const done = () => stopping.delete(room);
    room.closing.then(done, done);
    return room.closing;
  }

  function requireRoom(id) {
    if (closed) throw new BrowserError('plugin_unavailable', 'The browser plugin is stopping.', 503);
    let room = rooms.get(id);
    if (!room) {
      if (rooms.size + stopping.size >= MAX_INSTANCES || [...stopping].some((entry) => entry.id === id)) {
        throw new BrowserError('runner_limit', 'The runner is stopping or the browser instance limit has been reached. Retry shortly.', 503);
      }
      room = { id, views: 0, busy: false, lastUsed: Date.now(), access: null, pending: null, snapshot: null };
      room.runner = startRunner(id, () => void retire(room));
      rooms.set(id, room);
    }
    room.lastUsed = Date.now();
    return room;
  }

  function sweep() {
    const now = Date.now();
    for (const [key, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(key);
    for (const room of rooms.values()) {
      if (!registry.get(room.id) || (!room.views && !room.busy && now - room.lastUsed > IDLE_MS)) {
        void retire(room);
        continue;
      }
      if (room.access && (room.access.expiresAt <= now || findSession(room.access.sessionId)?.id !== room.id)) invalidate(room);
    }
  }
  const timer = setInterval(sweep, 1000);
  timer.unref?.();

  return {
    workspace,
    findSession,
    invalidate,
    invalidateAll() {
      for (const room of rooms.values()) invalidate(room);
    },
    current: (id) => rooms.get(id),
    async issue(sessionId, peerId) {
      const id = findSession(sessionId)?.id;
      if (!id) throw new BrowserError('session_workspace_missing', 'The session does not belong to a unique registered workspace.', 404);
      const room = requireRoom(id);
      await room.runner.ready;
      if (findSession(sessionId)?.id !== id) {
        throw new BrowserError('session_workspace_changed', 'The session workspace changed while opening the browser. Retry from the session.', 409);
      }
      if (closed || rooms.get(id) !== room) throw new BrowserError('runner_unavailable', 'The runner stopped. Reopen the browser to retry.', 503);
      room.lastUsed = Date.now();
      if (tickets.size >= MAX_TICKETS) throw new BrowserError('view_limit', 'Too many outstanding view requests. Retry shortly.', 429);
      const key = randomBytes(32).toString('base64url');
      tickets.set(key, { room, sessionId, peerId, expiresAt: Date.now() + TICKET_MS });
      return key;
    },
    redeem(key, peerId) {
      const entry = typeof key === 'string' && tickets.get(key);
      if (closed || !entry || entry.peerId !== peerId) return null;
      tickets.delete(key);
      const { room, sessionId } = entry;
      const isCurrent = () => !closed && rooms.get(room.id) === room && findSession(sessionId)?.id === room.id;
      if (entry.expiresAt <= Date.now() || !isCurrent() || room.views >= MAX_VIEWS) return null;
      room.views++;
      let released = false;
      return {
        runner: room.runner,
        isCurrent,
        release() {
          if (released) return;
          released = true;
          room.views--;
          room.lastUsed = Date.now();
          if (!room.views) invalidate(room);
        },
      };
    },
    async dispose() {
      closed = true;
      clearInterval(timer);
      tickets.clear();
      await Promise.allSettled([...rooms.values(), ...stopping].map(retire));
    },
  };
}
