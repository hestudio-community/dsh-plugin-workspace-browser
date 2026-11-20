import { PROJECT_ID } from '../shared/identity.js';

const scope = `${PROJECT_ID}-settings`;
const spin = `${scope}-spin`;
export const settings = Object.fromEntries([
  'page', 'section', 'heading', 'card', 'row', 'copy', 'detail', 'actions', 'button', 'buttonPrimary',
  'buttonOutline', 'buttonProgress', 'spinner', 'status', 'error', 'list', 'version', 'tag', 'tagPass', 'tagFail', 'tagSkipped',
].map(name => [name, `${scope}-${name}`]));

// Adapted from the DSH 0.2.2-rc.3 button, settings-card, tag, and spinner styles: the same
// tokens, geometry, hover fencing, focus ring, and motion rules, on plugin-scoped class names.
const css = `
.${settings.page} { display: grid; min-width: 0; gap: 20px; margin-block: 16px; }
.${settings.section} { display: grid; min-width: 0; gap: 8px; }
.${settings.heading} {
  margin: 0; font: inherit; font-size: 14px; line-height: 20px; font-weight: 500;
  color: var(--dsw-alias-label-primary, CanvasText);
}
.${settings.card} {
  box-sizing: border-box; min-width: 0; padding: 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l3, GrayText));
  border-radius: var(--dsw-radius-xl, 16px);
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, Canvas));
}
.${settings.row} {
  display: flex; align-items: center; justify-content: space-between; gap: 8px 24px; min-width: 0;
}
/* The label column: a title, its description, and any status or error line. Every
   card stacks these with the same rhythm whether it is a settings row or a check. */
.${settings.copy} {
  display: flex; flex-direction: column; gap: 6px; min-width: 0;
  font-size: 14px; line-height: 22px; font-weight: 500;
  color: var(--dsw-alias-label-primary, CanvasText); overflow-wrap: anywhere;
}
.${settings.detail}, .${settings.version} {
  margin: 0; overflow-wrap: anywhere; font-weight: 400; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary, CanvasText);
}
.${settings.status} {
  font-weight: 400; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-tertiary, CanvasText); overflow-wrap: anywhere;
}
/* The live region is always mounted so a later notice is announced, but an empty
   one must not add a gap to the column that holds it. */
.${settings.status}:empty { display: none; }
.${settings.error} {
  margin: 0; overflow-wrap: anywhere; font-weight: 400; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-state-error-primary, CanvasText);
}
.${settings.actions} { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-block: 4px; }
.${settings.button} {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 32px; max-width: 100%; padding: 0 14px; border: 0;
  border-radius: var(--dsw-radius-md, 12px); font: inherit; font-size: 14px; line-height: 22px;
  color: var(--dsw-alias-label-primary, ButtonText); background: transparent;
  overflow-wrap: anywhere; cursor: pointer; -webkit-app-region: no-drag;
}
.${settings.button}[aria-disabled="true"] { cursor: default; opacity: .4; }
/* An action reporting its own progress keeps full contrast; only its aria-busy
   state and the spinner say it is working, so a long build never looks inert. */
.${settings.button}[aria-disabled="true"][aria-busy="true"] { opacity: 1; cursor: progress; }
.${settings.button}:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, Highlight));
  outline-offset: 2px;
}
.${settings.buttonOutline} { box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3, GrayText); }
.${settings.buttonOutline}:active:not([aria-disabled="true"]) { background: var(--dsw-alias-interactive-bg-active, transparent); }
.${settings.buttonPrimary} {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, ButtonFace));
  color: var(--dsw-alias-label-primary-foreground, ButtonText);
}
/* The in-progress state of a primary action: the same fill, drained to the
   primary-dimmed tone so the working action reads as underway, not available. */
.${settings.buttonProgress} {
  background: var(--dsw-alias-button-primary-dimmed, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-primary, ButtonText);
}
@media (hover: hover) {
  .${settings.buttonOutline}:hover:not([aria-disabled="true"]) { background: var(--dsw-alias-interactive-bg-hover, transparent); }
  .${settings.buttonPrimary}:hover:not([aria-disabled="true"]) {
    background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, ButtonFace));
  }
}
.${settings.spinner} {
  position: relative; flex: none; box-sizing: border-box;
  width: 14px; height: 14px; border-radius: 50%; corner-shape: round;
  border: 2px solid color-mix(in srgb, currentColor 32%, transparent);
  animation: ${spin} .8s linear infinite;
}
.${settings.spinner}::after {
  content: ''; position: absolute; inset: -2px; border-radius: 50%; corner-shape: round;
  background: conic-gradient(currentColor 72deg, transparent 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0);
  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 0);
}
@keyframes ${spin} { to { transform: rotate(360deg); } }
.${settings.list} { display: grid; gap: 10px; list-style: none; padding: 0; margin: 12px 0 0; }
.${settings.list} > .${settings.row} { align-items: start; }
.${settings.tag} {
  display: inline-flex; align-items: center; flex: none; border-radius: 999px; corner-shape: round;
  padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap;
  color: var(--dsw-alias-label-primary, CanvasText); background: var(--dsw-alias-bg-layer-3, ButtonFace);
}
.${settings.tagPass} {
  color: var(--dsw-alias-state-success-primary, CanvasText);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, CanvasText) 10%, transparent);
}
.${settings.tagFail} {
  color: var(--dsw-alias-state-error-primary, CanvasText);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, CanvasText) 10%, transparent);
}
.${settings.tagSkipped} { color: var(--dsw-alias-label-tertiary, GrayText); }
@media (prefers-reduced-motion: reduce) {
  .${settings.spinner} { animation: none; }
  .${settings.spinner}::after { background: conic-gradient(currentColor 200deg, transparent 0); }
}
@media (forced-colors: active) {
  .${settings.card} { border: 1px solid CanvasText; }
  .${settings.tag} { border: 1px solid CanvasText; }
  /* The translucent spinner ring has no forced-colors equivalent, so both parts
     take the system ink and the arc alone marks the rotation. */
  .${settings.spinner} { border-color: CanvasText; }
  .${settings.spinner}::after { background: conic-gradient(CanvasText 72deg, transparent 0); }
}
`;

export function renderSettingsStyles(h) {
  return h('style', null, css);
}
