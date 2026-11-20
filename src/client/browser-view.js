import { admissionMessage, post } from './http.js';
import { createStreamChannel } from './stream.js';
import { bar, control, fill, overlay, viewport } from './styles.js';

const HANDSHAKE_MS = 30_000;
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
]);

export function makeBrowserView(React, RFB) {
  const { createElement: h, useLayoutEffect, useRef, useState } = React;

  return function BrowserView({ sessionId, tabSignal, t, openWebSocket }) {
    const region = useRef(null);
    const focusControl = useRef(null);
    const target = useRef(null);
    const active = useRef(null);
    const [attempt, setAttempt] = useState(0);
    const [phase, setPhase] = useState('starting');

    useLayoutEffect(() => {
      if (tabSignal.aborted) return;
      const request = new AbortController();
      const screen = document.createElement('div');
      Object.assign(screen.style, { height: '100%', width: '100%' });
      target.current.appendChild(screen);
      let handshake;
      let channel;
      let rfb;
      let finished = false;
      let connectedOnce = false;
      const securityEvents = ['credentialsrequired', 'securityfailure', 'serververification'];

      function dispose(disconnectRfb = true) {
        clearTimeout(handshake);
        try {
          if (rfb) {
            rfb.removeEventListener('connect', connected);
            rfb.removeEventListener('disconnect', disconnected);
            for (const event of securityEvents) rfb.removeEventListener(event, failed);
            if (active.current === rfb) active.current = null;
            if (disconnectRfb) rfb.disconnect();
          }
        } finally {
          channel?.close();
        }
      }
      function cancel() {
        request.abort();
        try { if (!finished) dispose(); } finally { screen.remove(); }
        finished = true;
      }
      function settle(next, disconnectRfb = true) {
        if (request.signal.aborted || finished) return;
        finished = true;
        setPhase(next);
        dispose(disconnectRfb);
      }
      function failed() { settle(connectedOnce ? 'disconnected' : 'handshakeFailed'); }
      function disconnected() { settle(connectedOnce ? 'disconnected' : 'handshakeFailed', false); }
      function connected() {
        if (request.signal.aborted || finished) return;
        clearTimeout(handshake);
        connectedOnce = true;
        active.current = rfb;
        setPhase('connected');
      }

      tabSignal.addEventListener('abort', cancel, { once: true });
      let hasTicket = false;
      void (async () => {
        try {
          const { ticket } = await post('/view', { sessionId }, request.signal);
          if (request.signal.aborted) return;
          if (typeof ticket !== 'string' || !ticket) throw new Error();
          hasTicket = true;
          setPhase('connecting');
          channel = createStreamChannel(ticket, openWebSocket);
          rfb = new RFB(screen, channel);
          rfb.scaleViewport = true;
          rfb.addEventListener('connect', connected);
          rfb.addEventListener('disconnect', disconnected);
          for (const event of securityEvents) rfb.addEventListener(event, failed);
          handshake = setTimeout(() => settle('handshakeTimeout'), HANDSHAKE_MS);
        } catch (error) {
          settle(hasTicket ? 'handshakeFailed' : (admissionMessage(error?.code) ?? requestMessages.get(error?.code) ?? 'requestFailed'));
        }
      })();
      return () => {
        tabSignal.removeEventListener('abort', cancel);
        cancel();
      };
    }, [sessionId, tabSignal, attempt, openWebSocket]);

    const retry = () => {
      region.current?.focus();
      setPhase('starting');
      setAttempt((previous) => previous + 1);
    };
    const connected = phase === 'connected';
    const showRetry = !connected && phase !== 'starting' && phase !== 'connecting';
    return h('div', {
      style: { ...viewport, display: 'flex', flexDirection: 'column' },
      ref: region, tabIndex: -1, role: 'region', 'aria-label': t('viewport'),
    },
    h('div', { style: bar }, h('button', {
      type: 'button', title: t('leaveBrowser'), 'aria-label': `${t('focusBrowser')}. ${t('leaveBrowser')}`,
      ref: focusControl, style: control, disabled: !connected, onClick: () => active.current?.focus(),
    }, t('focusBrowser'))),
    h('div', { style: viewport },
      h('div', {
        style: fill, ref: target,
        onKeyDownCapture(event) {
          if (event.key === 'Escape' && event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            active.current?.blur();
            focusControl.current?.focus();
          }
        },
      }),
      !connected ? h('div', { style: overlay },
        h('div', { role: showRetry ? 'alert' : 'status' }, t(phase)),
        showRetry ? h('div', null, h('button', { type: 'button', style: control, onClick: retry }, t(phase === 'disconnected' ? 'reconnect' : 'retry'))) : null)
        : null));
  };
}
