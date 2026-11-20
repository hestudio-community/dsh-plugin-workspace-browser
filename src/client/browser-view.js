import { makeAgentAccess } from './agent-access.js';
import { admissionMessage, post } from './http.js';
import { createStreamChannel } from './stream.js';
import { control, fill, overlay, viewport } from './styles.js';

const HANDSHAKE_MS = 30_000;
const STATUS_MS = 2000;
const MIN_RESIZE_WIDTH = 200;
const MIN_RESIZE_HEIGHT = 120;
const requestMessages = new Map([
  ['session_workspace_missing', 'sessionWorkspaceMissing'],
  ['session_workspace_changed', 'sessionWorkspaceChanged'],
  ['runner_unavailable', 'runnerUnavailable'],
  ['docker_cli_missing', 'dockerCliMissing'],
  ['docker_config_invalid', 'dockerConfigInvalid'],
  ['docker_engine_unavailable', 'dockerEngineUnavailable'],
  ['runner_bundle_invalid', 'runnerBundleInvalid'],
  ['runner_image_load_failed', 'runnerImageLoadFailed'],
  ['runner_isolation_failed', 'runnerIsolationFailed'],
  ['runner_profile_in_use', 'runnerProfileInUse'],
  ['runner_profile_recovery_failed', 'runnerProfileRecoveryFailed'],
  ['runner_display_failed', 'runnerDisplayFailed'],
  ['runner_start_failed', 'runnerStartFailed'],
  ['runner_start_timeout', 'runnerStartTimeout'],
  ['plugin_unavailable', 'pluginUnavailable'],
  ['runner_limit', 'browserBusy'],
  ['view_limit', 'browserBusy'],
  ['browser_busy', 'browserBusy'],
  ['browser_generation_changed', 'browserGenerationChanged'],
]);
const message = (code) => admissionMessage(code) ?? requestMessages.get(code) ?? 'requestFailed';
const token = (value) => typeof value === 'string' && value.length > 0;

