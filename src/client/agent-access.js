import { admissionMessage, post } from './http.js';
import { accessErrors, bar, switchControl, switchThumb, switchTrack } from './styles.js';

const POLL_MS = 2000;

export function makeAgentAccess(React) {
  const { createElement: h, Fragment, useLayoutEffect, useRef, useState } = React;

  return function AgentAccess({ sessionId, tabSignal, visible, t, barRef, children }) {
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
    const checked = status?.access?.sessionId === sessionId;
    const canToggle = visible && !tabSignal.aborted && !busy
      && (checked || (status?.provider === 'enabled' && status.canGrant));
    function errorText(error) {
      const key = admissionMessage(error?.code);
      return key ? t(key) : (error?.userMessage || t('requestFailed'));
    }
    const reason = statusError ? errorText(statusError)
      : status?.provider === 'conflict' ? t('providerConflict') : null;
    return h(Fragment, null,
      h('div', { role: 'group', 'aria-label': t('browserControls'), tabIndex: -1, ref: barRef, style: bar },
        children,
        h('button', {
          type: 'button', role: 'switch', 'aria-checked': checked, style: switchControl, disabled: !canToggle,
          onClick() { if (canToggle) void actions.current?.mutate(checked ? '/agent/revoke' : '/agent/grant'); },
        }, t('agentAccess'), h('span', { 'aria-hidden': true, style: switchTrack(checked) },
          h('span', { style: switchThumb(checked) })))),
      (reason || actionError) ? h('div', { style: accessErrors },
        reason ? h('div', { role: 'alert' }, reason) : null,
        actionError ? h('div', { role: 'alert' }, errorText(actionError)) : null) : null);
  };
}
