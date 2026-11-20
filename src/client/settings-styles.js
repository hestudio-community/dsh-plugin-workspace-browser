import { PROJECT_ID } from '../shared/identity.js';

const scope = `${PROJECT_ID}-settings`;
export const settings = Object.fromEntries(['page', 'section', 'heading', 'row', 'copy', 'detail', 'actions', 'button', 'status', 'error', 'list', 'version', 'result'].map(name => [name, `${scope}-${name}`]));

const css = `
.${settings.page} { display: grid; min-width: 0; gap: 20px; margin-block: 16px; }
.${settings.section} { min-width: 0; }
.${settings.heading} { margin: 0 0 8px; font: inherit; font-weight: 600; }
.${settings.row} {
  display: flex; align-items: center; justify-content: space-between; gap: 8px 16px;
  min-width: 0; padding: 12px 0; border-block-start: 1px solid var(--dsw-alias-border-l1, GrayText);
}
.${settings.row}:last-child { border-block-end: 1px solid var(--dsw-alias-border-l1, GrayText); }
.${settings.copy} { min-width: 0; font-weight: 500; overflow-wrap: anywhere; }
.${settings.detail}, .${settings.version}, .${settings.status}, .${settings.error} {
  margin: 4px 0 0; overflow-wrap: anywhere; font-weight: 400;
  color: var(--dsw-alias-label-secondary, CanvasText);
}
.${settings.status}:empty { margin: 0; }
.${settings.error} { color: var(--dsw-alias-state-error-primary, CanvasText); }
.${settings.actions} { display: flex; flex-wrap: wrap; gap: 8px; margin-block: 8px; }
.${settings.button} {
  min-height: 28px; max-width: 100%; padding: 4px 10px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-l1, ButtonText); font: inherit;
  color: var(--dsw-alias-label-primary, ButtonText); background: var(--dsw-alias-bg-base, ButtonFace);
  text-align: start; overflow-wrap: anywhere; cursor: pointer; -webkit-app-region: no-drag;
}
.${settings.button}:not([aria-disabled="true"]):hover { background: var(--dsw-alias-border-l1, ButtonFace); }
.${settings.button}:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, Highlight));
  outline-offset: 2px;
}
.${settings.button}[aria-disabled="true"] { color: var(--dsw-alias-label-secondary, GrayText); cursor: default; }
.${settings.list} { list-style: none; padding: 0; margin: 12px 0 0; }
.${settings.list} .${settings.row} { align-items: start; }
.${settings.result} { flex: none; color: var(--dsw-alias-label-secondary, CanvasText); }
`;

export function renderSettingsStyles(h) {
  return h('style', null, css);
}
