import { PROJECT_ID } from './identity.js';

export const API = `/${PROJECT_ID}/v2`;
export const DESKTOP_REQUEST_HEADER = `x-${PROJECT_ID}-desktop`;
export const DESKTOP_REQUEST_VERSION = '1';
export const RESIZE_OWNER = 'resize-owner';
export const MAX_FRAME = 256 * 1024;
export const MAX_CHUNK = 32 * 1024;

export const MAX_CLIPBOARD_BYTES = 16 * 1024;
const encoder = new TextEncoder();
export function validClipboardText(value) {
  return typeof value === 'string' && value.length <= MAX_CLIPBOARD_BYTES &&
    !/[\uD800-\uDFFF]/u.test(value) && encoder.encode(value).length <= MAX_CLIPBOARD_BYTES;
}

export function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

export class BrowserError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
