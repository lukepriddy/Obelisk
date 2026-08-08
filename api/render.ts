/**
 * Per-tour share previews.
 *
 * The unit of discovery for this product is the shared link. Until this
 * existed, every player link ever texted, posted or newslettered arrived as a
 * bare grey rectangle: index.html carries a <title> and nothing else, and
 * vercel.json rewrites every path to that one static file, so there was no
 * per-tour metadata even in principle.
 *
 * This serves the same HTML to crawlers and humans — no user-agent branching,
 * which can't then drift into serving two different things — with Open Graph
 * tags injected into <head>. The SPA hydrates over it exactly as before.
 *
 * SAFETY: this sits in front of every player page, so a failure here is a
 * failure of the whole player. Every path that can throw falls through to the
 * untouched static HTML. A tour that can't be read, an upstream that times
 * out, a malformed id — all of them serve the app rather than an error.
 *
 * Reads use the ANON key deliberately, never the service role. RLS already
 * scopes anonymous reads to is_public = true, so an unpublished or unapproved
 * tour produces no preview by construction. The permission model is the
 * privacy model, with no second set of rules to keep in sync.
 */

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;

/** Upstream budget. Better a plain page quickly than a rich page late. */
const FETCH_TIMEOUT_MS = 2500;

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const truncate = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

const M_PER_MILE = 1609.344;
const M_PER_FT = 0.3048;

/** Duplicated from utils/trail.ts: this runs on the server, where the app's
 *  module graph (and its browser-only imports) is not available. */
function haversine(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function formatDistance(meters: number) {
  if (!Number.isFinite(meters) || meters <= 0) return '';
  if (meters < M_PER_MILE / 4) return `${Math.round(meters / M_PER_FT / 10) * 10} ft`;
  const miles = meters / M_PER_MILE;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

function formatDuration(minutes?: number | null) {
  if (!minutes || minutes <= 0) return '';
  if (minutes < 90) return `about ${Math.round(minutes / 5) * 5} min`;
  const halves = Math.round(minutes / 30) / 2;
  const whole = Math.floor(halves);
  return `about ${halves % 1 ? `${whole}½` : `${whole}`} hr`;
}

type TourRow = {
  title?: string | null;
  description?: string | null;
  welcome_subtitle?: string | null;
  welcome_image_url?: string | null;
  duration_minutes?: number | null;
  lat?: number | null;
  lng?: number | null;
};

async function fetchTour(tourId: string): Promise<{ tour: TourRow; zones: { lat: number; lng: number }[] } | null> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;

  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const columns = 'title,description,welcome_subtitle,welcome_image_url,duration_minutes,lat,lng';
    const [tourRes, zoneRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/tours?id=eq.${encodeURIComponent(tourId)}&select=${columns}`,
        { headers, signal: controller.signal }),
      fetch(`${SUPABASE_URL}/rest/v1/zones?tour_id=eq.${encodeURIComponent(tourId)}&select=lat,lng`,
        { headers, signal: controller.signal }),
    ]);
    if (!tourRes.ok) return null;
    const tours = await tourRes.json();
    if (!Array.isArray(tours) || !tours.length) return null;
    const zones = zoneRes.ok ? await zoneRes.json().catch(() => []) : [];
    return { tour: tours[0], zones: Array.isArray(zones) ? zones : [] };
  } catch {
    // Timeout, network failure, or malformed JSON. The caller serves the
    // untouched page; a missing preview is not worth a broken player.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Distance through the zones, nearest-neighbour from the start pin. Mirrors
 *  trailStats() — see utils/trail.ts for why this is an approximation. */
function routeDistance(tour: TourRow, zones: { lat: number; lng: number }[]) {
  const placed = zones.filter(z => Number.isFinite(z.lat) && Number.isFinite(z.lng));
  if (!placed.length) return { meters: 0, count: 0 };
  const hasStart = Number.isFinite(tour.lat) && Number.isFinite(tour.lng)
    && (tour.lat !== 0 || tour.lng !== 0);
  let lat = hasStart ? (tour.lat as number) : placed[0].lat;
  let lng = hasStart ? (tour.lng as number) : placed[0].lng;

  const remaining = [...placed];
  let meters = 0;
  while (remaining.length) {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(lat, lng, remaining[i].lat, remaining[i].lng);
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    const [next] = remaining.splice(best, 1);
    meters += bestDistance;
    lat = next.lat;
    lng = next.lng;
  }
  return { meters, count: placed.length };
}

function buildTags(tour: TourRow, zones: { lat: number; lng: number }[], url: string) {
  const title = (tour.title || 'An Obelisk experience').trim();
  const { meters, count } = routeDistance(tour, zones);

  // The planning line earns its place in a preview: distance, stops, time.
  const facts = [
    formatDistance(meters),
    count ? `${count} ${count === 1 ? 'stop' : 'stops'}` : '',
    formatDuration(tour.duration_minutes),
  ].filter(Boolean).join(' · ');

  const blurb = (tour.welcome_subtitle || tour.description || '').replace(/\s+/g, ' ').trim();
  const description = truncate([facts, blurb].filter(Boolean).join(' — '), 200)
    || 'A location-based experience.';

  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Obelisk">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
  ];

  if (tour.welcome_image_url) {
    tags.push(
      `<meta property="og:image" content="${escapeHtml(tour.welcome_image_url)}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    );
  } else {
    // No image is better than a broken one. summary renders cleanly without.
    tags.push(`<meta name="twitter:card" content="summary">`);
  }

  tags.push(
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
  );

  return tags.join('\n    ');
}

/**
 * Node request/response, structurally typed so this needs no @vercel/node
 * dependency. Vercel's default runtime is Node (Fluid Compute), which calls
 * handler(req, res) — NOT the Web `Request`/`Response` signature. An earlier
 * version used the Web form, and since `req.url` is a bare path there rather
 * than an absolute URL, `new URL(req.url)` threw on the first line and every
 * player page 500'd. Switching runtimes would also work; staying on Node is
 * the currently recommended default.
 */
type NodeReq = { url?: string; headers: Record<string, string | string[] | undefined> };
type NodeRes = {
  statusCode: number;
  setHeader: (name: string, value: string) => void;
  end: (body?: string) => void;
};

const sendHtml = (res: NodeRes, body: string) => {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  // Cached at the edge so the extra hop isn't paid per visitor, and
  // revalidated in the background so an edited tour updates quickly.
  res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=86400');
  res.end(body);
};

const firstHeader = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value || '').split(',')[0].trim();

