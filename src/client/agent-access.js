import { publicOrigin } from '../shared/protocol.js';
import { admissionMessage, post } from './http.js';
import { accessBox, control, fields, row } from './styles.js';

const POLL_MS = 2000;
const selectStyle = { ...control, display: 'block', width: '100%' };

export function makeAgentAccess(React) {
  const { createElement: h, useLayoutEffect, useRef, useState } = React;

  function expiry(t, value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? h('div', null, t('expires'), ': ', h('time', { dateTime: date.toISOString() }, date.toLocaleString()))
      : null;
  }

  return function AgentAccess({ workspace, t }) {
    const { workspaceId, sessionIds } = workspace;
    const [snapshot, setSnapshot] = useState(null);
    const [statusError, setStatusError] = useState(null);
    const [actionError, setActionError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [sessionId, setSessionId] = useState('');
    const [origin, setOrigin] = useState('');
    const [invalidOrigin, setInvalidOrigin] = useState(false);
    const actions = useRef(null);

    useLayoutEffect(() => {
      const scope = new AbortController();
      let read;
      let timer;
      let mutating = false;
      function stopRead() {
        clearTimeout(timer);
        read?.abort();
      }
      function errorText(error) {
        const key = admissionMessage(error?.code);
        return key ? t(key) : (error?.userMessage ?? '');
      }
      async function poll() {
        if (scope.signal.aborted || mutating) return;
        const request = new AbortController();
        read = request;
        try {
          const result = await post('/agent/status', { workspaceId }, request.signal);
          if (request.signal.aborted) return;
          if (!['enabled', 'disabled', 'conflict'].includes(result.provider)) throw new Error();
          setSnapshot(result);
          setStatusError(null);
        } catch (error) {
          if (request.signal.aborted) return;
          setSnapshot(null);
          setStatusError(errorText(error));
        } finally {
          if (!request.signal.aborted) timer = setTimeout(poll, POLL_MS);
        }
      }
      async function mutate(path, body) {
        if (scope.signal.aborted || mutating) return;
        mutating = true;
        stopRead();
        setBusy(true);
        setActionError(null);
        try {
          await post(path, { ...body, workspaceId }, scope.signal);
        } catch (error) {
          if (!scope.signal.aborted) setActionError(errorText(error));
        } finally {
          if (!scope.signal.aborted) {
            setSnapshot(null);
            setBusy(false);
            mutating = false;
            void poll();
          }
        }
      }
      actions.current = { mutate };
      void poll();
      return () => {
        actions.current = null;
        scope.abort();
        stopRead();
      };
    }, [workspaceId]);

    const selected = sessionIds.includes(sessionId) ? sessionId : '';
    const access = snapshot?.access;
    const pending = snapshot?.pending;
    const button = (label, onClick) => h('button', { type: 'button', style: control, disabled: busy, onClick }, t(label));
    const mutate = (path, body) => actions.current?.mutate(path, body);
    const grant = (event) => {
      event.preventDefault();
      if (busy || snapshot?.provider !== 'enabled' || access || !selected) return;
      if (!publicOrigin(origin)) {
        setInvalidOrigin(true);
        return;
      }
      void mutate('/agent/grant', { sessionId: selected, origin });
    };

    return h('details', { style: accessBox },
      h('summary', null, t('agentAccess'), h('span', { role: 'status' }, pending ? ` · ${t('pending')}` : '')),
      h('div', { style: { ...fields, marginBlock: 8 } },
        actionError !== null ? h('div', { role: 'alert' }, actionError || t('requestFailed')) : null,
        statusError !== null ? h('div', { role: 'status' }, statusError || t('requestFailed')) : null,
        !snapshot && statusError === null ? h('div', { role: 'status' }, t('loadingStatus')) : null,
        snapshot && snapshot.provider !== 'enabled'
          ? h('div', null, t(snapshot.provider === 'disabled' ? 'providerDisabled' : 'providerConflict')) : null,
        access ? h('div', { style: fields },
          h('div', null, t('session'), ': ', h('bdi', null, access.sessionId)),
          h('div', null, t('origin'), ': ', h('bdi', null, access.origin)),
          expiry(t, access.expiresAt),
          h('div', null, button('revoke', () => mutate('/agent/revoke', {})))) : null,
        pending && snapshot.provider === 'enabled' ? h('div', { key: pending.id, style: fields },
          h('strong', null, t('pending')),
          h('div', null, t('session'), ': ', h('bdi', null, pending.sessionId)),
          h('div', null, t('origin'), ': ', h('bdi', null, pending.origin)),
          h('div', null, t('action'), ': ', h('bdi', null, pending.action)),
          h('div', { dir: 'auto', style: { whiteSpace: 'pre-wrap' } }, pending.summary),
          expiry(t, pending.expiresAt),
          h('div', { style: row },
            button('deny', () => mutate('/agent/decision', { id: pending.id, allow: false })),
            button('approve', () => mutate('/agent/decision', { id: pending.id, allow: true })))) : null,
        snapshot?.provider === 'enabled' && !access
          ? sessionIds.length === 0 ? h('div', null, t('noSessions')) : h('form', { onSubmit: grant, style: fields },
            h('div', null, t('grantHelp')),
            h('label', null, t('session'), h('select', {
              value: selected, required: true, disabled: busy, style: selectStyle,
              onChange: (event) => setSessionId(event.target.value),
            }, h('option', { value: '' }, t('chooseSession')),
            sessionIds.map((id) => h('option', { key: id, value: id }, id)))),
            h('label', null, t('origin'), h('input', {
              type: 'url', required: true, disabled: busy, maxLength: 512, value: origin,
              autoCapitalize: 'none', autoComplete: 'off', spellCheck: false,
              'aria-invalid': invalidOrigin || undefined, placeholder: 'https://example.com', style: selectStyle,
              onChange: (event) => { setOrigin(event.target.value); setInvalidOrigin(false); },
            })),
            invalidOrigin ? h('div', { role: 'alert' }, t('invalidOrigin')) : null,
            h('div', null, h('button', { type: 'submit', disabled: busy || !selected || !origin, style: control }, t('grant')))) : null));
  };
}
