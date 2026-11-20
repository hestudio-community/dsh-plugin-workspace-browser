import { settings } from './settings-styles.js';

const valid = (value) => Number.isInteger(value) && value >= 0 && value <= 1440;

export function makeIdleSettings(React, form) {
  const { createElement: h, useId, useRef, useState, useSyncExternalStore } = React;
  const subscribe = (listener) => form.subscribe(listener);
  const read = () => form.getSnapshot();
  return function IdleSettings({ t }) {
    const id = useId();
    const snapshot = useSyncExternalStore(subscribe, read);
    const { revision, status } = snapshot;
    const value = snapshot.value?.idleTimeoutMinutes;
    const ready = status === 'ready' && valid(value);
    const writable = ready && snapshot.writable && revision !== undefined;
    const [draft, setDraft] = useState(null);
    const [phase, setPhase] = useState(null);
    const pending = useRef(false);
    const text = draft && draft.revision === revision ? draft.text : ready ? String(value) : '';
    const next = Number(text);
    const invalid = text.trim() === '' || !valid(next);
    const busy = phase === 'agentSettingsSaving';
    const notice = !ready ? status === 'loading' ? 'agentSettingsLoading' : 'agentSettingsUnavailable'
      : !writable ? 'agentSettingsReadOnly' : invalid ? 'idleInvalid' : phase;
    const disabled = !writable || busy || invalid || next === value;

    async function save() {
      if (disabled || pending.current) return;
      const latest = read();
      if (latest.status !== 'ready' || !latest.writable || latest.revision !== revision) {
        setPhase('agentSettingsChanged');
        return;
      }
      pending.current = true;
      setPhase('agentSettingsSaving');
      try {
        if (!await form.mutate([{ op: 'set', path: ['idleTimeoutMinutes'], value: next }], revision)) {
          setPhase('agentSettingsNotSaved');
          return;
        }
        setDraft(null);
        setPhase(null);
      } catch {
        setPhase('agentSettingsNotSaved');
      } finally {
        pending.current = false;
      }
    }

    return h('section', { className: settings.section, 'aria-label': t('idleHeading') },
      h('h2', { className: settings.heading }, t('idleHeading')),
      h('div', { className: settings.card }, h('div', { className: settings.copy },
        h('label', { htmlFor: id }, t('idleLabel')),
        h('p', { id: `${id}-help`, className: settings.detail }, t('idleDescription')),
        h('div', { className: settings.actions },
          h('input', { id, className: settings.input, type: 'number', min: 0, max: 1440, step: 1, value: text,
            disabled: !writable || busy, 'aria-invalid': ready && invalid, 'aria-describedby': `${id}-help ${id}-status`,
            onChange: (event) => { setDraft({ revision, text: event.currentTarget.value }); setPhase(null); },
            onKeyDown: (event) => { if (event.key === 'Enter') { event.preventDefault(); void save(); } },
          }),
          h('button', { type: 'button', className: `${settings.button} ${settings.buttonOutline}`,
            disabled, 'aria-disabled': disabled, onClick: save }, t('idleSave'))),
        h('div', { id: `${id}-status`, role: 'status', className: settings.status }, notice && t(notice)))));
  };
}
