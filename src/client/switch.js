// DSH 0.2.2-rc.3 Switch CSS, adapted to a native checkbox and plugin-scoped classes.
const switchCss = `
.dsh-workspace-browser-switch {
  position: relative; display: inline-flex; flex: none; align-items: center;
  width: 36px; height: 28px; -webkit-app-region: no-drag;
}
.dsh-workspace-browser-switch > input {
  position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0;
  cursor: pointer;
}
.dsh-workspace-browser-switch > input:disabled { cursor: default; }
.dsh-workspace-browser-switch > input[aria-busy="true"] { cursor: wait; }
.dsh-workspace-browser-switch-track {
  box-sizing: border-box; flex: 0 0 auto; pointer-events: none;
  width: 36px; height: 20px; padding: 2px; border: 0;
  border-radius: 999px; corner-shape: round;
  background: var(--dsw-alias-border-l3);
}
.dsh-workspace-browser-switch-track::before {
  content: ''; display: block; width: 16px; height: 16px;
  border-radius: 50%; corner-shape: round;
  background: var(--dsw-alias-label-primary-foreground); transition: transform .12s ease;
}
.dsh-workspace-browser-switch > input:not(:checked) + .dsh-workspace-browser-switch-track::before {
  background: var(--dsw-alias-switch-thumb);
}
.dsh-workspace-browser-switch > input:checked + .dsh-workspace-browser-switch-track {
  background: var(--dsw-alias-brand-primary);
}
.dsh-workspace-browser-switch > input:checked + .dsh-workspace-browser-switch-track::before {
  transform: translate(16px);
}
.dsh-workspace-browser-switch > input:focus-visible + .dsh-workspace-browser-switch-track {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dsh-workspace-browser-switch > :is(input:disabled, input[aria-disabled="true"]) + .dsh-workspace-browser-switch-track {
  opacity: .5;
}
@media (forced-colors: active) {
  .dsh-workspace-browser-switch > input { appearance: auto; opacity: 1; margin: auto; width: 18px; }
  .dsh-workspace-browser-switch-track { display: none; }
}
`;

// During a write, keep the native input focused but ignore subsequent changes.
export function renderSwitch(h, { id, checked, disabled, busy, onChange, descriptionId }) {
  return h('span', { className: 'dsh-workspace-browser-switch' },
    h('style', null, switchCss),
    h('input', {
      id, type: 'checkbox', role: 'switch', checked, disabled: disabled && !busy,
      'aria-describedby': descriptionId, 'aria-disabled': busy || undefined, 'aria-busy': busy || undefined,
      onChange(event) {
        if (!disabled && !busy) return onChange(event.currentTarget.checked);
      },
    }),
    h('span', { className: 'dsh-workspace-browser-switch-track', 'aria-hidden': true }));
}
