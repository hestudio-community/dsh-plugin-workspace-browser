const bg = 'var(--dsw-alias-bg-base, Canvas)';
const fg = 'var(--dsw-alias-label-primary, CanvasText)';
const border = '1px solid var(--dsw-alias-border-l3, GrayText)';
export const control = {
  font: 'inherit', minHeight: 28, minWidth: 0, maxWidth: '100%', color: fg,
  background: bg, border, borderRadius: 6, padding: '3px 7px', boxSizing: 'border-box',
};
export const switchControl = { ...control, display: 'inline-flex', alignItems: 'center', gap: 6 };
export const switchTrack = (checked) => ({
  display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: checked ? 'flex-end' : 'flex-start',
  width: 25, height: 14, borderRadius: 10, border: '1px solid currentColor', padding: '0 2px', boxSizing: 'border-box',
  background: checked ? 'var(--dsw-alias-bg-brand, Highlight)' : 'transparent',
});
export const switchThumb = (checked) => ({
  width: 8, height: 8, borderRadius: '50%', background: checked ? 'HighlightText' : 'currentColor',
});
export const bar = {
  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
  padding: '8px 10px', borderBottom: border, flexShrink: 0,
};
export const accessErrors = {
  overflowWrap: 'anywhere',
  flexShrink: 0, maxHeight: '45%', overflow: 'auto', padding: '6px 10px',
};
export const viewport = { flex: 1, position: 'relative', minHeight: 0, minWidth: 0, overflow: 'hidden' };
export const fill = { position: 'absolute', inset: 0 };
export const overlay = {
  ...fill, display: 'flex', flexDirection: 'column', justifyContent: 'safe center', gap: 8,
  padding: 12, overflow: 'auto', overflowWrap: 'anywhere', background: bg,
};
export const panelStyle = {
  ...viewport, height: '100%', display: 'flex', flexDirection: 'column',
  background: bg, color: fg, boxSizing: 'border-box', WebkitAppRegion: 'no-drag',
};