// The panel's logical run outlives a visible display. Status is authoritative;
// retiring a display or aborting a DSH tab occurrence never sends a close RPC.
export function createBrowserConnection({ sessionId, tabSignal, target, RFB, openWebSocket, onClosed, onChange }) {
  let visible = false;
  let closed = false;
  let runId;
  let generation;
  let runState;
  let phase = 'starting';
  let actionError;
  let viewRequest;
  let statusRequest;
  let statusTimer;
  let action;
  let display;
  let wantDisplay = false;
  let opened = false;
  let disposed = tabSignal.aborted;

  function publish() {
    if (!disposed) onChange({
      phase, actionError,
      canRestart: !action && (runState === 'ready' || runState === 'failed'),
      canClose: !action && !!generation && !closed,
      canRetry: !action && !closed && (runState === 'failed' || (!display && !viewRequest
        && !['starting', 'connecting', 'restarting'].includes(phase))),
      retryLabel: runState === 'ready' ? 'reconnect' : 'retry',
    });
  }
  function stopDisplayRequest() {
    viewRequest?.abort();
    viewRequest = undefined;
  }
  function stopDisplay() {
    const active = display;
    display = undefined;
    active?.dispose();
  }
  function stopStatus() {
    clearTimeout(statusTimer);
    statusRequest?.abort();
    statusRequest = undefined;
  }
  function retire() {
    if (disposed || closed) return;
    closed = true;
    stopStatus();
    stopDisplayRequest();
    stopDisplay();
    phase = 'browserClosed';
    publish();
    onClosed();
  }
  function applyStatus(result) {
    const { state, generation: next } = result;
    if (state === 'closed') return retire();
    if (!['starting', 'ready', 'restarting', 'failed'].includes(state)
      || (state !== 'failed' && !token(next))) throw new Error('Invalid browser status');
    if (token(next) && generation !== next) {
      generation = next;
      stopDisplayRequest();
      stopDisplay();
      wantDisplay = true;
    }
    runState = state;
    if (state === 'ready') {
      if (visible && wantDisplay && !display && !viewRequest && !action) void join();
    } else {
      stopDisplayRequest();
      stopDisplay();
      wantDisplay = state !== 'failed';
      phase = state === 'failed' ? message(result.code) : state;
    }
    publish();
  }
  function scheduleStatus() {
    clearTimeout(statusTimer);
    if (!disposed && !closed && runId && !action && !statusRequest) {
      statusTimer = setTimeout(() => void refreshStatus(), STATUS_MS);
    }
  }
  async function refreshStatus() {
    if (disposed || closed || !runId || action || statusRequest) return;
    clearTimeout(statusTimer);
    const request = new AbortController();
    statusRequest = request;
    try {
      const result = await post('/browser/status', { sessionId, runId }, request.signal);
      if (!request.signal.aborted) applyStatus(result);
    } catch (error) {
      if (request.signal.aborted) return;
      if (error?.code === 'browser_closed') return retire();
      // A transport error is not proof that Chromium has closed. Keep polling,
      // but offer a manual reconnect if a visible ready run is awaiting its display.
      if (visible && wantDisplay && !display && !viewRequest && runState === 'ready') {
        phase = message(error?.code);
        publish();
      }
    } finally {
      if (statusRequest === request) {
        statusRequest = undefined;
        scheduleStatus();
      }
    }
  }
  function attach(ticket) {
    const screen = document.createElement('div');
    Object.assign(screen.style, { height: '100%', width: '100%' });
    target.appendChild(screen);
    const current = { dispose, rfb: undefined };
    display = current;
    let channel;
    let observer;
    let handshake;
    let connected = false;
    let resizeOwner = false;
    const securityEvents = ['credentialsrequired', 'securityfailure', 'serververification'];
    const live = () => !disposed && visible && display === current;

    function updateResize() {
      if (!live() || !current.rfb) return;
      const enabled = connected && resizeOwner
        && screen.clientWidth >= MIN_RESIZE_WIDTH && screen.clientHeight >= MIN_RESIZE_HEIGHT;
      if (current.rfb.resizeSession !== enabled) current.rfb.resizeSession = enabled;
    }
    function dispose() {
      clearTimeout(handshake);
      observer?.disconnect();
      try {
        const { rfb } = current;
        if (rfb) {
          rfb.removeEventListener('connect', onConnect);
          rfb.removeEventListener('disconnect', onDisconnect);
          for (const event of securityEvents) rfb.removeEventListener(event, onFailure);
          rfb.resizeSession = false;
          rfb.disconnect();
        }
      } finally {
        channel?.close();
        screen.remove();
      }
    }
    function fail(next) {
      if (!live()) return;
      stopDisplay();
      phase = next;
      publish();
      void refreshStatus();
    }
    function onFailure() { fail(connected ? 'disconnected' : 'handshakeFailed'); }
    function onDisconnect() { onFailure(); }
    function onConnect() {
      if (!live()) return;
      clearTimeout(handshake);
      connected = true;
      updateResize();
      phase = 'connected';
      publish();
    }
    try {
      phase = 'connecting';
      channel = createStreamChannel(ticket, openWebSocket, (enabled) => {
        if (!live()) return;
        resizeOwner = enabled;
        updateResize();
      });
      current.rfb = new RFB(screen, channel);
      current.rfb.scaleViewport = true; // Also covers peers and servers without native resize support.
      current.rfb.addEventListener('connect', onConnect);
      current.rfb.addEventListener('disconnect', onDisconnect);
      for (const event of securityEvents) current.rfb.addEventListener(event, onFailure);
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(updateResize);
        observer.observe(screen);
      }
      handshake = setTimeout(() => fail('handshakeTimeout'), HANDSHAKE_MS);
    } catch {
      fail('handshakeFailed');
    }
  }
  async function join() {
    if (disposed || closed || !visible || action || viewRequest || display) return;
    opened = true;
    wantDisplay = false;
    const identity = runId ? { sessionId, runId, generation } : { sessionId };
    const request = new AbortController();
    viewRequest = request;
    phase = runId ? 'connecting' : 'starting';
    actionError = undefined;
    publish();
    try {
      const result = await post('/view', identity, request.signal);
      if (request.signal.aborted) return;
      if (!token(result.runId) || !token(result.generation)
        || (runId && (result.runId !== runId || result.generation !== generation))) throw new Error('Invalid browser binding');
      runId = result.runId;
      generation = result.generation;
      if (result.state === 'failed') {
        runState = 'failed';
        phase = message(result.code);
      } else {
        runState = 'ready';
        if (!token(result.ticket)) throw new Error('Invalid browser display ticket');
        // The initial request can finish while hidden; retain its identity, not the ticket.
        if (visible) attach(result.ticket);
      }
    } catch (error) {
      if (request.signal.aborted) return;
      if (runId && error?.code === 'browser_closed') return retire();
      phase = message(error?.code);
      if (runId && error?.code === 'browser_generation_changed') void refreshStatus();
    } finally {
      if (viewRequest === request) {
        viewRequest = undefined;
        publish();
        if (visible) scheduleStatus();
        else void refreshStatus();
      }
    }
  }
  async function mutate(operation) {
    if (disposed || closed || !visible || action || !generation
      || (operation === 'restart' && runState !== 'ready' && runState !== 'failed')) return;
    stopStatus();
    stopDisplayRequest();
    const request = new AbortController();
    action = request;
    actionError = undefined;
    publish();
    try {
      const result = await post(`/browser/${operation}`, { sessionId, runId, generation }, request.signal);
      if (request.signal.aborted) return;
      if (result.state !== (operation === 'close' ? 'closed' : 'restarting')) throw new Error('Invalid browser action result');
      applyStatus(result);
    } catch (error) {
      if (request.signal.aborted) return;
      if (error?.code === 'browser_closed') return retire();
      if (!display && runState === 'ready') phase = 'disconnected';
      actionError = message(error?.code);
    } finally {
      if (!request.signal.aborted) {
        action = undefined;
        publish();
        void refreshStatus();
      }
    }
  }
  function setVisible(next) {
    if (disposed || closed || visible === next) return;
    visible = next;
    if (!visible) {
      // Preserve the first request until it yields a run ID; no later request
      // can implicitly create a different run for this tab.
      if (runId) stopDisplayRequest();
      stopDisplay();
    } else if (runId) {
      wantDisplay = true;
      if (runState !== 'failed' && !action) phase = runState === 'ready' ? 'connecting' : runState;
      stopStatus();
      void refreshStatus();
    } else if (!opened) {
      void join();
    }
    publish();
  }
  function retry() {
    if (runState === 'failed') void mutate('restart');
    else if (!runId || runState === 'ready') void join();
  }
  function dispose() {
    disposed = true;
    tabSignal.removeEventListener('abort', dispose);
    action?.abort();
    stopStatus();
    stopDisplayRequest();
    stopDisplay();
  }
  if (!disposed) tabSignal.addEventListener('abort', dispose, { once: true });
  return { setVisible, retry, mutate, blur: () => display?.rfb?.blur(), dispose };
}

