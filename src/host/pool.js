import { randomBytes, randomUUID } from 'node:crypto';
import { BrowserError, validId } from '../shared/protocol.js';

const TICKET_MS = 15_000;
const IDLE_MS = 120_000;
const MAX_INSTANCES = 4;
const MAX_TICKETS = 32;
const MAX_VIEWS = 4;
const startupCodes = new Set([
  'docker_cli_missing', 'docker_config_invalid', 'docker_engine_unavailable', 'runner_bundle_invalid',
  'runner_image_load_failed', 'runner_start_failed', 'runner_start_timeout', 'runner_isolation_failed',
  'runner_display_failed', 'runner_profile_recovery_failed', 'runner_profile_in_use', 'runner_unavailable',
]);

const missingSession = () => new BrowserError('session_workspace_missing', 'The session does not belong to a unique registered workspace.', 404);
const browserClosed = () => new BrowserError('browser_closed', 'The workspace browser has closed. Open a new browser to continue.', 409);
const generationChanged = () => new BrowserError('browser_generation_changed', 'The workspace browser has changed. Refresh its status and try again.', 409);
const unavailable = () => new BrowserError('plugin_unavailable', 'The browser plugin is stopping.', 503);
const startupFailure = () => new BrowserError('runner_start_failed', 'Chromium runner could not start.', 503);

