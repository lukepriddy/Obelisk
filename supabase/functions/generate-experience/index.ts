/**
 * generate-experience edge function
 *
 * Two-stage pipeline:
 *   Stage 1 — RESEARCH: Gemini with Google Search grounding builds a factual
 *             dossier about the area (real history, people, lore). Plain text;
 *             non-fatal if it fails.
 *   Stage 2 — DESIGN: Gemini in strict-JSON mode crafts the experience from
 *             the dossier + distance-annotated POIs + the creator's material.
 *
 * Request types:
 *   type: 'generate' — Overpass POIs → research → design draft
 *   type: 'refine'   — apply creator feedback to an existing draft
 *
 * PDF material (optional): passed as inline_data to the design stage.
 *
 * Deployed with verify_jwt — creator-only feature, billed to the creator's
 * own Gemini key (platform key as fallback).
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor } from '../_shared/cors.ts';
import { checkAndRecordUsage, rateLimited } from '../_shared/usage.ts';
import { importDocument } from './import.ts';

const GEMINI_API_KEY   = Deno.env.get('GEMINI_API_KEY') ?? '';
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TEXT_MODEL     = 'gemini-2.5-flash';
const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta/models';
const OVERPASS_URL   = 'https://overpass-api.de/api/interpreter';

/**
 * BYOK: generation is billed to the signed-in creator's Gemini key.
 * Falls back to the platform key for creators who haven't added one.
 */
async function keyForCaller(req: Request): Promise<string> {
  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: u } = await admin.auth.getUser(jwt);
    if (!u?.user) return GEMINI_API_KEY;
    const { data: keys } = await admin.from('api_keys').select('gemini_key').eq('user_id', u.user.id).maybeSingle();
    return keys?.gemini_key || GEMINI_API_KEY;
  } catch {
    return GEMINI_API_KEY;
  }
}

/** The signed-in creator's id, used to scope rate limits. */
async function callerId(req: Request): Promise<string | null> {
  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: u } = await admin.auth.getUser(jwt);
    return u?.user?.id ?? null;
  } catch {
    return null;
  }
}

// ── Geo helpers ───────────────────────────────────────────────────────────────

function distMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLng = (bLng - aLng) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

function compass(aLat: number, aLng: number, bLat: number, bLng: number): string {
  const dLng = (bLng - aLng) * Math.PI / 180;
  const y = Math.sin(dLng) * Math.cos(bLat * Math.PI / 180);
  const x = Math.cos(aLat * Math.PI / 180) * Math.sin(bLat * Math.PI / 180) -
    Math.sin(aLat * Math.PI / 180) * Math.cos(bLat * Math.PI / 180) * Math.cos(dLng);
  const deg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
}

// ── Overpass: wide-net POI harvest with distance annotations ─────────────────

interface Poi { name: string; lat: number; lng: number; tags: string; dist: number; dir: string }