export function makeBrowserView(React, RFB) {
  const { createElement: h, useLayoutEffect, useRef, useState } = React;
  const AgentAccess = makeAgentAccess(React);
  return function BrowserView({ sessionId, tabSignal, visible, t, openWebSocket, onClosed }) {
    const target = useRef(null);
    const barRef = useRef(null);
    const connection = useRef(null);
    const close = useRef(onClosed);
    const [state, setState] = useState({ phase: 'starting' });
    useLayoutEffect(() => { close.current = onClosed; }, [onClosed]);
    useLayoutEffect(() => {
      const client = createBrowserConnection({
        sessionId, tabSignal, target: target.current, RFB, openWebSocket,
        onClosed: () => close.current(), onChange: setState,
      });
      connection.current = client;
      return () => {
        connection.current = null;
        client.dispose();
      };
    }, [sessionId, tabSignal, openWebSocket]);
    useLayoutEffect(() => { connection.current?.setVisible(visible); }, [sessionId, tabSignal, openWebSocket, visible]);

    const connected = visible && state.phase === 'connected';
    const command = (operation, enabled, label) => h('button', {
      type: 'button', style: control, disabled: !enabled,
      onClick: () => void connection.current?.mutate(operation),
    }, t(label));
    return h('div', { hidden: !visible, style: { ...viewport, display: visible ? 'flex' : 'none', flexDirection: 'column' } },
      h(AgentAccess, { sessionId, tabSignal, visible, t, barRef },
        command('restart', state.canRestart, 'restartBrowser'), command('close', state.canClose, 'closeBrowser')),
      state.actionError ? h('div', { role: 'alert', style: { padding: '4px 10px' } }, t(state.actionError)) : null,
      h('div', { style: viewport, role: 'region', 'aria-label': t('viewport') },
        h('div', {
          style: fill, ref: target,
          onKeyDownCapture(event) {
            if (event.key === 'Escape' && event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              connection.current?.blur();
              barRef.current?.focus();
            }
          },
        }),
        connected ? null : h('div', { style: overlay },
          h('div', { role: state.canRetry ? 'alert' : 'status' }, t(state.phase)),
          state.canRetry ? h('div', null, h('button', {
            type: 'button', style: control, onClick: () => connection.current?.retry(),
          }, t(state.retryLabel))) : null)));
  };
}
