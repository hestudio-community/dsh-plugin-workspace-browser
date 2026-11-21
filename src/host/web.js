import { WebSocketServer } from 'ws';
import { normalizeWebOrigin } from '../shared/web-origin.js';
import { PROJECT_ID } from '../shared/identity.js';
import { API, BrowserError, DESKTOP_REQUEST_HEADER, DESKTOP_REQUEST_VERSION, RESIZE_OWNER, validId } from '../shared/protocol.js';

const WS_LIMIT = 1024 * 1024;
const BODY_LIMIT = 4096;
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const sessionFields = ['sessionId'];
const controlFields = ['sessionId', 'runId', 'generation'];
const methods = {
  '/view': [sessionFields, controlFields],
  '/browser/status': [['sessionId', 'runId']], '/browser/restart': [controlFields], '/browser/close': [controlFields],
  '/agent/status': [sessionFields], '/agent/grant': [sessionFields], '/agent/revoke': [sessionFields],
  '/environment/check': [[]], '/environment/build': [[]], '/environment/build/status': [[]],
};

function localOrigin(req) {
  const remote = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return null;
  const host = req.headers.host;
  if (typeof host !== 'string') return null;
  try {
    const url = new URL(`${req.socket.encrypted ? 'https' : 'http'}://${host}`);
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password && url.host === host) return url.origin;
  } catch { /* Invalid authority. */ }
  return null;
}

function isJsonRequest(req) {
  const type = req.headers['content-type'];
  return typeof type === 'string' && /^application\/json(?:;|$)/i.test(type);
}

function configuredOrigins(entries) {
  const origins = new Set();
  for (const entry of entries) {
    const origin = normalizeWebOrigin(entry);
    if (!origin) throw new TypeError('allowedWebOrigins entries must be exact HTTP(S) origins, for example https://dsh.example.com.');
    origins.add(origin);
  }
  return origins;
}

function admit(connection, req, allowedOrigins, allowDesktopPost = false) {
  const expected = localOrigin(req);
  const origin = req.headers.origin;
  // Desktop's owned-Host forwarder removes Origin and Sec-Fetch-Site and attaches its auth cookie.
  // The marker requires a preflight from other web origins; it does not authenticate the caller.
  const desktopPost = allowDesktopPost && origin === undefined && req.headers['sec-fetch-site'] === undefined &&
    req.method === 'POST' && req.headers[DESKTOP_REQUEST_HEADER] === DESKTOP_REQUEST_VERSION && isJsonRequest(req);
  if (!(expected && (origin === expected || desktopPost)) && !allowedOrigins.has(origin)) {
    throw new BrowserError('origin_denied', `Open ${PROJECT_ID} from local DSH Web, a configured DSH Web origin, or the main DSH Desktop window.`, 403);
  }
  const admission = connection.admit({ headers: req.headers });
  if ('rejection' in admission || admission.peer.id !== connection.browserPeer.id || admission.peer.principal.kind !== 'owner') {
    throw new BrowserError('access_denied', 'Sign in to DSH on this computer first.', admission.rejection || 403);
  }
  return admission.peer;
}

function respond(res, status, data) {
  if (res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

async function body(req, shapes) {
  if (!isJsonRequest(req)) {
    throw new BrowserError('invalid_content_type', 'Expected a JSON request.', 415);
  }
  if (Number(req.headers['content-length']) > BODY_LIMIT) throw new BrowserError('invalid_body', 'Request body is too large.', 413);
  const buffers = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new BrowserError('invalid_body', 'Request body is too large.', 413);
    buffers.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw new BrowserError('invalid_body', 'Invalid JSON request.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !shapes.some((keys) =>
      Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key) &&
        typeof value[key] === 'string' &&
        (key !== 'runId' && key !== 'generation' || validId(value[key]))))) {
    throw new BrowserError('invalid_body', 'Unexpected request fields.');
  }
  return value;
}

