import assert from 'node:assert/strict';
import test from 'node:test';
import { watchWindowTitle, windowTitle } from './window-title.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('window titles become one printable, bounded line', () => {
  assert.equal(windowTitle('  GitHub \n Pull requests \u0007 '), 'GitHub   Pull requests');
  assert.equal(windowTitle(undefined), '');
  assert.equal(windowTitle(''), '');
  assert.equal(windowTitle('🌏'.repeat(600)), '🌏'.repeat(512));
  assert.equal(windowTitle('\u2028\u009f'), '');
});

async function run(titles, scheduled) {
  const frames = [];
  const release = watchWindowTitle({}, frame => frames.push(frame), async () => {
    if (!titles.length) throw new Error('no active window');
    return titles.shift();
  }, callback => { scheduled.push(callback); return scheduled.length; });
  for (let i = 0; i < 12; i++) {
    await flush();
    const next = scheduled.shift();
    if (!next) continue;
    await next();
  }
  return { frames, release };
}

test('the watcher publishes each change once and stops polling on release', async () => {
  const scheduled = [];
  const { frames, release } = await run(['First', 'First', 'Second', ''], scheduled);
  assert.deepEqual(frames, [
    { type: 'window-title', windowTitle: 'First' },
    { type: 'window-title', windowTitle: 'Second' },
    { type: 'window-title', windowTitle: '' },
  ]);
  release();
  await scheduled.shift()?.();
  assert.equal(scheduled.length, 0);
});

test('a failing X11 query neither publishes nor stops the watcher', async () => {
  const scheduled = [];
  const { frames, release } = await run([], scheduled);
  release();
  assert.deepEqual(frames, []);
});
