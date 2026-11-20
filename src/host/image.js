import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BrowserError } from '../shared/protocol.js';

const release = new URL('../../dist/', import.meta.url);
export const IMAGE_PLATFORM = 'linux/amd64';

export function parseImageManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3 ||
      !Object.hasOwn(value, 'imageId') || typeof value.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.imageId) ||
      !Object.hasOwn(value, 'platform') || value.platform !== IMAGE_PLATFORM || !Object.hasOwn(value, 'archiveSha256') ||
      typeof value.archiveSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.archiveSha256)) {
    throw new Error('Invalid runner image manifest');
  }
  return value;
}

export async function readImageManifest(dir = release) {
  const file = new URL('runner-image.json', dir);
  const info = await stat(file);
  if (!info.isFile() || info.size > 1024) throw new Error('Invalid runner image manifest');
  return parseImageManifest(JSON.parse(await readFile(file, 'utf8')));
}

export async function imageArchiveHash(path, signal) {
  const hash = createHash('sha256');
  const stream = createReadStream(path, { signal });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export function createImagePreparer(command, dir = release) {
  let loading;
  const unavailable = () => new BrowserError('runner_image_load_failed', 'Could not load the packaged Chromium image into the local Docker engine.', 503);
  const invalid = () => new BrowserError('runner_bundle_invalid', 'The packaged Chromium image is missing or invalid. Reinstall a complete browser bundle.', 503);

  async function prepare(admission) {
    const timeout = AbortSignal.timeout(240_000);
    const signal = AbortSignal.any([admission, timeout]);
    signal.throwIfAborted();
    const manifest = await readImageManifest(dir).catch(() => { throw invalid(); });
    await command(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], signal, 'engine').then(result => {
      if (result.code !== 0 || result.output.trim() !== IMAGE_PLATFORM) {
        throw new BrowserError('docker_engine_unavailable', 'A local Linux/amd64 Docker engine is required.', 503);
      }
    });
    const inspect = () => command(['image', 'inspect', '--format', '{{.Id}} {{.Os}}/{{.Architecture}}', manifest.imageId], signal, 'engine');
    const expected = `${manifest.imageId} ${manifest.platform}`;
    const cached = await inspect();
    signal.throwIfAborted();
    if (cached.code === 0) {
      if (cached.output.trim() === expected) return manifest.imageId;
      throw invalid();
    }
    const archive = fileURLToPath(new URL('runner-image.tar.gz', dir));
    const digest = await (async () => {
      const info = await stat(archive);
      if (!info.isFile() || !info.size) throw invalid();
      return imageArchiveHash(archive, signal);
    })().catch(() => { signal.throwIfAborted(); throw invalid(); });
    if (digest !== manifest.archiveSha256) throw invalid();
    const loaded = await command(['image', 'load', '--input', archive], signal, 'load');
    if (loaded.code !== 0) throw unavailable();
    const verified = await inspect();
    signal.throwIfAborted();
    if (verified.code !== 0 || verified.output.trim() !== expected) throw unavailable();
    return manifest.imageId;
  }
  return {
    get(signal) {
      if (!loading) loading = prepare(signal).catch(error => {
        if (error?.name === 'TimeoutError') throw unavailable();
        throw error;
      }).finally(() => { loading = undefined; });
      return loading;
    },
    async drain() { await loading?.catch(() => {}); },
  };
}
