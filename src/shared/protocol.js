export const API = '/dsh-browser/v1';
export const DESKTOP_REQUEST_HEADER = 'x-dsh-workspace-browser-desktop';
export const DESKTOP_REQUEST_VERSION = '1';
export const MAX_FRAME = 256 * 1024;
export const MAX_CHUNK = 32 * 1024;

export function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

export function publicOrigin(value) {
  if (typeof value !== 'string' || value.length > 512 || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.port) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export class BrowserError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
