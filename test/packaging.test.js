import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';
import {
  IMAGE_PLATFORM, RUNNER_BUILD_FILES, RUNNER_IMAGE, RUNNER_PROTOCOL, RUNNER_PROTOCOL_LABEL,
  RUNNER_VERSION, RUNNER_VERSION_ARG, RUNNER_VERSION_LABEL, runnerBuildArgs, runnerImageTag,
} from '../src/shared/runner-image.js';

const runtimeFiles = ['automation.mjs', 'profile-recovery.mjs', 'protocol.mjs', 'proxy.mjs', 'runner.mjs', 'chromium.sh', 'openbox.xml'];
const buildFiles = ['Dockerfile', '.dockerignore', ...runtimeFiles];
const runner = new URL('../runner/', import.meta.url);

test('declares a DSH compatibility range instead of pinning one release', async () => {
  // DSH tests an own `engines.dsh` range as the plugin's only requirement and includes
  // prereleases, so an exact pin refused every later DSH release. The lower bound is the
  // oldest release the current code runs on; the upper bound fails closed on the next minor.
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const range = pkg.engines.dsh;
  assert.equal(range, '>=0.2.2-rc.3 <0.2.3-0');
  assert.ok(range.includes('>=') && range.includes('<'), 'engines.dsh must be a bounded range');
  assert.equal(pkg.engines.node, '>=22');

  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.packages[''].engines.dsh, range);
});

test('packages only the named runner inputs and client outputs, not image or release archives', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual([...pkg.files].sort(), [
    'src/host', 'src/shared', 'dist/client.js', 'dist/client.js.LEGAL.txt',
    ...buildFiles.map((name) => `runner/${name}`),
    'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'docs',
  ].sort());
  assert.equal(pkg.scripts.prepack, 'node scripts/runner-release.mjs verify');
  assert.equal(pkg.scripts['build:runner'], 'node scripts/runner-release.mjs build');
  assert.equal(Object.hasOwn(pkg.scripts, 'bundle:runner'), false);
});

test('Docker context, COPY and protocol metadata match the shared build contract', async () => {
  assert.deepEqual([...RUNNER_BUILD_FILES].sort(), [...buildFiles].sort());
  assert.equal(IMAGE_PLATFORM, 'linux/amd64');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(RUNNER_VERSION, pkg.version);
  assert.equal(RUNNER_IMAGE, `dsh-plugin-workspace-browser-runner:v${pkg.version.replace('+', '_')}`);
  assert.equal(RUNNER_PROTOCOL, '1');
  assert.equal(RUNNER_PROTOCOL_LABEL, 'dev.dsh.dsh-plugin-workspace-browser.runner-protocol');
  assert.equal(RUNNER_VERSION_LABEL, 'dev.dsh.dsh-plugin-workspace-browser.plugin-version');

  const ignore = (await readFile(new URL('.dockerignore', runner), 'utf8')).trim().split(/\r?\n/);
  assert.equal(ignore[0], '*');
  assert.deepEqual(ignore.slice(1).sort(), buildFiles.map((name) => `!${name}`).sort());

  const dockerfile = (await readFile(new URL('Dockerfile', runner), 'utf8')).split(/\r?\n/);
  assert.deepEqual(dockerfile.filter((line) => /^\s*COPY\b/i.test(line)), [`COPY ${runtimeFiles.join(' ')} ./`]);
  assert.equal(dockerfile.some((line) => /^\s*ADD\b/i.test(line)), false);
  assert.ok(dockerfile.includes(`LABEL ${RUNNER_PROTOCOL_LABEL}="${RUNNER_PROTOCOL}"`));
  const versionArg = dockerfile.indexOf(`ARG ${RUNNER_VERSION_ARG}`);
  const versionLabel = dockerfile.indexOf(`LABEL ${RUNNER_VERSION_LABEL}="\${${RUNNER_VERSION_ARG}}"`);
  assert.ok(versionArg > dockerfile.findLastIndex(line => /^(?:RUN|COPY)\b/.test(line)));
  assert.ok(versionLabel > versionArg);
  for (const name of buildFiles) {
    const info = await stat(new URL(name, runner));
    assert.ok(info.isFile() && info.size > 0, `${name} must be a nonempty file`);
  }
});

test('strict SemVer maps losslessly to Docker-safe tags and enforces the tag length limit', () => {
  const repository = 'dsh-plugin-workspace-browser-runner';
  const maxVersion = `1.2.3+${'a'.repeat(121)}`;
  const valid = [
    ['0.1.3', 'v0.1.3'], ['1.2.3-rc.2', 'v1.2.3-rc.2'],
    ['1.2.3-rc.2+commit.ABC.01', 'v1.2.3-rc.2_commit.ABC.01'],
    ['1.2.3-01a.0', 'v1.2.3-01a.0'], [maxVersion, `v${maxVersion.replace('+', '_')}`],
  ];
  for (const [version, tag] of valid) assert.equal(runnerImageTag(version), `${repository}:${tag}`);
  for (const value of [undefined, 123, '', 'v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2', '1.2.3-01',
    '1.2.3-a.01', '1.2.3-a..b', '1.2.3-', '1.2.3+', '1.2.3+foo+bar', '1.2.3+foo_bar', '1.2.3\n',
    '1.2.3/rc', `${maxVersion}a`]) {
    assert.throws(() => runnerImageTag(value), /Invalid Runner package version/);
  }
});

test('shared build arguments pass the exact version separately from the mapped Docker tag', async () => {
  const version = '1.2.3-rc.2+commit.1';
  assert.deepEqual(runnerBuildArgs('/user path/runner', '/user path/runner/Dockerfile', version), [
    'build', '--platform', 'linux/amd64', '--tag', 'dsh-plugin-workspace-browser-runner:v1.2.3-rc.2_commit.1',
    '--build-arg', `DSH_PLUGIN_VERSION=${version}`, '--file', '/user path/runner/Dockerfile', '/user path/runner',
  ]);
  assert.ok(runnerBuildArgs('/runner', '/runner/Dockerfile').includes(`DSH_PLUGIN_VERSION=${RUNNER_VERSION}`));
  const script = await readFile(new URL('../scripts/runner-release.mjs', import.meta.url), 'utf8');
  assert.match(script, /spawnSync\('docker', runnerBuildArgs\(runnerDir, dockerfile\),/);
});