export function createPool(registry, startRunner) {
  const rooms = new Map();
  const stopping = new Set();
  const tickets = new Map();
  let closed = false;

  function findSession(sessionId) {
    if (!validId(sessionId)) return null;
    const matches = registry.list().filter((row) => row.sessionIds.includes(sessionId));
    if (matches.length !== 1 || !validId(matches[0].id)) return null;
    const row = registry.get(matches[0].id);
    return row?.id === matches[0].id && row.sessionIds.includes(sessionId) ? row : null;
  }

  function invalidate(room, sessionId) {
    if (sessionId === undefined) {
      for (const id of room.permissions.keys()) invalidate(room, id);
      return;
    }
    const grant = room.permissions.get(sessionId);
    if (!grant) return;
    room.permissions.delete(sessionId);
    grant.abort();
  }

  function syncSeats(room) {
    for (const seat of room.seats) {
      if (!seat.isCurrent()) {
        room.seats.delete(seat);
        room.lastUsed = Date.now();
        seat.onClose();
      }
    }
    const owner = room.seats.values().next().value;
    for (const seat of room.seats) {
      const enabled = seat === owner;
      if (enabled === seat.resizeOwner) continue;
      seat.resizeOwner = enabled;
      seat.onResizeOwner(enabled);
    }
  }

  function detach(room) {
    for (const [key, ticket] of tickets) if (ticket.room === room) tickets.delete(key);
    invalidate(room);
    room.busy = null;
    const seats = [...room.seats];
    room.seats.clear();
    for (const seat of seats) seat.onClose();
  }

  function stopAttempt(attempt) {
    // The barrier also covers closing a replacement that has not been spawned yet.
    return attempt.stopping ??= Promise.resolve().then(async () => {
      if (attempt.prior) await stopAttempt(attempt.prior);
      await attempt.runner?.stop();
    }).catch((error) => {
      attempt.stopping = undefined;
      throw error;
    });
  }

  function retire(room) {
    if (room.closing) return room.closing;
    if (rooms.get(room.id) === room) rooms.delete(room.id);
    room.state = 'closed';
    room.attempt.reject(browserClosed());
    const cleanup = room.closing = stopAttempt(room.attempt);
    stopping.add(room);
    const done = () => stopping.delete(room);
    cleanup.then(done, done);
    detach(room);
    return cleanup;
  }

  function start(room, previous) {
    const { promise: ready, resolve, reject } = Promise.withResolvers();
    ready.catch(() => {});
    const restarting = previous !== undefined;
    const attempt = { generation: randomUUID(), ready, reject, prior: previous?.runner ? previous : previous?.prior };
    room.attempt = attempt;
    room.state = restarting ? 'restarting' : 'starting';
    room.lastUsed = Date.now();
    room.code = undefined;
    if (restarting) detach(room);

    const isCurrent = () => !closed && rooms.get(room.id) === room && room.attempt === attempt;
    const fail = (error) => {
      if (!isCurrent() || room.state === 'failed') return;
      if (room.state === 'ready') { retire(room); return; }
      const failure = error instanceof BrowserError && startupCodes.has(error.code) ? error : startupFailure();
      reject(failure);
      if (!restarting) { retire(room); return; }
      room.state = 'failed';
      invalidate(room);
      room.code = failure.code;
      room.lastUsed = Date.now();
      if (attempt.runner) stopAttempt(attempt).catch(() => {});
    };
    const launch = () => {
      if (!isCurrent()) return;
      attempt.prior = undefined;
      if (!registry.get(room.id)) { retire(room); return; }
      try {
        // Runner callbacks can fire before startRunner returns. Finish installing the attempt first.
        const runner = attempt.runner = startRunner(room.id, (error) => queueMicrotask(() => fail(error)));
        Promise.resolve(runner.ready).then(() => {
          if (!isCurrent() || room.state === 'failed') return;
          room.state = 'ready';
          room.lastUsed = Date.now();
          resolve();
        }, fail);
      } catch (error) { fail(error); }
    };
    if (attempt.prior) stopAttempt(attempt.prior).then(launch, fail);
    else if (restarting) queueMicrotask(launch);
    else launch();
  }

  function requireRoom(id) {
    if (closed) throw unavailable();
    let room = rooms.get(id);
    if (!room) {
      if (rooms.size + stopping.size >= MAX_INSTANCES || [...stopping].some((entry) => entry.id === id)) {
        throw new BrowserError('runner_limit', 'The runner is stopping or the browser instance limit has been reached. Retry shortly.', 503);
      }
      room = { id, runId: randomUUID(), seats: new Set(), permissions: new Map(), busy: null };
      rooms.set(id, room);
      start(room);
    }
    return room;
  }

  function boundRoom(id, runId, generation) {
    const room = rooms.get(id);
    if (closed) throw unavailable();
    if (!room || room.runId !== runId) throw browserClosed();
    if (room.attempt.generation !== generation) throw generationChanged();
    return room;
  }

  function snapshot(room) {
    return { state: room.state, generation: room.attempt.generation, ...(room.state === 'failed' ? { code: room.code } : {}) };
  }

  function sweep() {
    const now = Date.now();
    for (const [key, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(key);
    for (const room of rooms.values()) {
      if (!registry.get(room.id)) { retire(room); continue; }
      syncSeats(room);
      if ((room.state === 'ready' || room.state === 'failed') && !room.seats.size && now - room.lastUsed > IDLE_MS) {
        retire(room);
        continue;
      }
      for (const sessionId of room.permissions.keys()) {
        if (findSession(sessionId)?.id !== room.id) invalidate(room, sessionId);
      }
    }
  }
  const timer = setInterval(sweep, 1000);
  timer.unref?.();

  return {
    findSession,
    invalidate,
    invalidateAll() {
      for (const room of rooms.values()) invalidate(room);
    },
    current: (id) => rooms.get(id),
    async issue(sessionId, peerId, runId, generation) {
      const id = findSession(sessionId)?.id;
      if (!id) throw runId === undefined ? missingSession() : browserClosed();
      const room = runId === undefined ? requireRoom(id) : boundRoom(id, runId, generation);
      const attempt = room.attempt;
      if (room.state === 'failed') return { runId: room.runId, ...snapshot(room) };
      await attempt.ready;
      if (findSession(sessionId)?.id !== id) {
        if (runId !== undefined) throw browserClosed();
        throw new BrowserError('session_workspace_changed', 'The session workspace changed while opening the browser. Retry from the session.', 409);
      }
      boundRoom(id, room.runId, attempt.generation);
      room.lastUsed = Date.now();
      if (tickets.size >= MAX_TICKETS) throw new BrowserError('view_limit', 'Too many outstanding view requests. Retry shortly.', 429);
      const key = randomBytes(32).toString('base64url');
      tickets.set(key, { room, attempt, sessionId, peerId, expiresAt: Date.now() + TICKET_MS });
      return { ticket: key, runId: room.runId, generation: attempt.generation };
    },
    status(sessionId, runId) {
      const room = rooms.get(findSession(sessionId)?.id);
      return room && room.runId === runId ? snapshot(room) : { state: 'closed' };
    },
    restart(sessionId, runId, generation) {
      const room = boundRoom(findSession(sessionId)?.id, runId, generation);
      if (room.state !== 'ready' && room.state !== 'failed') {
        throw new BrowserError('browser_busy', 'The workspace browser is already starting. Retry shortly.', 409);
      }
      start(room, room.attempt);
      return snapshot(room);
    },
    close(sessionId, runId, generation) {
      const room = boundRoom(findSession(sessionId)?.id, runId, generation);
      retire(room);
      return { state: 'closed' };
    },
    redeem(key, peerId, { onResizeOwner = () => {}, onClose = () => {} } = {}) {
      const entry = typeof key === 'string' && tickets.get(key);
      if (closed || !entry || entry.peerId !== peerId) return null;
      tickets.delete(key);
      const { room, attempt, sessionId } = entry;
      if (entry.expiresAt <= Date.now() || rooms.get(room.id) !== room || room.attempt !== attempt ||
          room.state !== 'ready' || findSession(sessionId)?.id !== room.id) return null;
      syncSeats(room);
      if (room.seats.size >= MAX_VIEWS) return null;
      const seat = {
        sessionId, runner: attempt.runner, onResizeOwner, onClose,
        isCurrent: () => !closed && rooms.get(room.id) === room && room.attempt === attempt && room.seats.has(seat) &&
          findSession(sessionId)?.id === room.id,
        release() {
          if (!room.seats.delete(seat)) return;
          room.lastUsed = Date.now();
          syncSeats(room);
        },
      };
      room.seats.add(seat);
      room.lastUsed = Date.now();
      syncSeats(room);
      return seat;
    },
    async dispose() {
      closed = true;
      clearInterval(timer);
      tickets.clear();
      await Promise.allSettled([...rooms.values(), ...stopping].map(retire));
    },
  };
}