async function queryOverpass(
  startLat: number, startLng: number,
  endLat?: number,  endLng?: number,
  radiusMeters = 500,
): Promise<Poi[]> {

  const r = Math.max(100, Math.min(radiusMeters, 2000));

  const pointFilters: [number, number][] = [[startLat, startLng]];
  if (endLat != null && endLng != null) pointFilters.push([endLat, endLng]);

  const lines: string[] = [];
  for (const [la, lo] of pointFilters) {
    const a = `around:${r},${la},${lo}`;
    for (const el of ['node', 'way']) {
      lines.push(
        `${el}["name"]["tourism"](${a});`,
        `${el}["name"]["historic"](${a});`,
        `${el}["name"]["amenity"~"^(bar|cafe|pub|restaurant|library|place_of_worship|theatre|cinema|arts_centre|community_centre|museum|fountain|marketplace|townhall|clock)$"](${a});`,
        `${el}["name"]["leisure"~"^(park|garden|nature_reserve|bandstand|marina|playground)$"](${a});`,
        `${el}["name"]["man_made"~"^(lighthouse|windmill|water_tower|pier|tower|obelisk)$"](${a});`,
        `${el}["name"]["natural"~"^(spring|peak|beach|cliff|tree)$"](${a});`,
        `${el}["name"]["place"~"^(square)$"](${a});`,
      );
    }
  }

  // 8-second Overpass timeout — fail fast so Gemini keeps most of the budget
  const query = `[out:json][timeout:8];\n(\n${lines.join('\n')}\n);\nout center 60;`;

  try {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 9000);
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    clearTimeout(abort);
    if (!res.ok) return [];

    const data = await res.json();
    const results: Poi[] = [];
    const seen = new Set<string>();

    for (const el of (data.elements ?? [])) {
      const name = el.tags?.name as string | undefined;
      if (!name || seen.has(name)) continue;
      seen.add(name);

      let elLat: number, elLng: number;
      if (el.type === 'node' && el.lat != null && el.lon != null) {
        elLat = el.lat; elLng = el.lon;
      } else if (el.center?.lat != null) {
        elLat = el.center.lat; elLng = el.center.lon;
      } else continue;

      const relevantTags = Object.entries(el.tags ?? {})
        .filter(([k]: [string, unknown]) =>
          ['tourism', 'historic', 'amenity', 'leisure', 'man_made', 'natural', 'place', 'building'].includes(k))
        .map(([k, v]: [string, unknown]) => `${k}=${v}`)
        .join(', ');

      results.push({
        name, lat: elLat, lng: elLng, tags: relevantTags,
        dist: distMeters(startLat, startLng, elLat, elLng),
        dir: compass(startLat, startLng, elLat, elLng),
      });
    }

    // Nearest first — gives the model a natural route-building order
    results.sort((a, b) => a.dist - b.dist);
    return results.slice(0, 40);
  } catch {
    return [];
  }
}

// ── Stage 1: grounded research ────────────────────────────────────────────────

