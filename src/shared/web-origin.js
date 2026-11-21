// Validate the authority-only spelling before URL normalizes paths and credentials.
export function normalizeWebOrigin(entry) {
  if (typeof entry !== 'string' || !/^https?:\/\/[^/?#@*%\\\s]+\/?$/i.test(entry)) return null;
  try { return new URL(entry).origin; } catch { return null; }
}
