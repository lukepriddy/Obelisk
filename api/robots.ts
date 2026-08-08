/**
 * robots.txt, aware of which address it is being served from.
 *
 * This deployment answers on more than one hostname: the production domain,
 * the project's *.vercel.app address, and a fresh URL for every preview build.
 * They all serve identical content, which is a duplicate-content problem, and
 * before this there was no robots.txt at all — the catch-all rewrite in
 * vercel.json served the app shell for that path, so crawlers got an HTML page
 * where they expected rules.
 *
 * Only the canonical host is allowed. Everything else is refused wholesale, so
 * throwaway addresses cannot accumulate an index that later competes with the
 * real site for its own content.
 *
 * Keyed off the request host rather than a flag, deliberately: there is no
 * moment where someone has to remember to flip it, and a new preview URL is
 * excluded the instant it exists.
 *
 * With PUBLIC_SITE_ORIGIN unset — which it is until the domain is bought —
 * nothing is treated as canonical and every host is refused. That is the right
 * default while no address is permanent yet.
 */

type NodeReq = { headers: Record<string, string | string[] | undefined> };
type NodeRes = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

const firstHeader = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();

/** Host of the one address that is allowed to be indexed, or null if unset. */
const canonicalHost = (): string | null => {
  const origin = process.env.PUBLIC_SITE_ORIGIN;
  if (!origin) return null;
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    // A malformed value must not accidentally open indexing everywhere.
    return null;
  }
};

export default function handler(req: NodeReq, res: NodeRes): void {
  const host = (firstHeader(req.headers['x-forwarded-host']) ||
    firstHeader(req.headers.host)).toLowerCase();
  const canonical = canonicalHost();
  const allowed = canonical !== null && host === canonical;

  const body = allowed
    ? [
        'User-agent: *',
        'Allow: /',
        // Nothing here is useful to a crawler and some of it is per-user.
        'Disallow: /editor',
        'Disallow: /admin',
        'Disallow: /auth',
        'Disallow: /api/',
        '',
        `Sitemap: ${process.env.PUBLIC_SITE_ORIGIN}/sitemap.xml`,
        '',
      ].join('\n')
    : ['User-agent: *', 'Disallow: /', ''].join('\n');

  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('cache-control', 'public, s-maxage=3600');
  // Belt and braces: a crawler that fetched a page before reading this still
  // gets told not to list it.
  if (!allowed) res.setHeader('x-robots-tag', 'noindex, nofollow');
  res.end(body);
}
