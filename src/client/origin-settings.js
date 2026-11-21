import { normalizeWebOrigin } from '../shared/web-origin.js';
import { settings } from './settings-styles.js';

function parseLines(text) {
  const origins = new Set();
  for (const [index, line] of text.split('\n').entries()) {
    const entry = line.trim();
    if (!entry) continue;
    const origin = normalizeWebOrigin(entry);
    if (origin === null) return { invalidLine: index + 1 };
    origins.add(origin);
  }
  return { origins: [...origins] };
}

export function makeOriginSettings(React, form) {
  const { createElement: h, useId, useRef, useState, useSyncExternalStore } = React;
  const subscribe = (listener) => form.subscribe(listener);
  const read = () => form.getSnapshot();
  return function OriginSettings({ t }) {
    const id = useId();
    const snapshot = useSyncExternalStore(subscribe, read);
    const { revision, status } = snapshot;
    const { allowedWebOrigins: value = [] } = snapshot.value ?? {};
    const ready = status === 'ready' && Array.isArray(value) && value.every(entry => typeof entry === 'string');
    const writable = ready && snapshot.writable && revision !== undefined;
    const [draft, setDraft] = useState(null);
    const [phase, setPhase] = useState(null);
    const pending = useRef(false);
    const stale = draft !== null && draft.revision !== revision;
    const text = draft && !stale ? draft.text : ready ? value.join('\n') : '';
    const { origins, invalidLine } = parseLines(text);
    const busy = phase === 'agentSettingsSaving';
    const unchanged = ready && origins?.length === value.length && origins.every((entry, i) => entry === value[i]);
    const disabled = !writable || busy || !!invalidLine || stale || !draft || unchanged;
    const notice = !ready ? status === 'loading' ? 'agentSettingsLoading' : 'agentSettingsUnavailable'
      : !writable ? 'agentSettingsReadOnly' : busy ? phase : stale ? 'agentSettingsChanged' : phase;

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
        if (!await form.mutate([{ op: 'set', path: ['allowedWebOrigins'], value: origins }], revision)) {
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

    return h('section', { className: settings.section, 'aria-label': t('originHeading') },
      h('h2', { className: settings.heading }, t('originHeading')),
      h('div', { className: settings.card }, h('div', { className: settings.copy },
        h('label', { htmlFor: id }, t('originLabel')),
        h('p', { id: `${id}-help`, className: settings.detail }, t('originDescription')),
        h('textarea', { id, className: `${settings.input} ${settings.textarea}`, rows: 4, value: text,
          spellCheck: false, autoCapitalize: 'none', disabled: !writable || busy,
          'aria-invalid': ready && !!invalidLine, 'aria-describedby': `${id}-help ${id}-status`,
          onChange: (event) => { setDraft({ revision, text: event.currentTarget.value }); setPhase(null); },
        }),
        h('div', { className: settings.actions }, h('button', { type: 'button',
          className: `${settings.button} ${settings.buttonOutline}`, disabled, 'aria-disabled': disabled,
          onClick: save }, t('originSave'))),
        h('div', { id: `${id}-status`, role: 'status', className: settings.status },
          writable && invalidLine ? `${t('originInvalidLine')} ${invalidLine}` : notice && t(notice)))));
  };
}
