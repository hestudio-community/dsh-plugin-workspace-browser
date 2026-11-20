import { admissionMessage, environmentMessage, post } from './http.js';
import { settings } from './settings-styles.js';

const STATUS_MS = 2000;
const checkLabels = new Map([
  ['dockerConfig', 'environmentDockerConfig'],
  ['dockerCli', 'environmentDockerCli'],
  ['dockerEngine', 'environmentDockerEngine'],
  ['runnerImage', 'environmentRunnerImage'],
]);
const checkIds = [...checkLabels.keys()];
const checkStatuses = new Map([
  ['pass', 'environmentCheckPass'],
  ['fail', 'environmentCheckFail'],
  ['skipped', 'environmentCheckSkipped'],
]);
const buildStates = new Set(['idle', 'building', 'succeeded', 'failed']);
const initialState = { loadingBuild: true };
const errorMessage = (code) => admissionMessage(code) ?? environmentMessage(code);

function versionFrom(result) {
  if (typeof result.runnerVersion !== 'string' || !result.runnerVersion.trim()) throw new Error('Invalid runner version');
  return result.runnerVersion;
}

function isBusy(state) {
  return state.loadingBuild || state.checking || state.build === 'building';
}

function buildAction(state) {
  const checks = state.checks;
  if (!checks || checks.slice(0, 3).some(row => row.status !== 'pass') || checks[3].status !== 'fail') return;
  if (checks[3].code === 'runner_image_missing') return 'environmentBuildButton';
  if (checks[3].code === 'runner_image_incompatible') return 'environmentRebuildButton';
}

function startEnvironmentSettings(onChange) {
  const controller = new AbortController();
  const { signal } = controller;
  let state = initialState;
  let timer;

  function update(patch) {
    state = { ...state, ...patch };
    onChange(state);
  }

  async function check() {
    if (signal.aborted || isBusy(state)) return;
    update({ checking: true, checkError: undefined });
    try {
      const result = await post('/environment/check', {}, signal);
      if (signal.aborted) return;
      const runnerVersion = versionFrom(result);
      const { checks } = result;
      if (!Array.isArray(checks) || checks.length !== checkIds.length || !checks.every((row, i) =>
        row?.id === checkIds[i] && checkStatuses.has(row.status))) throw new Error('Invalid environment checks');
      update({ checking: false, checks, runnerVersion });
    } catch (error) {
      if (!signal.aborted) update({ checking: false, checks: undefined, checkError: errorMessage(error?.code) ?? 'environmentCheckError' });
    }
  }

  async function readBuild(path, errorKey) {
    try {
      const result = await post(path, {}, signal);
      if (signal.aborted) return;
      const runnerVersion = versionFrom(result);
      if (!buildStates.has(result.state)) throw new Error('Invalid build status');
      update({
        runnerVersion, loadingBuild: false, build: result.state,
        ...(state.runnerVersion && state.runnerVersion !== runnerVersion ? { checks: undefined, checkError: undefined } : {}),
        buildError: result.state === 'failed' ? (errorMessage(result.code) ?? 'runnerBuildFailed') : undefined,
      });
      if (result.state === 'succeeded') await check();
      else if (result.state === 'building') timer = setTimeout(refreshStatus, STATUS_MS);
    } catch (error) {
      if (!signal.aborted) update({ loadingBuild: false, build: 'unknown', buildError: errorMessage(error?.code) ?? errorKey });
    }
  }

  function refreshStatus() {
    return readBuild('/environment/build/status', 'environmentBuildStatusError');
  }

  function retryStatus() {
    if (signal.aborted || isBusy(state) || state.build !== 'unknown') return;
    update({ loadingBuild: true, buildError: undefined });
    return refreshStatus();
  }

  function build() {
    if (signal.aborted || isBusy(state) || state.build === 'unknown' || !buildAction(state)) return;
    update({ loadingBuild: true, buildError: undefined, checkError: undefined });
    return readBuild('/environment/build', 'environmentBuildRequestError');
  }

  onChange(state);
  void refreshStatus();
  return { check, build, retryStatus, dispose() { clearTimeout(timer); controller.abort(); } };
}

