/**
 * Validation for a creator's support links.
 *
 * This started as a host allowlist (PayPal, Venmo, Ko-fi, Buy Me a Coffee) and
 * that was wrong twice over.
 *
 * It secured nothing. The check only ever ran in the browser, so a creator
 * posting straight to PostgREST could set any URL they liked. It was a
 * suggestion wearing a lock's clothing.
 *
 * And it blocked the obvious case. The first real link anybody tried to add was
 * a personal website, which is a perfectly ordinary place to send someone who
 * wants to support you, and the allowlist refused it.
 *
 * So the fake control is gone and a real one takes its place: closing-card text
 * and links are now part of what moderate-tour reviews before an experience can
 * go public. What stays here is the part that is genuinely about correctness,
 * not trust.
 */

/** null when the link is usable, otherwise the reason it is not. */
export function donationUrlError(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Add a link.';

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Much the commonest mistake: pasting a bare domain. Say what to do rather
    // than just refusing it.
    return /^[\w.-]+\.[a-z]{2,}/i.test(value)
      ? 'Add https:// to the start of that link.'
      : 'That is not a complete link.';
  }

  // http would send a payment link over a channel anyone on the network can
  // rewrite, which matters more here than almost anywhere else in the app.
  if (url.protocol !== 'https:') return 'The link has to start with https://';

  return null;
}
