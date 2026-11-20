import { API, DESKTOP_REQUEST_HEADER, DESKTOP_REQUEST_VERSION } from '../shared/protocol.js';

export function admissionMessage(code) {
  if (code === 'origin_denied') return 'localDshRequired';
  if (code === 'access_denied') return 'signIn';
}

export async function post(path, body, signal) {
  const headers = { 'Content-Type': 'application/json' };
  const location = globalThis.location;
  if (location?.protocol === 'dsh-app:' && location.host === 'app') {
    headers[DESKTOP_REQUEST_HEADER] = DESKTOP_REQUEST_VERSION;
  }
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    mode: 'same-origin',
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const result = await response.json().catch(() => null);
  if (response.ok && result?.ok === true) return result;
  const error = new Error('Workspace browser request failed');
  if (result?.ok === false && typeof result.code === 'string' && typeof result.message === 'string') {
    error.code = result.code;
    error.userMessage = `${result.message} (${result.code})`;
  }
  throw error;
}