export default async function handler(req: NodeReq, res: NodeRes): Promise<void> {
  // Reconstruct the absolute URL the proxy received; behind Vercel the
  // forwarded headers are the reliable source, and req.url is path-only.
  const proto = firstHeader(req.headers['x-forwarded-proto']) || 'https';
  const host = firstHeader(req.headers['x-forwarded-host']) || firstHeader(req.headers.host);
  const origin = `${proto}://${host}`;

  // Public URLs name the real site, never the address this request happened to
  // arrive on. The deployment answers on the production domain, the project's
  // *.vercel.app address, and a new URL for every preview build; deriving the
  // canonical from the request meant each of those declared itself permanent
  // and competed with the real domain for its own content.
  //
  // Falls back to the request origin only when PUBLIC_SITE_ORIGIN is unset, in
  // which case robots.txt is refusing every host anyway, so nothing is indexed
  // for the fallback to mislabel.
  const publicOrigin = (process.env.PUBLIC_SITE_ORIGIN || origin).replace(/\/+$/, '');
  const pathname = (req.url || '/').split('?')[0];

  // The built shell, served by the same deployment. Requesting it over HTTP
  // rather than reading from disk keeps this agnostic to Vercel's output
  // layout, which is not a stable contract.
  let shell: string;
  try {
    const shellRes = await fetch(`${origin}/index.html`, { headers: { 'x-obelisk-shell': '1' } });
    if (!shellRes.ok) throw new Error(`shell ${shellRes.status}`);
    shell = await shellRes.text();
  } catch {
    // Nothing sensible to serve. Redirecting would loop; a bare 500 at least
    // surfaces the problem rather than silently serving a blank page.
    res.statusCode = 500;
    res.end('Unavailable');
    return;
  }

  try {
    const tourId = pathname.match(/^\/player\/([^/?#]+)/)?.[1];
    if (!tourId) return sendHtml(res, shell);

    const data = await fetchTour(tourId);
    if (!data) return sendHtml(res, shell);

    // publicOrigin, not origin: this URL is what a crawler records as the
    // page's permanent home, and what a shared link resolves to in a preview.
    const canonical = `${publicOrigin}/player/${tourId}`;
    // The shell already carries <title>Obelisk</title>. Appending a second one
    // does not override it — browsers and most crawlers take the FIRST — so the
    // tab and the preview would both still read "Obelisk". Strip it, and only
    // when we are actually replacing it: the early returns above deliberately
    // leave the shell untouched, default title included.
    const shellWithoutTitle = shell.replace(/[ \t]*<title>[\s\S]*?<\/title>\s*\n?/i, '');
    return sendHtml(res, shellWithoutTitle.replace(
      '</head>',
      `  ${buildTags(data.tour, data.zones, canonical)}\n  </head>`,
    ));
  } catch {
    // Any unforeseen failure past this point still serves a working player.
    return sendHtml(res, shell);
  }
}