async function researchArea(
  apiKey: string,
  lat: number, lng: number,
  poiNames: string[],
  brief: string,
): Promise<string> {
  const prompt = [
    'You are a meticulous local-history researcher for a location-based storytelling app.',
    '',
    `AREA CENTER: ${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    poiNames.length > 0 ? `NEARBY NAMED PLACES: ${poiNames.slice(0, 15).join('; ')}` : 'NEARBY NAMED PLACES: (none found on the map)',
    brief ? `CREATOR'S THEME: ${brief.slice(0, 500)}` : '',
    '',
    'Search the web and produce a compact factual dossier (max 450 words) covering:',
    '• What this area is — town/neighborhood character, era, atmosphere',
    '• Real history of the named places: dates, events, people, original uses',
    '• Notable people connected to this area, one line each on why they matter',
    '• Local legends, folklore, odd facts, and vivid sensory details',
    '• Anything directly relevant to the creator\'s theme',
    '',
    'Only include facts you found or know with high confidence; mark anything uncertain "(unverified)".',
    'Plain text bullets. No preamble.',
  ].filter(Boolean).join('\n');

  try {
    const res = await fetch(
      `${GEMINI_BASE}/${TEXT_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig: { maxOutputTokens: 4096, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    if (!res.ok) {
      console.error('Research stage failed:', res.status, (await res.text()).slice(0, 300));
      return '';
    }
    const data = await res.json();
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p: { text?: string }) => p.text ?? '')
      .join(' ')
      .trim();
    return text.slice(0, 6000);
  } catch (e) {
    console.error('Research stage error:', e);
    return '';
  }
}

// ── Stage 2: design system instruction ───────────────────────────────────────

const VOICE_OPTIONS =
  'Kore (firm/clear/F), Aoede (smooth/breezy/F), Leda (warm/friendly/F), ' +
  'Zephyr (bright/upbeat/F), Callirrhoe (soft/measured/F), Despina (gentle/thoughtful/F), ' +
  'Fenrir (intense/excitable/M), Puck (playful/youthful/M), Charon (deep/authoritative/M), ' +
  'Orus (confident/steady/M), Enceladus (smooth/professional/M), Gacrux (relaxed/conversational/M)';

const SYSTEM_INSTRUCTION = `You are a world-class designer of location-based immersive narrative walking experiences — equal parts game designer, immersive-theater director, and master tour guide. Players walk a real place with headphones on; zones trigger by GPS.

INPUTS YOU RECEIVE
- The creator's brief and possibly a reference document — their material takes ABSOLUTE priority over your own ideas. The brief dictates genre, tone, and content; everything else is raw material in its service.
- A RESEARCH DOSSIER of real facts about the area (from live web search; may be empty). It is OPTIONAL seasoning, not a requirement — see rule 7.
- AVAILABLE LOCATIONS: real places with exact coordinates, each annotated with distance and direction from START

LOCATION SELECTION
1. ONLY use lat/lng values from AVAILABLE LOCATIONS. Never invent coordinates — except under FALLBACK below.
2. Build a walkable route: open near START and finish near END (if given). Prefer hops of 80–400 m between consecutive zones; avoid backtracking. Use the distance/direction annotations to sequence sensibly.
3. Pick places with narrative affordance — let a location's real character (its tags and dossier history) amplify the story beat you place there. Favor variety over clustering.
4. Keep zones at least 50 m apart unless a deliberate nested reveal requires overlap.

FALLBACK — when AVAILABLE LOCATIONS is empty
Design a walking loop anyway: offset zones 0.0008–0.0020 degrees from START in varied directions so consecutive zones sit 80–200 m apart and the route curls back toward START. NEVER stack multiple zones on one coordinate.

STORY CRAFT
5. Three-act arc across the zones: hook & promise → rising discoveries and complications → climax & resolution. Each zone is ONE beat with a clear job.
6. entry_message is a hook, not a summary: 1–2 sentences of intrigue that make the player want to engage right now.
7. The dossier serves the creator's vision — never the other way around. If the brief calls for real history, mine the dossier hard: weave real names, dates, and events in so the place itself seems to speak. But if the brief points elsewhere (fantasy, sci-fi, romance, comedy, a kids' adventure, a scavenger hunt…), honor that fully — use the dossier only as light physical texture (geography, building shapes, atmosphere) or not at all, and do NOT shoehorn in historical factoids. No brief at all? Then default to blending real local texture with invented drama.
8. Plant and pay off: an early zone plants a detail (a name, object, phrase); a later zone pays it off.

CHARACTERS (type "character")
9. Every character gets a distinct VOICE (diction, rhythm, attitude), a WANT (what they're after from the player), and a SECRET (revealed only if the player probes the right way). Encode all three in character_prompt: second person ("You are…"), 3–5 sentences, plus 2–3 grounding details the character can reference — real local details when the story is fact-based, world-consistent details when it's fiction.
10. greeting_message: their actual opening line, fully in voice, at most 2 sentences. character_bio: an evocative player-facing teaser with no spoilers.
11. voice_style — pick the prebuilt voice that best matches the personality: ${VOICE_OPTIONS}
12. voice_instructions — a short delivery directive (accent, pace, mood) prepended to every spoken line to keep the voice consistent. One concise phrase, e.g. "Gravelly old fisherman, unhurried, faint Irish lilt" or "Crisp, clipped, impatient aristocrat." Keep it under ~15 words.

LOCKED ZONES (locked: true)
13. Use 0–2. The passphrase MUST be discoverable inside the experience: write it into an earlier character's SECRET or an earlier audio zone's content, and make that earlier zone's text actually contain it. lock_hint points to the right earlier zone without revealing the answer. Passphrases are single memorable words or short phrases a player can type.

AUDIO ZONES (type "audio")
14. description doubles as a production note: specify mood, era, instrumentation, ambience, or a voiceover script direction vividly enough that the creator can produce or AI-generate it immediately.

OUTPUT
15. 5–8 zones, unless the creator's material clearly calls for a different count.
16. radius is in meters: 15–40 for most zones, up to 60 for locked zones.
17. Return ONLY valid JSON matching the schema below. No markdown fences, no commentary.

JSON SCHEMA (exact shape — all fields present, null where not applicable):
{
  "title": "string",
  "subtitle": "string",
  "description": "string (2–3 sentences, player-facing)",
  "summary": "string (2–3 sentences for the creator: what you built and why; mention any real facts used)",
  "zones": [
    {
      "order": number,
      "title": "string",
      "type": "audio" | "character",
      "locked": boolean,
      "lat": number,
      "lng": number,
      "radius": number,
      "location_name": "string",
      "description": "string",
      "entry_message": "string | null",
      "character_prompt": "string | null",
      "character_bio": "string | null",
      "greeting_message": "string | null",
      "voice_style": "string | null",
      "voice_instructions": "string | null",
      "lock_hint": "string | null",
      "lock_passphrase": "string | null"
    }
  ]
}`;

// ── Shared draft parser ───────────────────────────────────────────────────────

function parseDraft(raw: string): unknown {
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = corsFor(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const apiKey = await keyForCaller(req);
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Service not configured' }), {
      status: 503, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const { type } = body;

    // Generation is the most expensive path in the product (Overpass lookup
    // plus multiple Gemini calls), so it gets the tightest ceiling.
    if (type === 'generate' || type === 'refine' || type === 'import') {
      const uid = await callerId(req);
      if (!uid) {
        return new Response(JSON.stringify({ error: 'Not signed in.' }), {
          status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
      const limits = type === 'refine' ? { perHour: 15 } : { perHour: 5, perDay: 20 };
      const usage = await checkAndRecordUsage(admin, `generate-experience:${type}`, uid, limits);
      if (!usage.allowed) return rateLimited(usage, cors);
    }

    // ── IMPORT ──────────────────────────────────────────────────────────────
    // A finished script becomes zones. The creator's words are sliced by line
    // on the server and never pass through the model — see import.ts.
    if (type === 'import') {
      const { document, startLat, startLng, endLat, endLng, defaultRadius } = body as {
        document?: string;
        startLat?: number; startLng?: number;
        endLat?: number; endLng?: number;
        defaultRadius?: number;
      };

      if (typeof document !== 'string' || document.trim().length < 40) {
        return new Response(JSON.stringify({ error: 'Paste your script to import it.' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      try {
        const result = await importDocument(
          apiKey, document, startLat, startLng, endLat, endLng, defaultRadius);
        return new Response(JSON.stringify({ draft: result }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        const code = e instanceof Error ? e.message : 'import_failed';
        const message =
          code === 'import_needs_start_point'
            ? 'Your script has no coordinates in it, so pick a starting point on the map and the zones will be laid out from there.'
          : code === 'import_no_zones_found'
            ? 'Nothing in this document reads as zone content. Check that you pasted the script itself.'
          : code === 'import_document_too_short'
            ? 'That looks too short to split into zones.'
          : code.endsWith('_truncated')
            ? 'The script was too long to process in one pass. Try importing it in two halves.'
            : 'Import failed.';
        console.error('Import error:', code);
        return new Response(JSON.stringify({ error: message, code }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── GENERATE ────────────────────────────────────────────────────────────
    if (type === 'generate') {
      const { startLat, startLng, endLat, endLng, radiusMeters, brief, pdfBase64, pdfMimeType } = body as {
        startLat: number; startLng: number;
        endLat?: number; endLng?: number;
        radiusMeters?: number;
        brief?: string;
        pdfBase64?: string;
        pdfMimeType?: string;
      };

      if (typeof startLat !== 'number' || typeof startLng !== 'number') {
        return new Response(JSON.stringify({ error: 'startLat and startLng are required' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // 1. Real POIs with distance annotations
      const locations = await queryOverpass(startLat, startLng, endLat, endLng, radiusMeters ?? 500);

      // 2. Grounded research dossier (non-fatal if it fails)
      const dossier = await researchArea(
        apiKey, startLat, startLng,
        locations.map(l => l.name),
        brief?.trim() ?? '',
      );

      const locationList = locations.length > 0
        ? locations.map((l, i) =>
            `${i + 1}. "${l.name}" — lat: ${l.lat.toFixed(6)}, lng: ${l.lng.toFixed(6)} — ${l.dist} m ${l.dir} of START${l.tags ? ` (${l.tags})` : ''}`
          ).join('\n')
        : '(none found — use the FALLBACK layout rules)';

      const endNote = endLat != null && endLng != null
        ? `END LOCATION: ${endLat.toFixed(6)}, ${endLng.toFixed(6)} — ${distMeters(startLat, startLng, endLat, endLng)} m ${compass(startLat, startLng, endLat, endLng)} of START`
        : 'No end location specified — curl the route back toward START or end at the most striking location.';

      // 3. Design prompt
      const userPrompt = [
        brief?.trim() ? `CREATOR'S BRIEF:\n${brief.trim()}` : 'No brief provided — invent an original experience that fits this specific place.',
        '',
        `START LOCATION: ${startLat.toFixed(6)}, ${startLng.toFixed(6)}`,
        endNote,
        '',
        'RESEARCH DOSSIER (real facts from live web search; optional material — the brief rules):',
        dossier || '(research unavailable — rely on the creator\'s material and plausible, clearly fictional invention)',
        '',
        'AVAILABLE LOCATIONS (use these exact coordinates only):',
        locationList,
        '',
        'Design the experience now. Return ONLY the JSON.',
      ].join('\n');

      const parts: unknown[] = [];
      if (pdfBase64 && pdfMimeType) {
        parts.push({ inline_data: { mime_type: pdfMimeType, data: pdfBase64 } });
      }
      parts.push({ text: userPrompt });

      // 4. Design call (strict JSON)
      const res = await fetch(
        `${GEMINI_BASE}/${TEXT_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
            contents: [{ role: 'user', parts }],
            generationConfig: {
              maxOutputTokens: 16384,
              temperature: 0.85,
              responseMimeType: 'application/json',
              // Thinking tokens count against maxOutputTokens on 2.5 models —
              // without this the JSON gets truncated and fails to parse
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        }
      );

      const data = await res.json();
      if (!res.ok) {
        console.error('Gemini generate error:', JSON.stringify(data));
        return new Response(JSON.stringify({ error: 'Generation failed' }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      try {
        const draft = parseDraft(raw);
        return new Response(JSON.stringify({ draft }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        console.error('Draft parse error:', e, raw.slice(0, 500));
        return new Response(JSON.stringify({ error: 'Failed to parse AI response' }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    // ── REFINE ───────────────────────────────────────────────────────────────
    if (type === 'refine') {
      const { draft: currentDraft, feedback } = body as { draft: unknown; feedback: string };

      if (!currentDraft || !feedback?.trim()) {
        return new Response(JSON.stringify({ error: 'draft and feedback are required' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const userPrompt = [
        'CURRENT DRAFT:',
        JSON.stringify(currentDraft, null, 2),
        '',
        'CREATOR FEEDBACK:',
        feedback.trim(),
        '',
        'Apply the requested changes. Return the complete revised JSON draft.',
        'Keep everything unchanged unless the feedback specifically requests a modification.',
      ].join('\n');

      const res = await fetch(
        `${GEMINI_BASE}/${TEXT_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: {
              maxOutputTokens: 16384,
              temperature: 0.7,
              responseMimeType: 'application/json',
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        }
      );

      const data = await res.json();
      if (!res.ok) {
        console.error('Gemini refine error:', JSON.stringify(data));
        return new Response(JSON.stringify({ error: 'Refinement failed' }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      try {
        const draft = parseDraft(raw);
        return new Response(JSON.stringify({ draft }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      } catch {
        return new Response(JSON.stringify({ error: 'Failed to parse refined response' }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Invalid type' }), {
      status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Edge function error:', err);
    return new Response(JSON.stringify({ error: 'Request failed' }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
