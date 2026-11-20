const bg = 'var(--dsw-alias-bg-base, Canvas)';
const fg = 'var(--dsw-alias-label-primary, CanvasText)';
export const bar = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
  gap: 8, padding: '2px 6px', borderBottom: '1px solid var(--dsw-alias-border-l1, GrayText)',
};
export const accessErrors = {
  overflowWrap: 'anywhere', color: 'var(--dsw-alias-state-error-primary, CanvasText)',
  flexShrink: 0, maxHeight: '45%', overflow: 'auto', padding: '6px 10px',
};
export const viewport = { flex: 1, position: 'relative', minHeight: 0, minWidth: 0, overflow: 'hidden' };
export const fill = { position: 'absolute', inset: 0 };
export const overlay = {
  ...fill, display: 'flex', flexDirection: 'column', justifyContent: 'safe center',
  padding: 12, overflow: 'auto', overflowWrap: 'anywhere', background: bg,
};
export const panelStyle = {
  ...viewport, height: '100%', display: 'flex', flexDirection: 'column',
  background: bg, color: fg, boxSizing: 'border-box', WebkitAppRegion: 'no-drag',
};
