/**
 * moderate-tour edge function
 *
 * The publish gate. A creator flipping a tour public calls this; it runs one
 * AI safety pass and — as the service role — writes both the verdict and
 * `is_public` itself. The `enforce_moderation_gate` trigger on `tours` means
 * this is the ONLY way an ordinary creator's tour can become public, so
 * bypassing the UI (calling PostgREST straight from devtools) doesn't work.
 *
 * Deliberate design choices:
 *   • Uses the PLATFORM Gemini key, never the creator's BYOK key. Moderation
 *     must not be performed with a key controlled by the party under review.
 *   • Re-reads all content from the database rather than trusting anything in
 *     the request body — the client only supplies a tour id.
 *   • Fails to `pending_review`, never to `approved`. An API outage must not
 *     become an open publish gate.
 *   • Platform admins skip the check entirely (their tours are exempt by
 *     product decision), matching the trigger's own admin exemption.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const GEMINI_API_KEY   = Deno.env.get('GEMINI_API_KEY') ?? '';
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const MODEL       = 'gemini-2.5-flash';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Images cost tokens and latency; a tour's first few are representative. */
const MAX_IMAGES = 6;
const IMAGE_FETCH_TIMEOUT_MS = 6000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const GEMINI_TIMEOUT_MS = 45000;

const ALLOWED_ORIGINS = [
  'https://obelisk-main.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
];

function corsFor(req: Request) {
  const origin = req.headers.get('Origin') ?? '';
  const ok = ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/obelisk-main-[a-z0-9]+-lukepriddys-projects\.vercel\.app$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

const SYSTEM_INSTRUCTION = `
You review user-created walking tours for a location-based storytelling app
before they are published publicly. Tours are fiction: mysteries, ghost
stories, horror, historical drama, scavenger hunts. Players walk a real route
and listen to audio, read text, and chat with AI characters.

Your job is to catch content that is genuinely harmful, NOT to enforce taste,
tone, or genre. Be decisive.

Return "fail" ONLY for content that is clearly one of:
  - Sexual content involving minors, or any sexualisation of children
  - Sexually explicit content
  - Hate speech or dehumanising attacks on a protected group
  - Harassment, threats, or doxxing aimed at a real, identifiable person
  - Credible incitement to real-world violence, or instructions for weapons,
    explosives, or other means of causing real harm
  - Promotion or glamorisation of self-harm or suicide
  - Instructions facilitating serious crime (drug synthesis, trafficking,
    hacking a real system)

Return "pass" for everything else. In particular, DO pass:
  - Dark, frightening, violent, gory, or morbid FICTION, including murder,
    ghosts, monsters, war, disaster, crime, and death
  - Villainous AI characters who are menacing, cruel, deceptive, or hostile
    in character
  - Profanity and crude humour
  - Real historical atrocities described for educational or memorial purposes
  - Rough drafts, placeholder text, empty or nonsense filler content

Return "borderline" ONLY when you genuinely cannot decide — for example when
content might be targeted harassment of a real person but might be fiction.
Prefer pass or fail; borderline sends the tour to a slow human queue, so
overusing it degrades the product.

Do NOT evaluate physical or real-world safety. You cannot see where these GPS
coordinates lead, and you must not guess whether a location is dangerous,
private property, or trespassing. That is handled separately. Judge only the
words and images you are given.

"reason" must be written directly to the creator, in one or two plain
sentences, saying specifically what must change. Leave it empty when passing.
`.trim();

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'borderline'] },
    reason: { type: 'string' },
    flagged_categories: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'reason', 'flagged_categories'],
};

/** Collect every creator-authored string on the tour, labelled for context. */
function textForReview(tour: Record<string, unknown>, zones: Record<string, unknown>[]) {
  const lines: string[] = [
    `TOUR TITLE: ${tour.title ?? ''}`,
    `TOUR DESCRIPTION: ${tour.description ?? ''}`,
  ];
  if (tour.welcome_subtitle) lines.push(`WELCOME SUBTITLE: ${tour.welcome_subtitle}`);

  zones.forEach((z, i) => {
    const parts: string[] = [`\n--- ZONE ${i + 1} (${z.type ?? 'audio'}) ---`];
    const push = (label: string, v: unknown) => {
      if (typeof v === 'string' && v.trim()) parts.push(`${label}: ${v}`);
    };
    push('TITLE', z.title);
    push('DESCRIPTION', z.description);
    push('ENTRY MESSAGE', z.entry_message);
    push('CHARACTER PERSONA', z.character_prompt);
    push('CHARACTER GREETING', z.greeting_message);
    push('CHARACTER BIO', z.character_bio);
    push('LOCK HINT', z.lock_hint);
    lines.push(parts.join('\n'));
  });

  // Guard against a pathologically large tour blowing the context window.
  return lines.join('\n').slice(0, 100_000);
}

