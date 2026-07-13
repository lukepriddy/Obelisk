/**
 * Pinned to tailwindcss 3.4.17 — the exact version the old CDN script served —
 * so build-time output matches what the app was designed against. Styles are
 * now generated at build time instead of in the player's browser, which
 * removes the unstyled first-paint flash and the runtime dependency on
 * cdn.tailwindcss.com.
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './*.{ts,tsx}',
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};
