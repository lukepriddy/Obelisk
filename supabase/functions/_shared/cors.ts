/**
 * Shared CORS policy for every edge function.
 *
 * This exists because the origin list used to be copy-pasted into each
 * function. When obelisk.place was bought, only the function written after
 * that point learned about it — so publishing, deleting, admin moderation,
 * AI chat, voice and generation all failed their preflight on the real
 * domain while continuing to work on *.vercel.app, where they were tested.
 * Six copies of a list is six chances to update five of them.
 *
 * One list, one builder, imported everywhere. The next domain change is one
 * edit here.
 *
 * The fallback when an origin is not allowed is deliberately the canonical
 * site rather than `*`: these endpoints act with the service role, so a
 * wildcard would let any page on the internet call them with the user's
 * credentials attached. An unrecognised origin gets a header that does not
 * match it, and the browser refuses the response — which is the point.
 */

export const ALLOWED_ORIGINS = [
  'https://obelisk.place',
  'https://obelisk-main.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
];

/** Vercel gives every preview build its own hostname; they are all ours. */
const PREVIEW_ORIGIN_RE =
  /^https:\/\/obelisk-main-[a-z0-9]+-lukepriddys-projects\.vercel\.app$/;

export function isAllowedOrigin(origin: string): boolean {
  return ALLOWED_ORIGINS.includes(origin) || PREVIEW_ORIGIN_RE.test(origin);
}

/** The CORS headers for one request. Spread into every response, including
 *  errors — a response the browser discards is indistinguishable from an
 *  outage to the person looking at the screen. */
export function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0],
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}
