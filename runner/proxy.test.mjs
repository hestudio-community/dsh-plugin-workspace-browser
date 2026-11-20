import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import { createProxy, connectTarget, httpTarget } from './proxy.mjs';

function readResponse(address, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(address);
    const req = request({ hostname, port, path: target, headers }, res => {
      const buffers = [];
      res.on('data', part => buffers.push(part));
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(buffers).toString() }));
    });
    req.once('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Test proxy timed out')));
    req.end();
  });
}

async function hostFixture(t, produce) {
  const opens = [];
  let transmitted = '';
  let answered = false;
  const proxy = await createProxy(frame => {
    if (frame.type === 'net-open') {
      opens.push(frame);
      queueMicrotask(() => proxy.handle({ type: 'net-opened', id: frame.id, ok: true }));
    }
    return true;
  }, (type, id, data) => {
    assert.equal(type, 'net-data');
    transmitted += data.toString();
    const reply = produce(transmitted);
    if (!answered && reply) {
      answered = true;
      queueMicrotask(() => {
        proxy.handle({ type: 'net-data', id, data: Buffer.from(reply) });
        proxy.handle({ type: 'net-close', id });
      });
    }
    return true;
  });
  t.after(() => proxy.close());
  return { address: proxy.address, opens, sent: () => transmitted };
}

test('validates destination forms without opening any sockets', () => {
  assert.deepEqual(httpTarget('http://EXAMPLE.com:80/a?q=1'), { host: 'example.com', authority: 'example.com', path: '/a?q=1', port: 80 });
  for (const target of ['/path', '//example.com/', 'http:///example.com/', 'https://example.com/', 'http://example.com:8080/',
    'http://user@example.com/', 'http://@example.com/', 'http://example.com\\x', 'http://example.com/#fragment']) {
    assert.equal(httpTarget(target), null, target);
  }
  assert.deepEqual(connectTarget('example.com:443'), { host: 'example.com', port: 443 });
  for (const target of ['https://example.com:443', 'example.com:80', 'example.com', 'example.com:443/path', 'user@example.com:443']) {
    assert.equal(connectTarget(target), null, target);
  }
});

test('absolute HTTP target selects tunnel, rewrites origin-form and strips hop headers', { timeout: 5000 }, async t => {
  const host = await hostFixture(t, wire => wire.includes('\r\n\r\n') &&
    'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close, X-Response-Private\r\nX-Response-Private: removed\r\n\r\nOK');
  const result = await readResponse(host.address, 'http://public.example/path?q=1', {
    Host: 'wrong.example',
    'Proxy-Authorization': 'not-forwarded',
    'Proxy-Connection': 'keep-alive',
    Connection: 'X-Private',
    'X-Private': 'not-forwarded',
  });
  assert.deepEqual(host.opens.map(({ host, port }) => ({ host, port })), [{ host: 'public.example', port: 80 }]);
  assert.match(host.sent(), /^GET \/path\?q=1 HTTP\/1\.1\r\n/i);
  assert.match(host.sent(), /\r\nhost: public\.example\r\n/i);
  assert.doesNotMatch(host.sent(), /wrong\.example|proxy-|x-private/i);
  assert.equal(result.status, 200);
  assert.equal(result.text, 'OK');
  assert.equal(result.headers['x-response-private'], undefined);
});

test('CONNECT carries opaque bytes in both directions and preserves bytes before Host EOF', { timeout: 5000 }, async t => {
  const host = await hostFixture(t, wire => wire === 'mock-client-hello' && 'mock-server-hello');
  const { hostname, port } = new URL(host.address);
  const socket = connect({ host: hostname, port: Number(port) });
  t.after(() => socket.destroy());
  socket.setTimeout(2000, () => socket.destroy(new Error('Test tunnel timed out')));
  const received = [];
  socket.on('data', part => received.push(part));
  const done = once(socket, 'end');
  socket.write('CONNECT public.example:443 HTTP/1.1\r\nHost: wrong.example:443\r\n\r\nmock-client-hello');
  await done;
  assert.deepEqual(host.opens.map(({ host, port }) => ({ host, port })), [{ host: 'public.example', port: 443 }]);
  assert.equal(host.sent(), 'mock-client-hello');
  assert.equal(Buffer.concat(received).toString(), 'HTTP/1.1 200 Connection Established\r\n\r\nmock-server-hello');
});

test('invalid origin-form request fails without asking Host for a tunnel', { timeout: 5000 }, async t => {
  const host = await hostFixture(t, () => false);
  assert.equal((await readResponse(host.address, '/internal', { Host: 'public.example' })).status, 400);
  assert.deepEqual(host.opens, []);
});
