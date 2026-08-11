/**
 * moderate-tour edge function
 *
 * The publish gate, and the promotion step of draft/live publishing.
 *
 * A creator submits a tour for review; this builds an immutable candidate
 * snapshot, reviews THAT, and — as the service role — promotes exactly that
 * snapshot if it passes. The `enforce_moderation_gate` trigger on `tours` means
 * this is the ONLY way an ordinary creator's tour can become public or gain a
 * published snapshot, so bypassing the UI (calling PostgREST straight from
 * devtools) doesn't work.
 *
 * The shape that matters:
 *   • Saving never moderates. Only this does. The previously approved snapshot
 *     stays live until a new one passes, so a false positive can never take
 *     down a running experience mid-campaign.
 *   • The candidate snapshot is built BEFORE the model call and promoted
 *     afterwards without re-reading the draft. Otherwise an edit made during
 *     review would leak into approved content.
 *   • A failed or borderline review writes only the DRAFT review fields. It
 *     never touches is_public, moderation_status, or the live snapshot.
 *
 * Deliberate design choices carried over:
 *   • Uses the PLATFORM Gemini key, never the creator's BYOK key. Moderation
 *     must not be performed with a key controlled by the party under review.
 *   • Builds content from the database rather than trusting anything in the
 *     request body — the client only supplies a tour id.
 *   • Fails to `pending_review`, never to `approved`. An API outage must not
 *     become an open publish gate.
 *   • Platform admins skip the model call, matching the trigger's own admin
 *     exemption — but they still get a snapshot, because a public tour without
 *     one would be invisible to the readers that serve the public.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor } from '../_shared/cors.ts';

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

const COOLDOWN_SECONDS = 60;
const LOCK_TTL_SECONDS = 120;

/**
 * Rough per-token prices for the log's cost estimate, in USD per token.
 * These are an ESTIMATE for spotting runaway spend, not an invoice — the
 * authoritative number is Google's billing. The token counts stored beside it
 * come from Gemini's own usage metadata and are exact.
 */
const COST_PER_INPUT_TOKEN  = 0.30 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 2.50 / 1_000_000;

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

type Snapshot = {
  version: number;
  tour: Record<string, unknown>;
  zones: Record<string, unknown>[];
};

/**
 * Collect every creator-authored string in the CANDIDATE SNAPSHOT.
 *
 * Reads the snapshot rather than the database on purpose: the snapshot is what
 * gets promoted, so it must also be what gets reviewed. Reading the draft here
 * would mean an edit landing mid-review could be approved without being seen.
 */
function textForReview(snap: Snapshot) {
  const tour = snap.tour ?? {};
  const zones = Array.isArray(snap.zones) ? snap.zones : [];

  const lines: string[] = [
    `TOUR TITLE: ${tour.title ?? ''}`,
    `TOUR DESCRIPTION: ${tour.description ?? ''}`,
  ];
  if (tour.welcome_subtitle) lines.push(`WELCOME SUBTITLE: ${tour.welcome_subtitle}`);

  // Progression resource names are creator-authored and shown in the player's
  // HUD for the whole walk, so they are as visible as any zone title.
  const resources = Array.isArray(tour.progression_resources) ? tour.progression_resources : [];
  const resourceNames = resources
    .map(r => (r as Record<string, unknown>)?.name)
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '');
  if (resourceNames.length) lines.push(`HUD RESOURCE NAMES: ${resourceNames.join(', ')}`);

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
    // The narration script. Players HEAR this, which makes it among the most
    // player-facing text a tour has, and it was going unreviewed: the finished
    // audio is deliberately not moderated (notice-and-takedown covers it), so
    // skipping the script meant nothing checked it at any point. The script is
    // plain text sitting in the same row as everything else here, so reviewing
    // it costs almost nothing.
    push('NARRATION SCRIPT', z.voiceover_script);
    // Delivery direction. Less visible, but it is creator-authored text that
    // gets fed to a speech model, so it belongs in the same pass.
    push('VOICE DIRECTION', z.voice_instructions);
    lines.push(parts.join('\n'));
  });

  // Guard against a pathologically large tour blowing the context window.
  return lines.join('\n').slice(0, 100_000);
}

