import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { stdout } from 'node:process';
import { Duplex, pipeline } from 'node:stream';
import { send, sendChunk } from './protocol.mjs';

const MAX_TUNNELS = 64;
const MAX_QUEUE = 256 * 1024;
const CONNECT_TIMEOUT = 10_000;
const IDLE_TIMEOUT = 60_000;
const HOP_HEADERS = [
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect',
];

const authorityHost = '(?:\\[[0-9a-f:.]+\\]|[^:/?#@\\[\\]]+)';
const httpAuthority = new RegExp(`^http://${authorityHost}(?::([0-9]{1,5}))?(?=[/?]|$)`, 'i');
const connectAuthority = new RegExp(`^${authorityHost}:([0-9]{1,5})$`, 'i');
const invalidTarget = /[\\#\x00-\x20\x7f]/;

function hostname(url) {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

// The absolute URL, never a request header, selects a plain HTTP destination.
export function httpTarget(target) {
  if (typeof target !== 'string' || invalidTarget.test(target)) return null;
  const authority = httpAuthority.exec(target);
  if (!authority) return null;
  const port = Number(authority[1] ?? 80);
  if (port < 1 || port > 65535) return null;
  try {
    const url = new URL(target);
    return { host: hostname(url), authority: url.host, path: url.pathname + url.search, port };
  } catch {
    return null;
  }
}

export function connectTarget(target) {
  if (typeof target !== 'string' || invalidTarget.test(target)) return null;
  const authority = connectAuthority.exec(target);
  if (!authority) return null;
  const port = Number(authority[1]);
  if (port < 1 || port > 65535) return null;
  try {
    const url = new URL(`https://${target}`);
    return { host: hostname(url), port };
  } catch {
    return null;
  }
}

function endToEndHeaders(headers) {
  const excluded = new Set([...HOP_HEADERS, ...String(headers.connection ?? '').toLowerCase().split(/\s*,\s*/)]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name) && !name.startsWith('proxy-')));
}

// This stream has no real outbound socket. Its peer is the Host tunnel identified
// in the stdio protocol. Bounded buffers fail closed if the peer cannot drain them.
class Tunnel extends Duplex {
  constructor(id, chunkToHost) {
    super({ allowHalfOpen: false });
    this.id = id;
    this.chunkToHost = chunkToHost;
    this.hostClosed = false;
    this.pendingWrite = undefined;
    this.timer = undefined;
    this.timeout = 0;
  }

  _read() {}

  _write(chunk, _encoding, done) {
    if (this.hostClosed) return done(new Error('Tunnel closed'));
    this.touch();
    if (this.chunkToHost('net-data', this.id, chunk)) return done();
    const drained = () => {
      this.pendingWrite = undefined;
      done();
    };
    this.pendingWrite = { drained, done };
    stdout.once('drain', drained);
  }

  _destroy(error, done) {
    clearTimeout(this.timer);
    if (this.pendingWrite) {
      stdout.off('drain', this.pendingWrite.drained);
      const write = this.pendingWrite;
      this.pendingWrite = undefined;
      write.done(error ?? new Error('Tunnel closed'));
    }
    done(error);
  }

  receive(chunk) {
    if (this.readableLength + chunk.length > MAX_QUEUE) this.destroy(new Error('Tunnel buffer limit exceeded'));
    else {
      this.touch();
      this.push(chunk);
    }
  }

  eof() {
    this.hostClosed = true;
    this.push(null);
  }

  setTimeout(timeout, callback) {
    if (callback) this.once('timeout', callback);
    this.timeout = timeout;
    this.touch();
    return this;
  }

  touch() {
    clearTimeout(this.timer);
    if (this.timeout) this.timer = setTimeout(() => this.emit('timeout'), this.timeout).unref();
  }
}

