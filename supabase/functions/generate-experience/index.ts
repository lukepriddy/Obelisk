/**
 * generate-experience edge function
 *
 * Two request types:
 *   type: 'generate' — query Overpass for real-world POIs, then call Gemini to
 *                      produce a structured experience draft JSON.
 *   type: 'refine'   — apply creator feedback to an existing draft.
 *
 * PDF material (optional): accepted as base64 inline_data and passed directly
 * to Gemini — no server-side parsing library needed.
 *
 * Deployed with verify_jwt — creator-only feature, billed to the creator's
 * own Gemini key (platform key as fallback).
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

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

// ── Overpass helper ──────────────────────────────────────────────────────────

async function queryOverpass(
  startLat: number, startLng: number,
  endLat?: number,  endLng?: number,
  radiusMeters = 500,
): Promise<{ name: string; lat: number; lng: number; tags: string }[]> {

  const r = Math.max(100, Math.min(radiusMeters, 2000));

  // Build node + way filters around one or two anchor points
  const pointFilters: [number, number][] = [[startLat, startLng]];
  if (endLat != null && endLng != null) pointFilters.push([endLat, endLng]);

  const lines: string[] = [];
  for (const [la, lo] of pointFilters) {
    const a = `around:${r},${la},${lo}`;
    lines.push(
      `node["name"]["tourism"](${a});`,
      `node["name"]["historic"](${a});`,
      `node["name"]["amenity"~"^(bar|cafe|library|place_of_worship|theatre|cinema|arts_centre|community_centre|museum)$"](${a});`,
      `node["name"]["leisure"~"^(park|garden|nature_reserve|bandstand)$"](${a});`,
      `way["name"]["historic"](${a});`,
      `way["name"]["tourism"](${a});`,
      `way["name"]["leisure"~"^(park|garden|nature_reserve)$"](${a});`,
      `way["name"]["amenity"~"^(place_of_worship|theatre|museum|library)$"](${a});`,
    );
  }

  // 8-second Overpass timeout — fail fast so Gemini always gets plenty of budget
  const query = `[out:json][timeout:8];\n(\n${lines.join('\n')}\n);\nout center 50;`;

  try {
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 9000); // JS-level hard cap
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });
    clearTimeout(abort);
    if (!res.ok) return [];

    const data = await res.json();
    const results: { name: string; lat: number; lng: number; tags: string }[] = [];
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
        .filter(([k]: [string, unknown]) => ['tourism', 'historic', 'amenity', 'leisure', 'building'].includes(k))
        .map(([k, v]: [string, unknown]) => `${k}=${v}`)
        .join(', ');

      results.push({ name, lat: elLat, lng: elLng, tags: relevantTags });
    }

    return results.slice(0, 40);
  } catch {
    return [];
  }
}

// ── Gemini system instruction ─────────────────────────────────────────────────

const VOICE_OPTIONS =
  'Kore (firm/clear/F), Aoede (smooth/breezy/F), Leda (warm/friendly/F), ' +
  'Zephyr (bright/upbeat/F), Callirrhoe (soft/measured/F), Despina (gentle/thoughtful/F), ' +
  'Fenrir (intense/excitable/M), Puck (playful/youthful/M), Charon (deep/authoritative/M), ' +
  'Orus (confident/steady/M), Enceladus (smooth/professional/M), Gacrux (relaxed/conversational/M)';

const SYSTEM_INSTRUCTION = `You are an expert designer of immersive location-based narrative walking experiences.
Given real GPS coordinates of real-world places and a creator's brief, you craft compelling story experiences.

STRICT RULES:
1. ONLY use lat/lng coordinates from the AVAILABLE LOCATIONS list. Never invent coordinates.
   If no locations are listed, place all zones at or very near the START coordinate.
2. If the creator provided a document or notes, their material takes absolute priority over your own ideas.
   Extract characters, themes, and story beats from their material wherever possible.
3. Design 5–8 zones. Mix types: audio zones and character zones. Use locked (passphrase) zones sparingly.
4. Sequence zones so the experience flows naturally from START toward END.
5. Each zone must have a clear narrative purpose — set-up, rising tension, encounter, revelation, resolution.
6. Character prompts: 2–3 sentences in second-person ("You are…"), covering personality, knowledge, and speech style.
7. Radius: 15–40 m for most zones. Locked zones can be up to 60 m.
8. Audio zones are placeholders — write a vivid description of what audio the creator should add there
   (e.g. "Ambient 1890s piano music fading in as the player approaches the old saloon").
9. Voice styles — pick to match character personality: ${VOICE_OPTIONS}
10. Return ONLY valid JSON. No markdown code fences, no explanations, no text before or after the JSON object.

JSON SCHEMA (return exactly this shape — all fields required, use null where not applicable):
{
  "title": "string",
  "subtitle": "string",
  "description": "string (2–3 sentences, player-facing)",
  "summary": "string (1–2 sentences for the creator: what you built and why)",
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
      "lock_hint": "string | null",
      "lock_passphrase": "string | null"
    }
  ]
}`;

// ── Shared draft parser ───────────────────────────────────────────────────────

function parseDraft(raw: string): unknown {
  // Strip accidental markdown fences
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

      // 1. Query Overpass for real POIs
      const locations = await queryOverpass(startLat, startLng, endLat, endLng, radiusMeters ?? 500);

      const locationList = locations.length > 0
        ? locations.map((l, i) =>
            `${i + 1}. "${l.name}" — lat: ${l.lat.toFixed(6)}, lng: ${l.lng.toFixed(6)}${l.tags ? ` (${l.tags})` : ''}`
          ).join('\n')
        : `No named POIs found. Place all zones near START: ${startLat.toFixed(6)}, ${startLng.toFixed(6)}`;

      // 2. Build user prompt
      const userPrompt = [
        brief?.trim() ? `CREATOR'S BRIEF:\n${brief.trim()}` : 'No brief provided — create an original experience for this location.',
        '',
        `START LOCATION: ${startLat.toFixed(6)}, ${startLng.toFixed(6)}`,
        endLat != null && endLng != null
          ? `END LOCATION: ${endLat.toFixed(6)}, ${endLng.toFixed(6)}`
          : 'No end location specified — end the experience near the richest cluster of zones.',
        '',
        'AVAILABLE LOCATIONS (use these exact coordinates only):',
        locationList,
        '',
        'Design an immersive experience using the above. Return the JSON now.',
      ].join('\n');

      // 3. Build Gemini content parts (PDF first if provided, then text)
      const parts: unknown[] = [];
      if (pdfBase64 && pdfMimeType) {
        parts.push({ inline_data: { mime_type: pdfMimeType, data: pdfBase64 } });
      }
      parts.push({ text: userPrompt });

      // 4. Call Gemini
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