/** Fetch an image and return it as a Gemini inline_data part, or null. */
async function imagePart(url: string): Promise<Record<string, unknown> | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;

    const mime = res.headers.get('content-type') ?? '';
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(mime)) return null;

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;

    let binary = '';
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
    return { inline_data: { mime_type: mime.split(';')[0], data: btoa(binary) } };
  } catch {
    // A broken or slow image must not fail the whole review.
    return null;
  }
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  let tourId = '';

  try {
    const body = await req.json().catch(() => ({}));
    tourId = typeof body?.tourId === 'string' ? body.tourId : '';
    if (!UUID_RE.test(tourId)) return json({ error: 'Invalid request.' }, 400);

    // ── Caller must own the tour ────────────────────────────────────────────
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: userRes } = await admin.auth.getUser(jwt);
    const uid = userRes?.user?.id;
    if (!uid) return json({ error: 'Not signed in.' }, 401);

    const { data: tour } = await admin
      .from('tours')
      .select('id, owner_id, title, description, welcome_subtitle, welcome_image_url')
      .eq('id', tourId)
      .maybeSingle();
    if (!tour) return json({ error: 'Experience not found.' }, 404);
    if (tour.owner_id !== uid) return json({ error: 'Not your experience.' }, 403);

    // ── Terms must be accepted before anything goes live ────────────────────
    // Checked here rather than only in the UI: publishing is the moment a
    // creator takes on responsibility for sending real people to a real place,
    // and a dialog the client could skip would be worthless as a record.
    const { data: tosRow } = await admin.rpc('current_tos_version');
    const requiredVersion = typeof tosRow === 'string' ? tosRow : null;
    if (requiredVersion) {
      const { data: accepted } = await admin.rpc('has_accepted_tos', {
        uid, v: requiredVersion,
      });
      if (!accepted) {
        return json({
          error: 'terms_required',
          requiredVersion,
          message: 'Accept the creator terms before publishing.',
        }, 412);
      }
    }

    // ── Admin exemption (mirrors the DB trigger) ────────────────────────────
    const { data: adminRow } = await admin
      .from('platform_admins').select('user_id').eq('user_id', uid).maybeSingle();
    if (adminRow) {
      await admin.from('tours').update({
        moderation_status: 'approved',
        moderation_reason: null,
        moderation_categories: null,
        moderated_at: new Date().toISOString(),
        is_public: true,
      }).eq('id', tourId);
      return json({ verdict: 'pass', status: 'approved', is_public: true, exempt: true });
    }

    if (!GEMINI_API_KEY) {
      // No key configured is an outage, not a pass.
      await admin.from('tours').update({
        moderation_status: 'pending_review',
        moderation_reason: 'Automatic review is temporarily unavailable. This experience is queued for a manual check.',
        moderated_at: new Date().toISOString(),
      }).eq('id', tourId);
      return json({ verdict: 'borderline', status: 'pending_review', is_public: false });
    }

    const { data: zones } = await admin
      .from('zones')
      .select('type, title, description, entry_message, character_prompt, greeting_message, character_bio, lock_hint, zone_image_url, character_image_url')
      .eq('tour_id', tourId);

    const zoneList = zones ?? [];

    // ── Build the multimodal request ────────────────────────────────────────
    const imageUrls = [
      tour.welcome_image_url,
      ...zoneList.flatMap(z => [z.zone_image_url, z.character_image_url]),
    ].filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u))
     .slice(0, MAX_IMAGES);

    const parts: Record<string, unknown>[] = [
      { text: textForReview(tour, zoneList) },
    ];
    for (const part of await Promise.all(imageUrls.map(imagePart))) {
      if (part) parts.push(part);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    const res = await fetch(
      `${GEMINI_BASE}/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
          contents: [{ role: 'user', parts }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            // Thinking tokens count against maxOutputTokens on 2.5 models —
            // without this the JSON can truncate and fail to parse.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
    ).finally(() => clearTimeout(timer));

    const data = await res.json();
    if (!res.ok) {
      console.error('moderate-tour: Gemini error', JSON.stringify(data));
      throw new Error('gemini_failed');
    }

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = JSON.parse(raw);
    const verdict = parsed?.verdict;
    if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'borderline') {
      throw new Error('unparseable_verdict');
    }

    const categories: string[] = Array.isArray(parsed.flagged_categories)
      ? parsed.flagged_categories.filter((c: unknown) => typeof c === 'string').slice(0, 12)
      : [];
    const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 600) : '';

    const status = verdict === 'pass' ? 'approved'
      : verdict === 'fail' ? 'rejected'
      : 'pending_review';

    const update: Record<string, unknown> = {
      moderation_status: status,
      moderation_reason: verdict === 'pass' ? null : (reason || 'This experience needs a manual review.'),
      moderation_categories: categories.length ? categories : null,
      moderated_at: new Date().toISOString(),
    };
    // Only a pass publishes. Everything else leaves the tour private.
    if (verdict === 'pass') update.is_public = true;

    const { error: upErr } = await admin.from('tours').update(update).eq('id', tourId);
    if (upErr) {
      console.error('moderate-tour: update failed', upErr);
      return json({ error: 'Could not save the review result.' }, 500);
    }

    return json({
      verdict,
      status,
      is_public: verdict === 'pass',
      reason: verdict === 'pass' ? null : update.moderation_reason,
      categories,
    });
  } catch (err) {
    // Fail safe: anything unexpected queues for a human, never auto-publishes.
    console.error('moderate-tour: falling back to pending_review', err);
    if (UUID_RE.test(tourId)) {
      try {
        await admin.from('tours').update({
          moderation_status: 'pending_review',
          moderation_reason: 'Automatic review could not be completed. This experience is queued for a manual check.',
          moderated_at: new Date().toISOString(),
        }).eq('id', tourId);
      } catch { /* best effort */ }
    }
    return json({
      verdict: 'borderline',
      status: 'pending_review',
      is_public: false,
      reason: 'Automatic review could not be completed. This experience is queued for a manual check.',
    });
  }
});
