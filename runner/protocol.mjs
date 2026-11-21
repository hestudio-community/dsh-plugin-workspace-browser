import { stdin, stdout } from 'node:process';

export const MAX_CHUNK = 32 * 1024;
export const MAX_FRAME = 256 * 1024;
const MAX_OUTBOX = 4 * 1024 * 1024;
const LF = 10;
const decoder = new TextDecoder('utf-8', { fatal: true });
const schemas = new Map([
  ['rfb-open', ['id']],
  ['rfb', ['id', 'data']],
  ['rfb-close', ['id']],
  ['net-opened', ['id', 'ok']],
  ['net-data', ['id', 'data']],
  ['net-close', ['id']],
  ['clipboard', ['id', 'request']],
  ['clipboard-cancel', ['id']],
  ['clipboard-release', ['id']],
  ['automation', ['id', 'request']],
  ['automation-cancel', ['id']],
]);

function readFrame(bytes) {
  const frame = JSON.parse(decoder.decode(bytes));
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('Invalid frame');
  const keys = schemas.get(frame.type);
  if (!keys || Object.keys(frame).length !== keys.length + 1 || keys.some(key => !Object.hasOwn(frame, key)) ||
      typeof frame.id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(frame.id)) throw new Error('Invalid frame');
  if (keys.includes('ok') && typeof frame.ok !== 'boolean') throw new Error('Invalid tunnel status');
  if (keys.includes('data')) {
    if (typeof frame.data !== 'string' || frame.data.length > 4 * Math.ceil(MAX_CHUNK / 3)) throw new Error('Invalid payload');
    const data = Buffer.from(frame.data, 'base64');
    if (!data.length || data.length > MAX_CHUNK || data.toString('base64') !== frame.data) throw new Error('Invalid payload');
    frame.data = data;
  }
  return frame;
}

export function readFrames(onFrame, onEnd) {
  // Never buffer an unbounded unterminated line; decode only after finding LF.
  const line = Buffer.allocUnsafe(MAX_FRAME - 1); // Reserve one byte for LF.
  let length = 0;
  stdin.on('data', chunk => {
    try {
      for (let start = 0; start < chunk.length;) {
        const lf = chunk.indexOf(LF, start);
        const end = lf === -1 ? chunk.length : lf;
        if (length + end - start > line.length) throw new Error('Oversized frame');
        chunk.copy(line, length, start, end);
        length += end - start;
        if (lf !== -1) {
          onFrame(readFrame(line.subarray(0, length)));
          length = 0;
        }
        start = lf === -1 ? end : lf + 1;
      }
    } catch {
      stdin.pause();
      onEnd('invalid host frame');
    }
  });
  stdin.once('end', () => onEnd(length ? 'truncated host frame' : undefined));
  stdin.once('error', () => onEnd('host input failed'));
  stdout.once('error', () => onEnd('host output failed'));
}

export function send(frame, callback) {
  const line = Buffer.from(`${JSON.stringify(frame)}\n`);
  if (line.length > MAX_FRAME || stdout.writableLength + line.length > MAX_OUTBOX) {
    // Loss of framing/backpressure ordering is fatal rather than silently dropping bytes.
    process.stderr.write('runner: host output limit exceeded\n');
    process.exit(1);
  }
  return stdout.write(line, callback);
}

export function sendChunk(type, id, chunk) {
  let writable = true;
  for (let i = 0; i < chunk.length; i += MAX_CHUNK) {
    if (!send({ type, id, data: chunk.subarray(i, i + MAX_CHUNK).toString('base64') })) writable = false;
  }
  return writable;
}
