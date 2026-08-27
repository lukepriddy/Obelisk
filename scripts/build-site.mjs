/**
 * Builds the blog, the sitemap and the feed for obelisk.place.
 *
 * Run it after adding or editing anything in site/posts:
 *
 *   node scripts/build-site.mjs
 *
 * WHY A SCRIPT AND NOT A FRAMEWORK. The site is plain files with no build step,
 * which is the property that makes it impossible for it to break the product it
 * describes. A blog needs three things kept in sync (the post page, the index,
 * the feed) and keeping those in sync by hand is how a blog ends up with a post
 * nobody can find. This generates all three from one source and is still just
 * files afterwards: what ships is HTML, and this never runs in production.
 *
 * The Markdown subset is deliberate rather than lazy. A dependency here would
 * be the only one in the whole site, and the syntax below covers what a post
 * actually uses. Anything it does not understand passes through as text, which
 * is visible immediately rather than silently wrong.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const POSTS = join(SITE, 'posts');
const ORIGIN = 'https://obelisk.place';

// ── Markdown ────────────────────────────────────────────────────────────────

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline: links, bold, italic, code. Order matters; code first so its
 *  contents cannot then be treated as emphasis. */
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, h) =>
      `<a href="${h}"${h.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

function markdown(src) {
  const out = [];
  const lines = src.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (/^###\s/.test(line))  { out.push(`<h3>${inline(line.slice(4))}</h3>`); i++; continue; }
    if (/^##\s/.test(line))   { out.push(`<h2>${inline(line.slice(3))}</h2>`); i++; continue; }
    if (/^---\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`);
      continue;
    }

    if (/^[-*]\s/.test(line)) {
      const buf = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) { buf.push(lines[i].slice(2)); i++; }
      out.push('<ul>' + buf.map(b => `<li>${inline(b)}</li>`).join('') + '</ul>');
      continue;
    }

    // Paragraph: everything up to the next blank line.
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{2,3}\s|>|[-*]\s|---\s*$)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n      ');
}

/** `---` frontmatter, `key: value` per line. */
function parsePost(file) {
  const raw = readFileSync(join(POSTS, file), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing frontmatter block`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  // image is optional. A post without one still publishes; the card just
  // shows a tinted placeholder rather than a broken frame.
  for (const need of ['title', 'date', 'description', 'slug']) {
    if (!meta[need]) throw new Error(`${file}: frontmatter is missing "${need}"`);
  }
  const body = m[2].trim();
  // 220wpm, rounded up, which is close enough to be useful and never says 0.
  meta.minutes = Math.max(1, Math.round(body.split(/\s+/).length / 220));
  meta.html = markdown(body);
  meta.url = `${ORIGIN}/blog/${meta.slug}`;
  meta.image = meta.image || '';
  meta.socialImage = meta.image ? ORIGIN + meta.image : `${ORIGIN}/og.png`;
  meta.pretty = new Date(meta.date + 'T12:00:00Z').toLocaleDateString('en-US',
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return meta;
}

// ── Shared chrome ───────────────────────────────────────────────────────────

const nav = `
<header>
  <div class="wrap bar">
    <a class="brand" href="/">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:var(--accent)">
        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>
      </svg>
      Obelisk
    </a>
    <nav>
      <a href="/about">About</a>
      <a href="/blog">Blog</a>
      <a class="cta" href="/#pricing">Start building</a>
    </nav>
  </div>
</header>`;

const footer = `
<footer>
  <div class="wrap footrow">
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/blog">Blog</a>
    <a href="/feed.xml">RSS</a>
    <span class="spacer faint">
      Map tiles by <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>,
      data by <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>
    </span>
  </div>
</footer>`;

const head = ({ title, description, canonical, extraSchema = '', ogType = 'website', image = `${ORIGIN}/og.png` }) => `  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${canonical}">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">

  <meta property="og:type" content="${ogType}">
  <meta property="og:site_name" content="Obelisk">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${image}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${image}">

  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/icons/favicon.svg" type="image/svg+xml">
  <link rel="alternate" type="application/rss+xml" title="Obelisk blog" href="/feed.xml">
  <link rel="stylesheet" href="/styles.css">
${extraSchema}`;

const json = obj => `  <script type="application/ld+json">\n${JSON.stringify(obj, null, 2)}\n  </script>`;

// ── Build ───────────────────────────────────────────────────────────────────

// Underscore-prefixed files are notes to whoever is writing, not posts. A
// naming convention rather than a hardcoded filename, so a second note does
// not need a second exception here.
const posts = readdirSync(POSTS)
  .filter(f => f.endsWith('.md') && !f.startsWith('_'))
  .map(parsePost)
  .sort((a, b) => b.date.localeCompare(a.date));

mkdirSync(join(SITE, 'blog'), { recursive: true });

for (const [i, p] of posts.entries()) {
  const next = posts[i - 1];       // newer
  const prev = posts[i + 1];       // older
  const schema = json({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: p.title,
    description: p.description,
    datePublished: p.date,
    dateModified: p.date,
    author: { '@type': 'Organization', name: 'Obelisk', url: ORIGIN },
    publisher: { '@type': 'Organization', name: 'Obelisk', url: ORIGIN },
    mainEntityOfPage: { '@type': 'WebPage', '@id': p.url },
    ...(p.image ? { image: ORIGIN + p.image } : {}),
    isPartOf: { '@type': 'Blog', name: 'Obelisk blog', '@id': `${ORIGIN}/blog` },
  }) + '\n' + json({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${ORIGIN}/blog` },
      { '@type': 'ListItem', position: 3, name: p.title, item: p.url },
    ],
  });

  writeFileSync(join(SITE, 'blog', `${p.slug}.html`), `<!DOCTYPE html>
<html lang="en">
<head>
${head({ title: `${p.title} | Obelisk`, description: p.description, canonical: p.url, extraSchema: schema, ogType: 'article', image: p.socialImage })}
</head>
<body>
${nav}

<main>
  <article class="wrap post">
    <p class="post-back"><a class="backlink" href="/blog">All posts</a></p>
    <header class="posthead">
      <p class="eyebrow">
        <time datetime="${p.date}">${p.pretty}</time>
        <span class="dot-sep">&middot;</span>${p.minutes} min read
      </p>
      <h1>${esc(p.title)}</h1>
      <p class="lead">${esc(p.description)}</p>
    </header>
    ${p.image ? `<img class="post-hero" src="${p.image}" alt="" width="1200" height="675">` : ''}
    <div class="prose">
      ${p.html}
    </div>

    <aside class="post-cta">
      <h2>Build one yourself</h2>
      <p>Obelisk is a platform for location-based experiences: audio zones, AI characters, AR, and game mechanics, all in a browser.</p>
      <a class="cta" href="/#pricing">Start building</a>
    </aside>

    <nav class="post-nav">
      ${prev ? `<a href="/blog/${prev.slug}"><span class="faint">Older</span>${esc(prev.title)}</a>` : '<span></span>'}
      ${next ? `<a class="next" href="/blog/${next.slug}"><span class="faint">Newer</span>${esc(next.title)}</a>` : '<span></span>'}
    </nav>
  </article>
</main>
${footer}
</body>
</html>
`);
}