function imageUrlsFrom(snap: Snapshot): string[] {
  const tour = snap.tour ?? {};
  const zones = Array.isArray(snap.zones) ? snap.zones : [];
  return [
    tour.welcome_image_url,
    ...zones.flatMap(z => [z.zone_image_url, z.character_image_url]),
  ].filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u))
   .slice(0, MAX_IMAGES);
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
  let uid = '';
  let lockHeld = false;
  let quotaTaken = false;

  /** Always run, so a crashed review doesn't wedge the tour until the TTL. */
  const releaseLock = async () => {
    if (!lockHeld) return;
    lockHeld = false;
    try { await admin.rpc('end_moderation_attempt', { p_tour_id: tourId }); }
    catch { /* the TTL is the backstop */ }
  };

  try {
    const body = await req.json().catch(() => ({}));
    tourId = typeof body?.tourId === 'string' ? body.tourId : '';
    if (!UUID_RE.test(tourId)) return json({ error: 'Invalid request.' }, 400);

    // ── Caller must own the tour ────────────────────────────────────────────
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: userRes } = await admin.auth.getUser(jwt);
    uid = userRes?.user?.id ?? '';
    if (!uid) return json({ error: 'Not signed in.' }, 401);

    const { data: tour } = await admin
      .from('tours')
      .select('id, owner_id, is_public')
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

    // ── One review at a time, and not too often ─────────────────────────────
    // Before any work: this also covers the attempts the cache would answer for
    // free, so holding the button down cannot become a hot loop.
    const { data: attempt } = await admin.rpc('begin_moderation_attempt', {
      p_tour_id: tourId,
      p_cooldown_seconds: COOLDOWN_SECONDS,
      p_lock_ttl_seconds: LOCK_TTL_SECONDS,
    });
    if (attempt !== 'ok') {
      return json({
        verdict: 'borderline',
        status: 'cooldown',
        is_public: tour.is_public,
        reason: attempt === 'busy'
          ? 'This experience is being reviewed right now. Give it a moment.'
          : 'You just submitted this experience. Try again in a minute.',
      }, 429);
    }
    lockHeld = true;

    // ── Build the candidate ─────────────────────────────────────────────────
    // Everything from here on reviews and promotes THIS value. The draft is
    // never read again, so edits made during review cannot leak into the
    // approved content.
    const { data: policyVersion } = await admin.rpc('current_moderation_policy_version');
    const { data: snapshot, error: snapErr } =
      await admin.rpc('build_tour_snapshot', { p_tour_id: tourId });
    if (snapErr || !snapshot) {
      console.error('moderate-tour: snapshot build failed', snapErr);
      throw new Error('snapshot_failed');
    }
    const { data: contentHash } = await admin.rpc('tour_snapshot_hash', {
      p_snapshot: snapshot, p_policy_version: policyVersion,
    });

    const snap = snapshot as Snapshot;

    /** Promote the candidate. Writes the exact snapshot reviewed. */
    const promote = async (logRow: Record<string, unknown>) => {
      const { error } = await admin.from('tours').update({
        published_snapshot: snapshot,
        published_hash: contentHash,
        moderation_status: 'approved',
        moderation_reason: null,
        moderation_categories: null,
        moderated_at: new Date().toISOString(),
        is_public: true,
        // The draft is now the live version, so there is no outstanding
        // verdict about it.
        draft_review_status: null,
        draft_review_reason: null,
        draft_review_categories: null,
        draft_reviewed_at: null,
      }).eq('id', tourId);
      if (error) throw new Error(`promote_failed: ${error.message}`);
      await admin.from('moderation_runs').insert({
        tour_id: tourId, creator_id: uid, content_hash: contentHash,
        policy_version: policyVersion, promoted: true, ...logRow,
      });
    };

    /** Record a verdict about the DRAFT. Never touches the live version. */
    const recordDraftVerdict = async (
      status: 'rejected' | 'pending_review', reason: string, categories: string[],
    ) => {
      await admin.from('tours').update({
        draft_review_status: status,
        draft_review_reason: reason,
        draft_review_categories: categories.length ? categories : null,
        draft_reviewed_at: new Date().toISOString(),
      }).eq('id', tourId);
    };

    // ── Platform admin exemption (mirrors the DB trigger) ───────────────────
    const { data: adminRow } = await admin
      .from('platform_admins').select('user_id').eq('user_id', uid).maybeSingle();
    if (adminRow) {
      // Logged as 'exempt', not 'pass'. approval_is_reusable only accepts
      // 'pass', so an admin's unreviewed content never becomes a cached
      // approval that a non-admin could ride through the gate by copying it.
      await promote({ model: 'admin-exempt', verdict: 'exempt', reason: null });
      await releaseLock();
      return json({ verdict: 'pass', status: 'approved', is_public: true, exempt: true });
    }

    // ── Has this exact content already been approved? ───────────────────────
    // Two separate questions, deliberately. A matching fingerprint says the
    // content is identical; it does not say the content is allowed. A tour that
    // was rejected or taken down has its past approvals revoked, so it comes
    // back through the gate even though nothing changed.
    const { data: reusable } = await admin.rpc('approval_is_reusable', {
      p_hash: contentHash, p_policy_version: policyVersion,
    });
    if (reusable) {
      await promote({ model: 'cache', verdict: 'pass', reason: null, estimated_cost_usd: 0 });
      await releaseLock();
      return json({ verdict: 'pass', status: 'approved', is_public: true, cached: true });
    }

    if (!GEMINI_API_KEY) {
      // No key configured is an outage, not a pass. The live version stands.
      await recordDraftVerdict('pending_review',
        'Automatic review is temporarily unavailable. This experience is queued for a manual check.', []);
      await releaseLock();
      return json({ verdict: 'borderline', status: 'pending_review', is_public: tour.is_public });
    }

    // ── Daily ceiling ───────────────────────────────────────────────────────
    // Taken last, immediately before the only step that costs money. Everything
    // above is free, so a cache hit or a cooldown must not burn a slot.
    const { data: gotQuota } = await admin.rpc('consume_moderation_quota', { p_user: uid });
    if (!gotQuota) {
      await recordDraftVerdict('pending_review',
        'You have submitted a lot of updates today. Try again tomorrow.', []);
      await releaseLock();
      return json({
        verdict: 'borderline',
        status: 'pending_review',
        is_public: tour.is_public,
        reason: 'You have submitted a lot of updates today. Try again tomorrow.',
      }, 429);
    }
    quotaTaken = true;

    // ── The review ──────────────────────────────────────────────────────────
    const parts: Record<string, unknown>[] = [{ text: textForReview(snap) }];
    for (const part of await Promise.all(imageUrlsFrom(snap).map(imagePart))) {
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

    // Past this point Gemini produced a billable response, so the slot stays
    // spent whatever the verdict turns out to be.
    quotaTaken = false;

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

    const usage = data?.usageMetadata ?? {};
    const promptTokens = Number(usage.promptTokenCount) || 0;
    const outputTokens = Number(usage.candidatesTokenCount) || 0;
    const logRow = {
      model: MODEL,
      verdict,
      reason: reason || null,
      categories: categories.length ? categories : null,
      prompt_tokens: promptTokens,
      output_tokens: outputTokens,
      total_tokens: Number(usage.totalTokenCount) || promptTokens + outputTokens,
      estimated_cost_usd:
        promptTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN,
    };

    if (verdict === 'pass') {
      await promote(logRow);
      await releaseLock();
      return json({ verdict, status: 'approved', is_public: true, categories });
    }

    // Failed or borderline. The live version is untouched — same snapshot, same
    // is_public, same moderation_status. Only the draft carries the verdict.
    const draftStatus = verdict === 'fail' ? 'rejected' : 'pending_review';
    const message = reason || (verdict === 'fail'
      ? 'This update cannot be published as written.'
      : 'This update needs a manual review.');

    await admin.from('moderation_runs').insert({
      tour_id: tourId, creator_id: uid, content_hash: contentHash,
      policy_version: policyVersion, promoted: false, ...logRow,
    });
    await recordDraftVerdict(draftStatus, message, categories);

    // A rejection invalidates every past approval for this tour, so the same
    // content cannot be re-submitted later and wave through on the cache.
    if (verdict === 'fail') {
      await admin.rpc('revoke_tour_approvals', { p_tour_id: tourId });
    }

    await releaseLock();
    return json({
      verdict,
      status: draftStatus,
      is_public: tour.is_public,
      reason: message,
      categories,
    });
  } catch (err) {
    // Fail safe: anything unexpected leaves the live version exactly as it was
    // and queues the draft for a human. An outage must never publish, and must
    // never unpublish either.
    console.error('moderate-tour: falling back to pending_review', err);

    // The model call never produced a billable response, so give the slot back.
    if (quotaTaken && uid) {
      try { await admin.rpc('release_moderation_quota', { p_user: uid }); }
      catch { /* best effort */ }
    }

    if (UUID_RE.test(tourId)) {
      try {
        await admin.from('tours').update({
          draft_review_status: 'pending_review',
          draft_review_reason: 'Automatic review could not be completed. This experience is queued for a manual check.',
          draft_reviewed_at: new Date().toISOString(),
        }).eq('id', tourId);
      } catch { /* best effort */ }
    }
    await releaseLock();

    return json({
      verdict: 'borderline',
      status: 'pending_review',
      reason: 'Automatic review could not be completed. This experience is queued for a manual check.',
    });
  }
});
