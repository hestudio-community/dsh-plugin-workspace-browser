import { execFile } from 'node:child_process';

// A window title is page-controlled text: keep it one line, printable, and short
// before it ever becomes a frame or a sidebar label.
const MAX_TITLE = 512;
const POLL_MS = 500;
const TIMEOUT_MS = 800;

export function windowTitle(value) {
  if (typeof value !== 'string') return '';
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ').trim();
  return [...line].slice(0, MAX_TITLE).join('');
}

function exec(executable, args, env) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { env, timeout: TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

// Only the foreground window names the browser tab. Chromium is the sole
// application on the display, so its window title carries the active page's
// title without reading page content or using Browser Use authorization.
export async function activeWindowTitle(env) {
  const id = (await exec('xdotool', ['getactivewindow'], env)).trim();
  if (!/^[0-9]+$/.test(id)) return '';
  return windowTitle(await exec('xdotool', ['getwindowname', id], env));
}

export function watchWindowTitle(env, emit, read = activeWindowTitle, schedule = setTimeout) {
  let stopped = false;
  let previous = '';
  let timer;
  const tick = async () => {
    if (stopped) return;
    const title = await read(env).catch(() => '');
    if (stopped) return;
    if (title !== previous) {
      previous = title;
      emit({ type: 'window-title', windowTitle: title });
    }
    timer = schedule(() => void tick(), POLL_MS);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