function rejectUpgrade(socket, status) {
  const name = status === 401 ? 'Unauthorized' : status === 503 ? 'Service Unavailable' : 'Forbidden';
  socket.end(`HTTP/1.1 ${status} ${name}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function registerWeb(ctx, pool, agent, environment, allowedWebOrigins = []) {
  const allowedOrigins = configuredOrigins(allowedWebOrigins);
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: WS_LIMIT, perMessageDeflate: false, clientTracking: false });
  const connections = new Set();
  const disposers = [];
  let stopped = false;

  const handle = (path, fields) => async (req, res) => {
    try {
      if (stopped) throw new BrowserError('plugin_unavailable', 'The browser plugin is stopping.', 503);
      const peer = admit(ctx.connection, req, allowedOrigins, true);
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new BrowserError('invalid_method', 'Expected POST.', 405);
      }
      const value = await body(req, fields);
      if (stopped || res.destroyed || peer.signal.aborted) return;
      const { sessionId, runId, generation } = value;
      let result = {};
      switch (path) {
        case '/view': result = await pool.issue(sessionId, peer.id, runId, generation); break;
        case '/browser/status': result = pool.status(sessionId, runId); break;
        case '/browser/restart': result = pool.restart(sessionId, runId, generation); break;
        case '/browser/close': result = pool.close(sessionId, runId, generation); break;
        case '/agent/status': result = agent.status(sessionId); break;
        case '/agent/grant': result = agent.grant(sessionId); break;
        case '/agent/revoke': result = agent.revoke(sessionId); break;
        case '/environment/check': result = await environment.check(); break;
        case '/environment/build': result = environment.startBuild(); break;
        case '/environment/build/status': result = environment.buildStatus(); break;
      }
      respond(res, 200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof BrowserError) respond(res, error.status, { ok: false, code: error.code, message: error.message });
      else {
        ctx.logger?.warn(`${PROJECT_ID}: unexpected failure handling %s`, path);
        respond(res, 500, { ok: false, code: 'internal_error', message: 'The workspace browser could not complete the request.' });
      }
    }
  };

  const upgrade = (req, socket, head) => {
    if (stopped || connections.size >= 32) { rejectUpgrade(socket, 503); return; }
    let peer;
    try { peer = admit(ctx.connection, req, allowedOrigins); }
    catch (error) { rejectUpgrade(socket, error.status || 403); return; }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      let stream;
      let seat;
      let alive = true;
      const terminate = () => ws.terminate();
      const expiry = setTimeout(terminate, 4000);
      expiry.unref?.();
      const heartbeat = setInterval(() => {
        if (!alive || (seat && !seat.isCurrent())) { terminate(); return; }
        alive = false;
        if (ws.readyState === 1) ws.ping();
      }, 15_000);
      heartbeat.unref?.();
      connections.add(ws);
      ws.on('error', terminate);
      ws.on('pong', () => { alive = true; });
      peer.signal.addEventListener('abort', terminate, { once: true });
      ws.once('close', () => {
        clearTimeout(expiry);
        clearInterval(heartbeat);
        connections.delete(ws);
        peer.signal.removeEventListener('abort', terminate);
        stream?.close();
        seat?.release();
      });
      ws.on('message', (data, binary) => {
        if (peer.signal.aborted || stopped) { terminate(); return; }
        if (seat) {
          if (!binary || !seat.isCurrent() || !stream?.send(data)) terminate();
          return;
        }
        if (binary || data.length > 128) { terminate(); return; }
        let first;
        try { first = JSON.parse(data.toString()); } catch { terminate(); return; }
        if (!first || typeof first.ticket !== 'string' || !TICKET_PATTERN.test(first.ticket)) { terminate(); return; }
        seat = pool.redeem(first.ticket, peer.id, {
          onResizeOwner(enabled) {
            if (ws.readyState !== 1 || ws.bufferedAmount > WS_LIMIT * 2) { terminate(); return; }
            ws.send(JSON.stringify({ type: RESIZE_OWNER, enabled }), { binary: false }, (error) => { if (error) terminate(); });
          },
          onClose: terminate,
        });
        if (!seat) { terminate(); return; }
        clearTimeout(expiry);
        stream = seat.runner.attach({
          send(bytes) {
            if (!seat.isCurrent() || ws.readyState !== 1 || ws.bufferedAmount > WS_LIMIT * 2) { terminate(); return; }
            ws.send(bytes, { binary: true }, (error) => { if (error) terminate(); });
          },
          close: terminate,
        });
      });
    });
  };

  function dispose() {
    stopped = true;
    for (const drop of disposers.splice(0).reverse()) drop();
    for (const ws of connections) ws.terminate();
    wsServer.close();
  }

  try {
    for (const [path, fields] of Object.entries(methods)) {
      disposers.push(ctx.webServer.register({ kind: 'exact', path: `${API}${path}`, handler: handle(path, fields) }));
    }
    disposers.push(ctx.webServer.registerUpgrade({ path: `${API}/stream`, handler: upgrade }));
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
