export function makeAgentSettings(React, form) {
  const { createElement: h, useRef, useState, useSyncExternalStore } = React;
  const subscribe = (listener) => form.subscribe(listener);
  const read = () => form.getSnapshot();

  return function AgentSettings({ t }) {
    const snapshot = useSyncExternalStore(subscribe, read);
    const [draft, setDraft] = useState(null);
    const [phase, setPhase] = useState(null);
    const pending = useRef(false);
    const value = snapshot.value?.agentEnabled;
    const ready = snapshot.status === 'ready' && typeof value === 'boolean';
    const writable = ready && snapshot.writable && snapshot.revision !== undefined;
    const stale = draft !== null && draft.revision !== snapshot.revision;
    const checked = draft && !stale ? draft.value : value;
    const saving = phase === 'agentSettingsSaving';
    const notice = phase ?? (stale ? 'agentSettingsChanged'
      : !ready ? (snapshot.status === 'loading' ? 'agentSettingsLoading' : 'agentSettingsUnavailable')
        : !writable ? 'agentSettingsReadOnly' : null);

    async function save(event) {
      event.preventDefault();
      if (!writable || !draft || pending.current) return;
      const latest = read();
      if (latest.status !== 'ready' || !latest.writable || latest.revision !== draft.revision) {
        setDraft(null);
        setPhase('agentSettingsChanged');
        return;
      }
      pending.current = true;
      setPhase('agentSettingsSaving');
      try {
        const saved = await form.mutate([{ op: 'set', path: ['agentEnabled'], value: draft.value }], draft.revision);
        setPhase(saved ? null : 'agentSettingsNotSaved');
      } catch {
        setPhase('agentSettingsNotSaved');
      } finally {
        setDraft(null);
        pending.current = false;
      }
    }

    return h('form', { onSubmit: save, style: { display: 'grid', gap: 8, justifyItems: 'start', marginBlock: 16 } },
      ready ? h('label', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('input', {
          type: 'checkbox', role: 'switch', checked, disabled: !writable || saving,
          onChange(event) {
            if (!writable || pending.current) return;
            const next = event.currentTarget.checked;
            setDraft(next === value ? null : { value: next, revision: snapshot.revision });
            setPhase(null);
          },
        }), t('agentSettingsLabel')) : h('strong', null, t('agentSettingsLabel')),
      h('div', null, t('agentSettingsDescription')),
      h('button', { type: 'submit', disabled: !writable || !draft || stale || saving }, t('agentSettingsSave')),
      h('div', { role: 'status' }, notice ? t(notice) : null));
  };
}
