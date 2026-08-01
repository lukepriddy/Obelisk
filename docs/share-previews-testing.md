# Share previews — what to test before merging

This branch (`share-previews`) adds `api/render.ts` and points `/player/:tourId`
at it in `vercel.json`. **It is unmerged on purpose.** Its whole risk lives in
Vercel's routing and its error fallback, neither of which exists on localhost,
so it could not be verified when written — only reasoned about.

It also sits in front of **every player page**. A failure here is a failure of
the entire player, including links already shared. That is why it gets a preview
deploy and a checklist rather than a merge.

```bash
git checkout share-previews
vercel                      # preview deploy — NOT --prod
```

## Test in this order

The first two are the ones that matter. If either fails, do not merge.

**1. A player page still works.** Open the preview's `/player/<tour-id>` in a
browser. It should behave exactly as production does. This is the whole risk in
one check.

**2. The fallback actually falls back.** In the Vercel dashboard, unset
`VITE_SUPABASE_URL` for the preview environment, redeploy, and load a player
page again. It must still work, just without preview tags. The code is written
so every failure path serves the untouched shell; this proves it rather than
assuming it.

**3. Tags are present and correct.**

```bash
curl -s https://<preview-url>/player/<tour-id> | grep -E 'og:|twitter:|<title>'
```

Expect `og:title`, `og:description` starting with the planning line
("0.8 mi · 5 stops · about 40 min"), `og:image` if the tour has a cover image,
and a canonical URL.

**4. A private tour leaks nothing.** Same curl against an unpublished tour id.
There should be **no** `og:` tags — reads use the anon key, so RLS refuses it.
If tags appear for a private tour, stop: the function is reading with more
privilege than intended.

**5. Render it for real.** Paste the preview link into iMessage, Slack, or
<https://cards-dev.twitter.com/validator>. Crawlers cache aggressively, so use a
fresh URL for each attempt rather than re-testing the same one.

**6. Non-player routes are untouched.** Load `/`, `/terms`, `/editor/<id>`.
These still hit the catch-all rewrite and must be unaffected.

## The two things most likely to be wrong

**Environment variables may not reach the function.** `VITE_`-prefixed variables
are a Vite build-time convention. The function reads them from `process.env` at
*runtime*, which means they must exist in the Vercel project's environment for
Preview/Production, not merely be inlined at build. If they aren't there,
`fetchTour` returns null and every page serves without tags — a silent no-op
rather than a break. **If test 3 shows no tags but test 1 passes, this is why.**
Fix by confirming both variables are set for the deployed environment, or by
adding non-prefixed aliases.

**The shell fetch could loop.** The function fetches `${origin}/index.html` to
get the built HTML. `/index.html` matches the catch-all rewrite whose
destination is `/index.html`. This should resolve to the static asset rather
than recurse, but it is the assumption in this code I am least sure of. A hang
or a 500 on every player page is what it would look like — and test 1 catches it
immediately.

If it does loop, the fix is to stop fetching the shell over HTTP and read it
from the filesystem instead, which trades this risk for a dependency on Vercel's
output layout.

## Notes

- Caching is `s-maxage=300, stale-while-revalidate=86400`, so an edited tour
  updates its preview within about five minutes. Crawlers cache far longer on
  their own side regardless.
- The distance maths is duplicated from `utils/trail.ts` because the function
  runs server-side and cannot import the app's module graph. If the route
  approximation changes in one place, change it in both.
