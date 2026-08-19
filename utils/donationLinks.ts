/**
 * Where a creator is allowed to send a player for money.
 *
 * An allowlist rather than free-form URL validation. Today the only creator is
 * the platform owner, so this protects nobody; it exists because the moment
 * anyone else can publish, a creator-controlled link on a page players are
 * asked to trust is a redirect to anywhere, and retrofitting a restriction is
 * harder than starting with one.
 *
 * Extending it is a one-line change. That is deliberate: adding Ko-fi should
 * be trivial, adding an arbitrary domain should be a decision.
 */
export const DONATION_HOSTS = [
  'paypal.com',
  'paypal.me',
  'www.paypal.com',
  'www.paypal.me',
  'venmo.com',
  'www.venmo.com',
  'account.venmo.com',
  'ko-fi.com',
  'www.ko-fi.com',
  'buymeacoffee.com',
  'www.buymeacoffee.com',
] as const;

export const DONATION_HOST_LABEL = 'PayPal, Venmo, Ko-fi or Buy Me a Coffee';

/** null when the link is usable, otherwise the reason it is not. */
export function donationUrlError(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Add a link.';

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'That is not a complete link. Include https:// at the start.';
  }

  // http would send a payment link over a channel anyone on the network can
  // rewrite, which is worse here than almost anywhere else in the app.
  if (url.protocol !== 'https:') return 'The link has to start with https://';

  const host = url.hostname.toLowerCase();
  if (!DONATION_HOSTS.includes(host as typeof DONATION_HOSTS[number])) {
    return `Links are limited to ${DONATION_HOST_LABEL}.`;
  }
  return null;
}
