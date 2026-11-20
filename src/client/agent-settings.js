import { renderSwitch } from './switch.js';
import { settings } from './settings-styles.js';

function isReady(snapshot) {
  return snapshot.status === 'ready' && typeof snapshot.value?.agentEnabled === 'boolean';
}

function canWrite(snapshot) {
  return isReady(snapshot) && snapshot.writable && snapshot.revision !== undefined;
}

export function makeAgentSettings(React, form) {
  const { createElement: h, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } = React;
  const subscribe = (listener) => form.subscribe(listener);
  const read = () => form.getSnapshot();

  return function AgentSettings({ t }) {
    const switchId = useId();
    const descriptionId = useId();
    const snapshot = useSyncExternalStore(subscribe, read);
    const [phase, setPhase] = useState(null);
    const pending = useRef(false);
    const lifetime = useRef(null);
    const ready = isReady(snapshot);
    const writable = canWrite(snapshot);
    const value = snapshot.value?.agentEnabled;
    const revision = snapshot.revision;
    const busy = phase === 'agentSettingsSaving';
    const notice = busy ? phase
      : !ready ? (snapshot.status === 'loading' ? 'agentSettingsLoading' : 'agentSettingsUnavailable')
        : !writable ? 'agentSettingsReadOnly' : phase;

    useLayoutEffect(() => {
      lifetime.current = {};
      return () => { lifetime.current = null; };
    }, []);

    async function setEnabled(next) {
      const mounted = lifetime.current;
      if (!mounted || !writable || next === value || pending.current) return;
      const latest = read();
      if (!canWrite(latest) || latest.revision !== revision) {
        setPhase('agentSettingsChanged');
        return;
      }
      if (latest.value.agentEnabled === next) return;
      pending.current = true;
      setPhase('agentSettingsSaving');
      let saved = false;
      try {
        saved = await form.mutate([{ op: 'set', path: ['agentEnabled'], value: next }], revision);
      } catch {
        // A rejected mutation is reported like any unsuccessful save.
      } finally {
        pending.current = false;
        if (lifetime.current === mounted) {
          setPhase(saved ? null : 'agentSettingsNotSaved');
        }
      }
    }

    const label = t('agentSettingsLabel');
    return h('section', { 'aria-label': t('agentSettingsHeading'), className: settings.section },
      h('h2', { className: settings.heading }, t('agentSettingsHeading')),
      h('div', { className: settings.card },
        h('div', { className: settings.row },
          h('div', { className: settings.copy },
            h('label', { htmlFor: switchId }, label),
            h('p', { id: descriptionId, className: settings.detail }, t('agentSettingsDescription')),
            h('div', { role: 'status', className: settings.status }, notice ? t(notice) : null)),
          renderSwitch(h, {
            id: switchId, descriptionId, checked: value === true, disabled: !writable, busy, onChange: setEnabled,
          }))));
  };
}
