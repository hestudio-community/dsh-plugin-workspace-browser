import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROJECT_ID } from '../src/shared/identity.js';
import { RUNNER_BUILD_FILES, runnerBuildArgs, runnerPlatform } from '../src/shared/runner-image.js';
import { dockerCommand } from '../src/host/runner.js';

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

export function build({ host = process, execute = spawnSync } = {}) {
  const docker = dockerCommand({}, host);
  const executable = host.platform === 'darwin' ? docker.executable : 'docker';
  const options = { env: docker.env, cwd: host.platform === 'win32' ? (host.env.SystemRoot || 'C:\\Windows') : '/', windowsHide: true };
  const info = execute(executable, ['--host', docker.endpoint, 'info', '--format', '{{.OSType}}/{{.Architecture}}'], { ...options, encoding: 'utf8', timeout: 10_000 });
  if (info.error) throw info.error;
  const platform = info.status === 0 && runnerPlatform(info.stdout.trim());
  if (!platform) throw new Error('A local Linux/amd64 or Linux/arm64 Docker engine is required');
  const result = execute(executable, ['--host', docker.endpoint, ...runnerBuildArgs(runnerDir, dockerfile, undefined, platform)], { ...options, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Docker build failed (${result.status ?? result.signal})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [operation] = process.argv.slice(2);
    if (operation === 'verify') await verify();
    else if (operation === 'build') build();
    else throw new Error('Expected verify or build');
  } catch (error) {
    console.error(`${PROJECT_ID} release: ${error.message}`);
    process.exitCode = 1;
  }
}
