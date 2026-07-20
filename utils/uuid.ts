// crypto.randomUUID() only exists in a secure context (HTTPS or localhost). When
// the app is served over plain http on a LAN IP — e.g. testing the dev server
// from a phone — it's undefined and throws. getRandomValues() has no such
// restriction, so fall back to an RFC-4122 v4 built from it (or Math.random as a
// last resort). Production runs on HTTPS, so the native path is used there.
export function safeUUID(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();

  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}