export function makeEnvironmentSettings(React) {
  const { createElement: h, useId, useLayoutEffect, useRef, useState } = React;
  return function EnvironmentSettings({ t }) {
    const helpId = useId();
    const active = useRef(null);
    const checkButton = useRef(null);
    const rememberedFocus = useRef(null);
    const [state, setState] = useState(initialState);
    useLayoutEffect(() => {
      const controller = startEnvironmentSettings(setState);
      active.current = controller;
      return () => {
        active.current = null;
        controller.dispose();
      };
    }, []);

    const { loadingBuild, checking, checks, checkError, build, buildError, runnerVersion } = state;
    const busy = isBusy(state);
    const buildLabel = buildAction(state);
    useLayoutEffect(() => {
      if (buildLabel || !rememberedFocus.current) return;
      const previouslyFocused = rememberedFocus.current;
      rememberedFocus.current = null;
      const doc = previouslyFocused.ownerDocument;
      if (doc.activeElement === previouslyFocused || doc.activeElement === doc.body) checkButton.current?.focus();
    }, [buildLabel]);

    const checkNotice = checking ? 'environmentChecking' : checks
      ? (checks.every(row => row.status === 'pass') ? 'environmentReady' : 'environmentCheckComplete') : null;
    const buildNotice = loadingBuild ? 'environmentBuildLoading'
      : build === 'building' ? 'environmentBuilding' : build === 'succeeded' ? 'environmentBuildSucceeded' : null;
    const action = (key, label, disabled, onClick, extra) => h('button', {
      key, ...extra, type: 'button', className: settings.button, 'aria-disabled': disabled || undefined,
      onClick: () => { if (!disabled) return onClick(); },
    }, t(label));
    return h('section', { 'aria-label': t('environmentHeading'), className: settings.section },
      h('h2', { className: settings.heading }, t('environmentHeading')),
      h('div', { className: settings.row }, h('div', { className: settings.copy },
        runnerVersion ? h('p', { className: settings.version }, t('environmentRunnerVersion'), ': ', h('code', null, runnerVersion)) : null,
        h('p', { id: helpId, className: settings.detail }, t('environmentBuildHelp')),
        h('div', { className: settings.actions },
          action('check', checks ? 'environmentRecheckButton' : 'environmentCheckButton', busy, () => active.current?.check(), { ref: checkButton }),
          buildLabel ? action('build', build === 'failed' ? 'environmentRetryBuildButton' : buildLabel,
            busy || build === 'unknown', () => active.current?.build(), {
              'aria-describedby': helpId,
              onFocus: (event) => { rememberedFocus.current = event.currentTarget; },
              onBlur: () => { rememberedFocus.current = null; },
            }) : null,
          build === 'unknown' ? action('retry', 'environmentRetryStatusButton', busy, () => active.current?.retryStatus()) : null),
        h('div', { role: 'status', className: settings.status },
          buildNotice ? h('div', null, t(buildNotice)) : null,
          checkNotice ? h('div', null, t(checkNotice)) : null),
        buildError ? h('p', { className: settings.error, role: 'alert' }, t(buildError)) : null,
        checkError ? h('p', { className: settings.error, role: 'alert' }, t(checkError)) : null)),
      checks ? h('ul', { className: settings.list, role: 'list' }, checks.map(({ id, status, code }) => {
        const problem = environmentMessage(code);
        return h('li', { className: settings.row, key: id }, h('div', { className: settings.copy }, t(checkLabels.get(id)),
          problem ? h('div', { className: settings.detail }, t(problem)) : null),
        h('span', { className: settings.result }, t(checkStatuses.get(status))));
      })) : null);
  };
}
