import { validClipboardText as validText } from '../shared/protocol.js';
import { post } from './http.js';

const shortcut = e => !e.altKey && (((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyV')
  || (e.shiftKey && !e.ctrlKey && !e.metaKey && e.key === 'Insert'));

// One controller per connected display, never shared across disconnects or generations.
export function attachClipboard({ screen, rfb, identity, change, request = post }) {
  const doc = screen.ownerDocument, win = doc.defaultView;
  const life = new AbortController();
  let granted = false, known = false, busy = false, open = false, note, remote;
  let transfer = new AbortController(), timer, statusTimer, last, sending = false;
  const publish = () => { if (!life.signal.aborted) change({ granted, known, busy, open, note, remote }); };
  const foreground = () => !life.signal.aborted && doc.visibilityState === 'visible' && doc.hasFocus();
  const focused = () => foreground() && screen.contains(doc.activeElement);
  const call = (op, body, signal) => request(`/clipboard/${op}`, { ...identity, ...body }, signal);
  function invalidate() {
    transfer.abort(); transfer = new AbortController();
    clearTimeout(timer); last = undefined; sending = false;
  }
  function setNote(text) { if (note !== text) { note = text; publish(); } }
  function close() { open = false; remote = note = undefined; publish(); }
  function reset() { invalidate(); close(); }
  function updateGrant(value) {
    if (typeof value !== 'boolean') throw new Error('Invalid clipboard status');
    if (!known) note = undefined;
    known = true;
    if (value !== granted) { granted = value; reset(); start(); }
    publish();
  }
  let status;
  async function refresh() {
    clearTimeout(statusTimer);
    if (busy || life.signal.aborted) return;
    const ctrl = new AbortController(); status = ctrl;
    try { const result = await call('status', {}, ctrl.signal); if (!ctrl.signal.aborted) updateGrant(result.granted); }
    catch { if (!ctrl.signal.aborted) { granted = known = false; reset(); note = 'clipboardFailed'; publish(); } }
    finally {
      if (status === ctrl) {
        status = undefined;
        if (!ctrl.signal.aborted && !life.signal.aborted && !busy) statusTimer = setTimeout(refresh, 2500);
      }
    }
  }
  async function toggle(next) {
    if (!foreground() || !known || busy || granted === next) return;
    status?.abort(); clearTimeout(statusTimer); busy = true; reset();
    try { const result = await call(next ? 'grant' : 'revoke', {}, life.signal);
      if (!life.signal.aborted) updateGrant(result.granted);
    } catch { if (!life.signal.aborted) note = 'clipboardFailed'; }
    finally { if (!life.signal.aborted) { busy = false; publish(); start(); void refresh(); } }
  }
  const active = signal => !signal.aborted && granted && !busy && focused();
  function start() {
    clearTimeout(timer);
    if (active(transfer.signal) && !sending) timer = setTimeout(() => poll(transfer.signal), 250);
  }
  async function poll(signal) {
    if (!active(signal)) return;
    try {
      const { text } = await call('read', {}, signal);
      if (!active(signal)) return;
      if (text === null || validText(text)) {
        // Advance the baseline only after delivery, so a permission that arrives later still
        // delivers the text that failed. Delivery never prompts; it only reads the permission.
        if (last !== undefined && last !== text && text !== null) {
          const permission = await win.navigator.permissions?.query({ name: 'clipboard-write' });
          if (!active(signal)) return;
          if (permission?.state !== 'granted') throw new Error('Gesture required');
          await win.navigator.clipboard.writeText(text);
        }
        if (active(signal)) { last = text; if (note === 'clipboardManualHint') setNote(undefined); }
      }
    } catch { if (active(signal)) setNote('clipboardManualHint'); }
    finally { if (active(signal)) timer = setTimeout(() => poll(signal), 750); }
  }
  async function send(text) {
    if (!granted || busy || !foreground() || sending) return;
    if (!validText(text)) { note = 'clipboardInvalid'; publish(); return; }
    rfb.focus();
    if (!focused()) return;
    invalidate(); sending = true;
    const { signal } = transfer;
    try {
      await call('write', { text }, signal);
      if (!active(signal)) return;
      // noVNC may already have forwarded the physical modifier before the local paste event.
      for (const [key, code] of [[0xffe3,'ControlLeft'],[0xffe4,'ControlRight'],[0xffe1,'ShiftLeft'],[0xffe2,'ShiftRight'],[0xffeb,'MetaLeft'],[0xffec,'MetaRight']]) rfb.sendKey(key, code, false);
      rfb.sendKey(0xffe3, 'ControlLeft', true);
      try { rfb.sendKey(0x76, 'KeyV'); } finally { rfb.sendKey(0xffe3, 'ControlLeft', false); }
      last = text; close();
    } catch { if (active(signal)) { note = 'clipboardFailed'; publish(); } }
    finally { if (!signal.aborted) { sending = false; start(); } }
  }
  function key(e) {
    if (!granted || busy || !focused() || !shortcut(e)) return;
    // Leave the browser default intact: a trusted paste event supplies plain text without readText permission.
    e.stopImmediatePropagation();
    if (e.repeat) e.preventDefault();
  }
  function paste(e) {
    if (!e.isTrusted || !granted || busy || !focused()) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (Array.from(e.clipboardData?.types ?? []).includes('text/plain')) void send(e.clipboardData.getData('text/plain'));
    else { note = 'clipboardInvalid'; publish(); }
  }
  async function manual() {
    if (!granted || busy || !foreground()) return;
    invalidate(); open = true; remote = note = undefined; publish();
    const { signal } = transfer;
    try { const { text } = await call('read', {}, signal);
      if (!signal.aborted && foreground() && open) { remote = validText(text) ? text : undefined; publish(); }
    } catch { if (!signal.aborted && foreground()) { note = 'clipboardFailed'; publish(); } }
  }
  async function copy() {
    if (!open || !foreground() || remote === undefined) return;
    const { signal } = transfer;
    try { await win.navigator.clipboard.writeText(remote); }
    catch { if (!signal.aborted && open) { note = 'clipboardSelect'; publish(); } }
  }
  const listen = (target, event, fn) => target.addEventListener(event, fn, { capture: true, signal: life.signal });
  listen(screen, 'keydown', key); listen(screen, 'keyup', key); listen(screen, 'paste', paste);
  listen(screen, 'focusin', start); listen(screen, 'focusout', invalidate);
  listen(win, 'blur', e => { if (e.target === win) reset(); });
  listen(win, 'focus', e => { if (e.target === win) start(); });
  listen(doc, 'visibilitychange', () => { reset(); start(); });
  void refresh();
  return { toggle, send, copy, manual, close, dispose() { life.abort(); status?.abort(); clearTimeout(statusTimer); invalidate(); } };
}
