# Writing a post

Add a `.md` file in this folder, then run:

    node scripts/build-site.mjs

That regenerates every post page, the blog index, `sitemap.xml` and `feed.xml`
together. Doing it in one pass is the point: keeping those four in sync by hand
is how a blog ends up with a post that nothing links to and Google never finds.

## Frontmatter

Every post needs all four of these:

    ---
    title: The headline, also the <title> and the og:title
    slug: the-url, so the post lives at /blog/the-url
    date: 2026-08-26
    description: One or two sentences. Used as the meta description, the card on
      the index, the og:description and the RSS summary, so write it for a
      stranger seeing it out of context.
    ---

The build fails loudly if any are missing, rather than publishing a post with
an empty description.

## Body

Markdown, with the parts a post actually uses:

- `##` and `###` headings. Do not use `#`; the title is already the h1.
- Paragraphs, separated by a blank line.
- `**bold**`, `*italic*`, `` `code` ``, and `[links](https://example.com)`.
- `-` bullet lists.
- `>` blockquotes.
- `---` for a horizontal rule.

Anything else passes through as plain text, which you will see immediately.

## Keywords

Search terms this site competes for, worth working into titles and descriptions
where they fit honestly:

- location-based experience, location-based game
- geolocated audio, locative audio, locative storytelling
- soundwalk, audio walk, self-guided audio tour, GPS audio tour
- audio tour software, walking tour app
- museum audio guide, scavenger hunt app, treasure hunt app
- geofence, GPS-triggered audio
- AI characters, AR walking tour

Do not stuff them. A title that reads like a person wrote it will outperform
one that reads like a list, and Google truncates around 60 characters.
