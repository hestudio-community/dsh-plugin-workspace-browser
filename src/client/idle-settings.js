import { post } from './http.js';
import { settings } from './settings-styles.js';

const valid = (value) => Number.isInteger(value) && value >= 0 && value <= 1440;
// Mirrors the Host's account-name validation so a typo is reported before writing.
const accountName = /^[a-z_][a-z0-9_-]{0,31}$/;

export function makeIdleSettings(React, form, field = 'idleTimeoutMinutes') {
  const account = field === 'rootBrowserAccount';
  const label = suffix => `${account ? 'rootAccount' : 'idle'}${suffix}`;
  const { createElement: h, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } = React;
  const subscribe = (listener) => form.subscribe(listener);
  const read = () => form.getSnapshot();
  return function IdleSettings({ t }) {
    const id = useId();
    const snapshot = useSyncExternalStore(subscribe, read);
    const { revision, status } = snapshot;
    const raw = snapshot.value?.[field];
    // Never render a non-string account value; an unset account is an empty draft.
    const value = account ? (typeof raw === 'string' ? raw : undefined) : raw;
    // A root Host serves this field apart from its other settings, so visibility
    // comes from the Host's platform, not from whether a value was stored yet.
    const [rootHost, setRootHost] = useState(account ? undefined : false);
    useLayoutEffect(() => {
      if (!account) return;
      const controller = new AbortController();
      post('/environment/platform', {}, controller.signal).then(
        (result) => { if (!controller.signal.aborted) setRootHost(result.root === true); },
        () => { if (!controller.signal.aborted) setRootHost(false); },
      );
      return () => controller.abort();
    }, []);
    const ready = status === 'ready' && (account ? value === undefined || typeof value === 'string' : valid(value));
    const writable = ready && snapshot.writable && revision !== undefined;
    const [draft, setDraft] = useState(null);
    const [phase, setPhase] = useState(null);
    const pending = useRef(false);
    const text = draft && draft.revision === revision ? draft.text : ready ? String(value ?? '') : '';
    const next = account ? text : Number(text);
    const invalid = account ? text.trim() !== '' && !accountName.test(text.trim()) : text.trim() === '' || !valid(next);
    const busy = phase === 'agentSettingsSaving';
    const notice = !ready ? status === 'loading' ? 'agentSettingsLoading' : 'agentSettingsUnavailable'
      : !writable ? 'agentSettingsReadOnly' : invalid ? (account ? 'rootAccountNameInvalid' : 'idleInvalid') : phase;
    const disabled = !writable || busy || invalid || (value === undefined ? false : next === value);

    async function save() {
      if (disabled || pending.current) return;
      const latest = read();
      if (latest.status !== 'ready' || !latest.writable || latest.revision !== revision ||
          (account && latest.value?.[field] !== undefined && typeof latest.value?.[field] !== 'string')) {
        setPhase('agentSettingsChanged');
        return;
      }
      const written = account ? next.trim() : next;
      // A rejected response can still follow a persisted write when the Host
      // reloads around the mutation, so confirm the value before reporting failure.
      const saved = () => read().value?.[field] === written;
      pending.current = true;
      setPhase('agentSettingsSaving');
      try {
        if (!await form.mutate([{ op: 'set', path: [field], value: written }], revision) && !saved()) {
          setPhase('agentSettingsNotSaved');
          return;
        }
        setDraft(null);
        setPhase(null);
      } catch {
        setPhase(saved() ? null : 'agentSettingsNotSaved');
      } finally {
        pending.current = false;
      }
    }

    if (account && (rootHost !== true || !ready)) return null;
    return h('section', { className: settings.section, 'aria-label': t(label('Heading')) },
      h('h2', { className: settings.heading }, t(label('Heading'))),
      h('div', { className: settings.card }, h('div', { className: settings.copy },
        h('label', { htmlFor: id }, t(label('Label'))),
        h('p', { id: `${id}-help`, className: settings.detail }, t(label('Description'))),
        h('div', { className: settings.actions },
          h('input', { id, className: settings.input, ...(account ? { type: 'text', spellCheck: false } : { type: 'number', min: 0, max: 1440, step: 1 }), value: text,
            disabled: !writable || busy, 'aria-invalid': ready && invalid, 'aria-describedby': `${id}-help ${id}-status`,
            onChange: (event) => { setDraft({ revision, text: event.currentTarget.value }); setPhase(null); },
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void save(); } },
          }),
          h('button', { type: 'button', className: `${settings.button} ${settings.buttonOutline}`,
            disabled, 'aria-disabled': disabled, onClick: save }, t(label('Save')))),
        h('div', { id: `${id}-status`, role: 'status', className: settings.status }, notice && t(notice)))));
  };
}
