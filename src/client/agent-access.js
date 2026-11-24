import { admissionMessage, post } from './http.js';

const POLL_MS = 2000;
const accessMessages = new Map([
  ['session_workspace_missing', 'sessionWorkspaceMissing'],
  ['agent_access_denied', 'agentAccessDenied'],
  ['browser_not_ready', 'browserNotReady'],
  ['plugin_unavailable', 'pluginUnavailable'],
]);

export function makeUseAgentAccess(React) {
  const { useLayoutEffect, useRef, useState } = React;

  return function useAgentAccess({ sessionId, tabSignal, visible, t }) {
    const [snapshot, setSnapshot] = useState(null);
    const [statusError, setStatusError] = useState(null);
    const [actionError, setActionError] = useState(null);
    const [busy, setBusy] = useState(false);
    const actions = useRef(null);

    useLayoutEffect(() => {
      setSnapshot(null);
      setStatusError(null);
      setActionError(null);
      setBusy(false);
      if (tabSignal.aborted) return;
      const scope = new AbortController();
      let showing = false;
      let read;
      let timer;
      let mutating = false;
      function stopRead() {
        clearTimeout(timer);
        read?.abort();
        read = undefined;
      }
      function confirm(result) {
        if (!['enabled', 'disabled', 'conflict'].includes(result.provider) || typeof result.canGrant !== 'boolean'
          || (result.access !== null && typeof result.access?.sessionId !== 'string')) {
          throw new Error('Invalid agent status');
        }
        setSnapshot({ sessionId, tabSignal, provider: result.provider, canGrant: result.canGrant, access: result.access });
        setStatusError(null);
      }
      function schedule() {
        if (showing && !scope.signal.aborted && !mutating) timer = setTimeout(poll, POLL_MS);
      }
      async function poll() {
        if (!showing || scope.signal.aborted || mutating || read) return;
        const request = new AbortController();
        read = request;
        try {
          const result = await post('/agent/status', { sessionId }, request.signal);
          if (!request.signal.aborted) confirm(result);
        } catch (error) {
          if (!request.signal.aborted) setStatusError(error);
        } finally {
          if (read === request) {
            read = undefined;
            schedule();
          }
        }
      }
      async function mutate(path) {
        if (!showing || scope.signal.aborted || mutating) return;
        mutating = true;
        stopRead();
        setBusy(true);
        setActionError(null);
        try {
          const result = await post(path, { sessionId }, scope.signal);
          if (!scope.signal.aborted) confirm(result);
        } catch (error) {
          if (!scope.signal.aborted) setActionError(error);
        } finally {
          if (!scope.signal.aborted) {
            setBusy(false);
            mutating = false;
            schedule();
          }
        }
      }
      function setVisible(next) {
        showing = next;
        if (showing) void poll();
        else stopRead();
      }
      function dispose() {
        actions.current = null;
        scope.abort();
        stopRead();
      }
      tabSignal.addEventListener('abort', dispose, { once: true });
      actions.current = { mutate, setVisible };
      return () => {
        tabSignal.removeEventListener('abort', dispose);
        dispose();
      };
    }, [sessionId, tabSignal]);
    useLayoutEffect(() => { actions.current?.setVisible(visible); }, [sessionId, tabSignal, visible]);

    const status = snapshot?.sessionId === sessionId && snapshot.tabSignal === tabSignal ? snapshot : null;
    const granted = status?.access?.sessionId === sessionId;
    const canChange = visible && !tabSignal.aborted && !busy
      && (granted || (status?.provider === 'enabled' && status.canGrant && !statusError));
    const control = actions.current;
    function errorText(error) {
      const key = admissionMessage(error?.code) ?? accessMessages.get(error?.code);
      return t(key ?? 'requestFailed');
    }
    const reason = statusError ? errorText(statusError)
      : status?.provider === 'conflict' ? t('providerConflict') : null;
    return {
      granted, canChange, busy,
      setGranted(next) {
        if (canChange && next !== granted && control === actions.current) {
          return control?.mutate(next ? '/agent/grant' : '/agent/revoke');
        }
      },
      reason,
      error: actionError ? errorText(actionError) : null,
    };
  };
}
