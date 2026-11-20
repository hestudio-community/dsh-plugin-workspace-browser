import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PROJECT_ID } from '../src/shared/identity.js';
import { RUNNER_BUILD_FILES, runnerBuildArgs } from '../src/shared/runner-image.js';

const root = new URL('../', import.meta.url);
const runnerDir = fileURLToPath(new URL('runner/', root));
const dockerfile = fileURLToPath(new URL('runner/Dockerfile', root));
const releaseFiles = [
  'dist/client.js',
  'dist/client.js.LEGAL.txt',
  ...RUNNER_BUILD_FILES.map((name) => `runner/${name}`),
];

async function verify() {
  for (const name of releaseFiles) {
    const info = await stat(new URL(name, root)).catch((error) => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    });
    if (!info?.isFile() || !info.size) throw new Error(`Missing or empty release file: ${name}`);
  }
}

function build() {
  const result = spawnSync('docker', runnerBuildArgs(runnerDir, dockerfile), { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker build failed (${result.status ?? result.signal})`);
}

try {
  const [operation] = process.argv.slice(2);
  if (operation === 'verify') await verify();
  else if (operation === 'build') build();
  else throw new Error('Expected verify or build');
} catch (error) {
  console.error(`${PROJECT_ID} release: ${error.message}`);
  process.exitCode = 1;
}
