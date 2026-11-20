import { PROJECT_ID } from '../shared/identity.js';

const switchClass = `${PROJECT_ID}-switch`;
const trackClass = `${switchClass}-track`;

// DSH 0.2.2-rc.3 Switch CSS, adapted to a native checkbox and plugin-scoped classes.
const switchCss = `
.${switchClass} {
  position: relative; display: inline-flex; flex: none; align-items: center;
  width: 36px; height: 28px; -webkit-app-region: no-drag;
}
.${switchClass} > input {
  position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0;
  cursor: pointer;
}
.${switchClass} > input:disabled { cursor: default; }
.${switchClass} > input[aria-busy="true"] { cursor: wait; }
.${trackClass} {
  box-sizing: border-box; flex: 0 0 auto; pointer-events: none;
  width: 36px; height: 20px; padding: 2px; border: 0;
  border-radius: 999px; corner-shape: round;
  background: var(--dsw-alias-border-l3);
}
.${trackClass}::before {
  content: ''; display: block; width: 16px; height: 16px;
  border-radius: 50%; corner-shape: round;
  background: var(--dsw-alias-label-primary-foreground); transition: transform .12s ease;
}
.${switchClass} > input:not(:checked) + .${trackClass}::before {
  background: var(--dsw-alias-switch-thumb);
}
.${switchClass} > input:checked + .${trackClass} {
  background: var(--dsw-alias-brand-primary);
}
.${switchClass} > input:checked + .${trackClass}::before {
  transform: translate(16px);
}
.${switchClass} > input:focus-visible + .${trackClass} {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.${switchClass} > :is(input:disabled, input[aria-disabled="true"]) + .${trackClass} {
  opacity: .5;
}
@media (forced-colors: active) {
  .${switchClass} > input { appearance: auto; opacity: 1; margin: auto; width: 18px; }
  .${trackClass} { display: none; }
}
`;

// During a write, keep the native input focused but ignore subsequent changes.
export function renderSwitch(h, { id, checked, disabled, busy, onChange, descriptionId }) {
  return h('span', { className: switchClass },
    h('style', null, switchCss),
    h('input', {
      id, type: 'checkbox', role: 'switch', checked, disabled: disabled && !busy,
      'aria-describedby': descriptionId, 'aria-disabled': busy || undefined, 'aria-busy': busy || undefined,
      onChange(event) {
        if (!disabled && !busy) return onChange(event.currentTarget.checked);
      },
    }),
    h('span', { className: trackClass, 'aria-hidden': true }));
}
