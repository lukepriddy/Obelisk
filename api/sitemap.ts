/**
 * sitemap.xml — the list of pages worth indexing.
 *
 * Generated rather than static: the set of public experiences changes whenever
 * a creator publishes or unpublishes, and a stale sitemap pointing at removed
 * pages is worse than none.
 *
 * Served only on the canonical host, and empty until PUBLIC_SITE_ORIGIN is set,
 * matching api/robots.ts. A sitemap advertising throwaway addresses would
 * actively invite the indexing the robots rules exist to prevent.
 *
 * Reads with the ANON key, so RLS decides what is readable at all: anonymous
 * reads are already scoped to is_public = true. An unpublished tour cannot
 * appear here even by mistake, because the same rule that hides it from the
 * player hides it from this.
 *
 * Two further filters on top of that. Moderation status, because approved is
 * what "public" actually means once the gate is involved. And is_listed, which
 * is how an unlisted experience stays out of search while remaining fully
 * reachable by anyone holding the link — shared with a friend, or used for
 * field testing, without being volunteered to a crawler.
 */

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

const FETCH_TIMEOUT_MS = 2500;

type NodeReq = { headers: Record<string, string | string[] | undefined> };
type NodeRes = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

const firstHeader = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();

const escapeXml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

type TourRow = { id: string };

async function fetchPublicTours(): Promise<TourRow[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      // published_snapshot=not.is.null is not belt and braces, it is the
      // filter that matters. A tour with no approved snapshot has nothing for
      // the player or the share preview to serve, so listing it would publish
      // a URL that renders an empty shell. That failure is silent and only
      // shows up as 404s in Search Console months later.
      // public_tours already restricts itself to published rows that have an
      // approved snapshot, so the only filter left here is the listing
      // preference. That is not just tidiness: the view is what keeps drafts
      // out of reach, and a query against the table would need SELECT on every
      // column it filters on.
      `${SUPABASE_URL}/rest/v1/public_tours?select=id&is_listed=eq.true`,
      {
        headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        signal: controller.signal,
      },
    );
    if (!res.ok) return [];
    return (await res.json()) as TourRow[];
  } catch {
    // An empty sitemap is a recoverable disappointment; a 500 on a file
    // crawlers fetch repeatedly is a signal the site is unhealthy.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req: NodeReq, res: NodeRes): Promise<void> {
  const host = (firstHeader(req.headers['x-forwarded-host']) ||
    firstHeader(req.headers.host)).toLowerCase();

  const origin = (process.env.PUBLIC_SITE_ORIGIN || '').replace(/\/+$/, '');
  let canonicalHost: string | null = null;
  try {
    canonicalHost = origin ? new URL(origin).host.toLowerCase() : null;
  } catch {
    canonicalHost = null;
  }

  const urls: string[] = [];
  if (canonicalHost && host === canonicalHost) {
    urls.push(`${origin}/`);
    for (const tour of await fetchPublicTours()) {
      if (tour.id) urls.push(`${origin}/player/${tour.id}`);
    }
  }

  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map(url => `  <url><loc>${escapeXml(url)}</loc></url>\n`).join('') +
    '</urlset>\n';

  res.statusCode = 200;
  res.setHeader('content-type', 'application/xml; charset=utf-8');
  res.setHeader('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  if (!(canonicalHost && host === canonicalHost)) {
    res.setHeader('x-robots-tag', 'noindex, nofollow');
  }
  res.end(body);
}
