import pkg from '../../package.json' with { type: 'json' };
import { PROJECT_ID } from './identity.js';

export const RUNNER_PROTOCOL = '4';
export const RUNNER_PROTOCOL_LABEL = `dev.dsh.${PROJECT_ID}.runner-protocol`;
export const RUNNER_VERSION = pkg.version;
export const RUNNER_VERSION_LABEL = `dev.dsh.${PROJECT_ID}.plugin-version`;
export const RUNNER_VERSION_ARG = 'DSH_PLUGIN_VERSION';
export const IMAGE_PLATFORM = 'linux/amd64';

export function runnerPlatform(value) {
  if (value === 'linux/amd64' || value === 'linux/x86_64') return 'linux/amd64';
  if (value === 'linux/arm64' || value === 'linux/aarch64') return 'linux/arm64';
  return null;
}

const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function runnerImageTag(version) {
  if (typeof version !== 'string' || version.length > 127) throw new Error('Invalid Runner package version');
  const match = semver.exec(version);
  if (match?.[0] !== version || match[4]?.split('.').some(id => /^0[0-9]+$/.test(id))) {
    throw new Error('Invalid Runner package version');
  }
  return `${PROJECT_ID}-runner:v${version.replace('+', '_')}`;
}

export const RUNNER_IMAGE = runnerImageTag(RUNNER_VERSION);

export function runnerBuildArgs(context, dockerfile, version = RUNNER_VERSION, platform = IMAGE_PLATFORM) {
  if (!runnerPlatform(platform) || runnerPlatform(platform) !== platform) throw new Error('Invalid Runner platform');
  return ['build', '--platform', platform, '--tag', runnerImageTag(version),
    '--build-arg', `${RUNNER_VERSION_ARG}=${version}`, '--build-arg', `DSH_RUNNER_PROTOCOL=${RUNNER_PROTOCOL}`, '--file', dockerfile, context];
}

// Basenames relative to the packaged runner/ build context.
export const RUNNER_BUILD_FILES = Object.freeze([
  'Dockerfile',
  '.dockerignore',
  'automation.mjs',
  'clipboard.mjs',
  'identity.mjs',
  'network-isolation.mjs',
  'profile-recovery.mjs',
  'protocol.mjs',
  'proxy.mjs',
  'runner.mjs',
  'window-title.mjs',
  'chromium.sh',
  'openbox.xml',
]);