// Index
const blogSchema = json({
  '@context': 'https://schema.org',
  '@type': 'Blog',
  '@id': `${ORIGIN}/blog`,
  name: 'Obelisk blog',
  description: 'Notes on building location-based experiences: geolocated audio, AI characters, AR, and game mechanics.',
  url: `${ORIGIN}/blog`,
  publisher: { '@type': 'Organization', name: 'Obelisk', url: ORIGIN },
  blogPost: posts.map(p => ({
    '@type': 'BlogPosting', headline: p.title, description: p.description,
    datePublished: p.date, url: p.url,
  })),
});

writeFileSync(join(SITE, 'blog.html'), `<!DOCTYPE html>
<html lang="en">
<head>
${head({
  // The phrase is the masthead; the word "blog" is what somebody searching
  // types. The title carries both, the h1 carries the phrase.
  title: 'Building on reality | Obelisk blog',
  description: 'Writing from Obelisk, a platform for building location-based experiences with geolocated audio, AI characters, AR and game mechanics.',
  canonical: `${ORIGIN}/blog`,
  extraSchema: blogSchema,
})}
</head>
<body>
${nav}

<main>
  <div class="wrap blog-index">
    <h1 class="blog-masthead">Building on reality</h1>
    <ul class="posts">
${posts.map(p => `      <li>
        <a href="/blog/${p.slug}">
          <span class="post-thumb"${p.image ? ` style="background-image:url(${p.image})"` : ''}></span>
          <span class="post-body">
            <span class="eyebrow"><time datetime="${p.date}">${p.pretty}</time><span class="dot-sep">&middot;</span>${p.minutes} min read</span>
            <span class="post-title">${esc(p.title)}</span>
            <span class="muted">${esc(p.description)}</span>
            <span class="readmore">Read it</span>
          </span>
        </a>
      </li>`).join('\n')}
    </ul>
  </div>
</main>
${footer}
</body>
</html>
`);

// Sitemap
const staticPages = [
  { loc: `${ORIGIN}/`, priority: '1.0', freq: 'weekly' },
  { loc: `${ORIGIN}/about`, priority: '0.7', freq: 'monthly' },
  { loc: `${ORIGIN}/blog`, priority: '0.8', freq: 'weekly' },
];
const today = new Date().toISOString().slice(0, 10);
writeFileSync(join(SITE, 'sitemap.xml'),
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticPages.map(p => `  <url>
    <loc>${p.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${p.freq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n')}
${posts.map(p => `  <url>
    <loc>${p.url}</loc>
    <lastmod>${p.date}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.6</priority>
  </url>`).join('\n')}
</urlset>
`);

// Feed
writeFileSync(join(SITE, 'feed.xml'),
`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Obelisk blog</title>
    <link>${ORIGIN}/blog</link>
    <description>Notes on building location-based experiences.</description>
    <language>en</language>
    <atom:link href="${ORIGIN}/feed.xml" rel="self" type="application/rss+xml"/>
${posts.map(p => `    <item>
      <title>${esc(p.title)}</title>
      <link>${p.url}</link>
      <guid isPermaLink="true">${p.url}</guid>
      <pubDate>${new Date(p.date + 'T12:00:00Z').toUTCString()}</pubDate>
      <description>${esc(p.description)}</description>
    </item>`).join('\n')}
  </channel>
</rss>
`);

console.log(`${posts.length} posts -> site/blog/, blog.html, sitemap.xml, feed.xml`);
for (const p of posts) console.log(`  ${p.date}  ${p.minutes}min  /blog/${p.slug}`);
