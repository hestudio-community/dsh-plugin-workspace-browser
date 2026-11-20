import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { IMAGE_PLATFORM, imageArchiveHash, parseImageManifest, readImageManifest } from '../src/host/image.js';

const distURL = new URL('../dist/', import.meta.url);
const dist = fileURLToPath(distURL);
const exec = promisify(execFile);

async function bundle(tag) {
  const { stdout } = await exec('docker', ['image', 'inspect', '--format', '{{.Id}} {{.Os}}/{{.Architecture}}', tag], { timeout: 10_000 });
  const [imageId, platform] = stdout.trim().split(' ');
  parseImageManifest({ imageId, platform, archiveSha256: '0'.repeat(64) });
  await mkdir(dist, { recursive: true });
  const staging = await mkdtemp(join(dist, '.runner-release-'));
  try {
    const archive = join(staging, 'runner-image.tar.gz');
    const child = spawn('docker', ['image', 'save', imageId], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    const saved = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => code === 0 ? resolve() : reject(new Error('docker image save failed')));
    });
    const compressed = pipeline(child.stdout, createGzip(), createWriteStream(archive, { flags: 'wx' }));
    const timer = setTimeout(() => child.kill(), 300_000);
    try { await Promise.all([saved, compressed]); }
    catch (error) {
      child.kill();
      await Promise.allSettled([saved, compressed]);
      throw error;
    } finally { clearTimeout(timer); }
    const archiveSha256 = await imageArchiveHash(archive);
    const manifest = join(staging, 'runner-image.json');
    await writeFile(manifest, `${JSON.stringify({ imageId, platform: IMAGE_PLATFORM, archiveSha256 }, null, 2)}\n`);
    await rename(archive, join(dist, 'runner-image.tar.gz'));
    await rename(manifest, join(dist, 'runner-image.json'));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function verify() {
  for (const name of ['client.js', 'client.js.LEGAL.txt', 'runner-image.tar.gz']) {
    const info = await stat(join(dist, name));
    if (!info.isFile() || !info.size) throw new Error(`Missing or empty release file: ${name}`);
  }
  const manifest = await readImageManifest(distURL);
  if (await imageArchiveHash(join(dist, 'runner-image.tar.gz')) !== manifest.archiveSha256) {
    throw new Error('Runner image archive does not match the manifest');
  }
}

const [operation, tag] = process.argv.slice(2);
try {
  if (operation === 'verify') await verify();
  else if (operation === 'bundle' && /^dsh-workspace-browser-runner:[a-zA-Z0-9_.-]+$/.test(tag)) await bundle(tag);
  else throw new Error('Expected verify or bundle with a local Runner tag');
} catch (error) {
  console.error(`Workspace Browser release: ${error.message}`);
  process.exitCode = 1;
}