export async function createProxy(frameToHost = send, chunkToHost = sendChunk) {
  const tunnels = new Map();

  function open(target, client, callback) {
    if (tunnels.size >= MAX_TUNNELS) return callback(null);
    const id = randomUUID();
    const stream = new Tunnel(id, chunkToHost);
    let pending = callback;
    function settle(value) {
      if (!pending) return;
      const finish = pending;
      pending = undefined;
      clearTimeout(timer);
      finish(value);
    }
    const timer = setTimeout(() => stream.destroy(), CONNECT_TIMEOUT).unref();
    const cancel = () => stream.destroy();
    client.once('close', cancel);
    stream.on('error', () => {}); // No peer-specific error text is logged.
    stream.once('close', () => {
      tunnels.delete(id);
      client.off('close', cancel);
      if (!stream.hostClosed) frameToHost({ type: 'net-close', id });
      settle(null);
    });
    tunnels.set(id, {
      stream,
      opened: false,
      accept(ok) {
        if (!pending || stream.destroyed) return;
        if (!ok) {
          stream.hostClosed = true;
          stream.destroy();
          return;
        }
        this.opened = true;
        stream.once('timeout', cancel).setTimeout(IDLE_TIMEOUT);
        settle(stream);
      },
    });
    frameToHost({ type: 'net-open', id, host: target.host, port: target.port });
  }

  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: IDLE_TIMEOUT, headersTimeout: CONNECT_TIMEOUT }, (incoming, outgoing) => {
    const target = httpTarget(incoming.url);
    outgoing.setHeader('connection', 'close');
    const transferEncoding = incoming.headers['transfer-encoding'];
    if (!target || (transferEncoding && transferEncoding.toLowerCase() !== 'chunked')) {
      outgoing.writeHead(400).end();
      return;
    }
    const fail = () => {
      if (outgoing.destroyed || outgoing.writableEnded) return;
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(502).end();
    };
    open(target, incoming.socket, tunnel => {
      if (!tunnel) return fail();
      const headers = endToEndHeaders(incoming.headers);
      headers.host = target.authority;
      headers.connection = 'close';
      if (incoming.headers['content-length'] !== undefined) headers['content-length'] = incoming.headers['content-length'];
      if (transferEncoding) headers['transfer-encoding'] = 'chunked';
      const upstream = request({
        method: incoming.method,
        path: target.path,
        headers,
        createConnection: () => tunnel,
      }, response => {
        if (outgoing.destroyed) return tunnel.destroy();
        outgoing.writeHead(response.statusCode, { ...endToEndHeaders(response.headers), connection: 'close' });
        pipeline(response, outgoing, () => tunnel.destroy());
      });
      upstream.on('error', fail);
      upstream.on('upgrade', (_response, socket) => { socket.destroy(); fail(); });
      incoming.on('error', () => upstream.destroy());
      incoming.pipe(upstream);
    });
  });
  server.maxConnections = MAX_TUNNELS;
  server.maxRequestsPerSocket = 1;
  server.on('connect', (incoming, socket, head) => {
    socket.pause();
    socket.on('error', () => {});
    // Upgraded HTTP sockets can stay half-open after a client disconnects.
    socket.once('end', () => socket.destroy());
    const target = connectTarget(incoming.url);
    if (!target) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    open(target, socket, tunnel => {
      if (!tunnel) {
        if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        return;
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) tunnel.write(head);
      socket.pipe(tunnel, { end: false });
      pipeline(tunnel, socket, () => socket.destroy());
    });
  });
  server.on('upgrade', (_incoming, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    address: `http://127.0.0.1:${server.address().port}`,
    handle(frame) {
      const tunnel = tunnels.get(frame.id);
      if (!tunnel) return;
      if (frame.type === 'net-opened') tunnel.accept(frame.ok);
      if (frame.type === 'net-data' && tunnel.opened && !tunnel.stream.hostClosed) tunnel.stream.receive(frame.data);
      if (frame.type === 'net-close') {
        if (tunnel.opened) tunnel.stream.eof();
        else tunnel.accept(false);
      }
    },
    close() {
      server.close();
      server.closeAllConnections();
      for (const tunnel of tunnels.values()) tunnel.stream.destroy();
    },
  };
}
