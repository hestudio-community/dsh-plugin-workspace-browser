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
checkLabels.set('rootBrowserAccount', 'rootAccountHeading');
checkLabels.set('workspaceAclTools', 'environmentAclTools');
const checkStatuses = new Map([
  ['pass', 'environmentCheckPass'],
  ['fail', 'environmentCheckFail'],
  ['skipped', 'environmentCheckSkipped'],
  ['warn', 'environmentCheckWarn'],
]);
const checkTags = new Map([
  ['pass', settings.tagPass],
  ['fail', settings.tagFail],
  ['skipped', settings.tagSkipped],
  ['warn', settings.tagSkipped],
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

// A finished build clears the checks it ran under, so its failure keeps its own
// retry action instead of waiting for a recheck to restore one. A later recheck
// that passes the image withdraws it.
function buildRetry(state) {
  if (state.build !== 'failed') return;
  if (state.checks?.slice(0, checkIds.length).every(row => row.status === 'pass')) return;
  return 'environmentRetryBuildButton';
}

function canRequestBuild(state) {
  return buildAction(state) !== undefined || buildRetry(state) !== undefined;
}

function validChecks(rows) {
  if (!Array.isArray(rows) || ![4, 6].includes(rows.length) || !checkIds.every((id, i) =>
    rows[i]?.id === id && ['pass', 'fail', 'skipped'].includes(rows[i].status))) return false;
  if (rows.length === 4) return true;
  const [, , , , accountRow, toolsRow] = rows;
  const account = accountRow?.account;
  return accountRow?.id === 'rootBrowserAccount' && (accountRow.status === 'fail' ||
    (accountRow.status === 'pass' && typeof account?.name === 'string' && Number.isInteger(account.uid) && Number.isInteger(account.gid))) &&
    toolsRow?.id === 'workspaceAclTools' && ['pass', 'warn'].includes(toolsRow.status);
}

function startEnvironmentSettings(onChange, checkOnly) {
  const controller = new AbortController();
  const { signal } = controller;
  let state = checkOnly ? { loadingBuild: false } : initialState;
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
      if (!validChecks(checks)) throw new Error('Invalid environment checks');
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
    if (signal.aborted || isBusy(state) || state.build === 'unknown' || !canRequestBuild(state)) return;
    update({ loadingBuild: true, buildError: undefined, checkError: undefined });
    return readBuild('/environment/build', 'environmentBuildRequestError');
  }

  onChange(state);
  if (checkOnly) return { check, dispose() { controller.abort(); } };
  void refreshStatus();
  return { check, build, retryStatus, dispose() { clearTimeout(timer); controller.abort(); } };
}

export function makeInlineEnvironmentCheck(React) {
  return makeEnvironmentSettings(React, true);
}

export function makeEnvironmentSettings(React, checkOnly = false) {
  const { createElement: h, useId, useLayoutEffect, useRef, useState } = React;
  return function EnvironmentSettings({ t }) {
    const helpId = useId();
    const active = useRef(null);
    const checkButton = useRef(null);
    const rememberedFocus = useRef(null);
    const [state, setState] = useState(checkOnly ? { loadingBuild: false } : initialState);
    useLayoutEffect(() => {
      const controller = startEnvironmentSettings(setState, checkOnly);
      active.current = controller;
      return () => {
        active.current = null;
        controller.dispose();
      };
    }, []);

    const { loadingBuild, checking, checks, checkError, build, buildError, runnerVersion } = state;
    const busy = isBusy(state);
    const building = build === 'building';
    // A running build outranks everything else, and a failed one offers its own
    // retry: both states outlive the checks that cleared when the build ran.
    const buildLabel = checkOnly ? undefined : building ? 'environmentBuildingButton'
      : buildRetry(state) ?? buildAction(state);
    const buildDisabled = busy || build === 'unknown';
    useLayoutEffect(() => {
      if (buildLabel || !rememberedFocus.current) return;
      const previouslyFocused = rememberedFocus.current;
      rememberedFocus.current = null;
      const doc = previouslyFocused.ownerDocument;
      if (doc.activeElement === previouslyFocused || doc.activeElement === doc.body) checkButton.current?.focus();
    }, [buildLabel]);

    // The check rows below already say pass or fail, so a completed check keeps only
    // its in-progress line; a finished build keeps only its success line.
    const buildNotice = loadingBuild ? 'environmentBuildLoading'
      : build === 'building' ? 'environmentBuilding' : build === 'succeeded' ? 'environmentBuildSucceeded' : null;
    const action = (key, label, variant, disabled, onClick, extra) => h('button', {
      key, ...extra, type: 'button', className: `${settings.button} ${variant}`, 'aria-disabled': disabled || undefined,
      onClick: () => { if (!disabled) return onClick(); },
    }, t(label));
    return h('section', { 'aria-label': t('environmentHeading'), className: settings.section },
      h('h2', { className: settings.heading }, t('environmentHeading')),
      h('div', { className: settings.card, 'aria-busy': building || undefined },
        h('div', { className: settings.copy },
          runnerVersion ? h('p', { className: settings.version }, t('environmentRunnerVersion'), ': ', h('code', null, runnerVersion)) : null,
          checkOnly ? null : h('p', { id: helpId, className: settings.detail }, t('environmentBuildHelp')),
          h('div', { className: settings.actions },
            action('check', checks ? 'environmentRecheckButton' : 'environmentCheckButton', settings.buttonOutline,
              busy, () => active.current?.check(), { ref: checkButton }),
            buildLabel ? h('button', {
              key: 'build', type: 'button',
              className: `${settings.button} ${building ? settings.buttonProgress : settings.buttonPrimary}`,
              'aria-disabled': buildDisabled || undefined,
              'aria-busy': building || undefined, 'aria-describedby': helpId,
              onClick: () => { if (!buildDisabled) return active.current?.build(); },
              onFocus: (event) => { rememberedFocus.current = event.currentTarget; },
              onBlur: () => { rememberedFocus.current = null; },
            }, building ? h('span', { className: settings.spinner, 'aria-hidden': true }) : null,
            t(buildLabel)) : null,
            build === 'unknown' ? action('retry', 'environmentRetryStatusButton', settings.buttonOutline,
              busy, () => active.current?.retryStatus()) : null),
          h('div', { role: 'status', className: settings.status },
            buildNotice ? h('div', null, t(buildNotice)) : null,
            checking ? h('div', null, t('environmentChecking')) : null),
          buildError ? h('p', { className: settings.error, role: 'alert' }, t(buildError)) : null,
          checkError ? h('p', { className: settings.error, role: 'alert' }, t(checkError)) : null)),
      checks ? h('ul', { className: settings.list, role: 'list' }, checks.map(({ id, status, code, account }) => {
        const problem = environmentMessage(code);
        return h('li', { className: `${settings.card} ${settings.row}`, key: id }, h('div', { className: settings.copy }, t(checkLabels.get(id)),
          id === 'rootBrowserAccount' && status === 'pass' ? h('code', { className: settings.detail }, `${account.name} (UID ${account.uid}, GID ${account.gid})`) : null,
          problem ? h('div', { className: settings.detail }, t(problem)) : null),
        h('span', { className: `${settings.tag} ${checkTags.get(status)}` }, t(checkStatuses.get(status))));
      })) : null);
  };
}
