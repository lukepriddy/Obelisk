/**
 * gemini-chat edge function
 * Proxies both text generation and TTS calls to the Gemini API.
 * The API key is stored as a Supabase secret and never sent to the browser.
 *
 * Anonymous by design — players don't sign in. Abuse controls:
 *   • CORS locked to the app's origins (blocks drive-by browser abuse)
 *   • chat input capped at 2,000 chars, history at 40 turns
 *   • TTS input capped at 4,000 chars (longest possible character reply),
 *     voice name validated — this endpoint runs on the app's own key
 *   • errors returned to clients are generic; details stay in logs
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor } from '../_shared/cors.ts';
import { checkAndRecordUsage, rateLimited } from '../_shared/usage.ts';

const GEMINI_API_KEY   = Deno.env.get('GEMINI_API_KEY') ?? '';
const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const TEXT_MODEL     = 'gemini-2.5-flash';
const TTS_MODEL      = 'gemini-2.5-flash-preview-tts';
const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta/models';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE CHARACTER'S PROMPT IS RESOLVED HERE, NOT SENT BY THE CALLER.
 *
 * It used to arrive in the request body. Combined with keyForTour picking whose
 * key pays from a tourId that is public in every share link, that made this an
 * open LLM proxy: anyone holding a link could run their own prompts on that
 * creator's Gemini account, capped only by the per-tour daily limit. The
 * per-player cap did not help, because the player id also comes from the
 * caller and can simply be rotated.
 *
 * Now the caller may only name a zone. The worst an attacker can do with
 * somebody else's key is talk to that creator's own character, which is low
 * value and unmistakable in the logs.
 *
 * Two sources, matching how the rest of the app already splits preview from
 * play: the OWNER previewing unpublished work reads the live zone, and everyone
 * else reads the approved snapshot. A player can never reach a draft, and an
 * owner is never blocked from testing one.
 */
async function resolveCharacter(
  admin: ReturnType<typeof createClient>,
  tourId: string,
  zoneId: string,
  callerId: string | null,
): Promise<{ prompt: string; unlocks: boolean } | null> {
  const { data: tour } = await admin
    .from('tours')
    .select('owner_id, is_public, published_snapshot')
    .eq('id', tourId)
    .maybeSingle();
  if (!tour) return null;

  if (callerId && callerId === tour.owner_id) {
    const { data: zone } = await admin
      .from('zones')
      .select('character_prompt, avatar_unlock_zone_id, tour_id')
      .eq('id', zoneId)
      .maybeSingle();
    if (!zone || zone.tour_id !== tourId) return null;
    if (!zone.character_prompt?.trim()) return null;
    return { prompt: zone.character_prompt, unlocks: !!zone.avatar_unlock_zone_id };
  }

  // Not the owner: only what has been approved and is actually live.
  if (!tour.is_public || !tour.published_snapshot) return null;
  const zones = (tour.published_snapshot as { zones?: Record<string, unknown>[] })?.zones ?? [];
  const zone = zones.find(z => z.id === zoneId);
  if (!zone) return null;
  const prompt = typeof zone.character_prompt === 'string' ? zone.character_prompt : '';
  if (!prompt.trim()) return null;
  return { prompt, unlocks: !!zone.avatar_unlock_zone_id };
}

/** Appended to every character prompt. Lives here rather than in the browser
 *  so it cannot be edited out by whoever is calling. */
const NO_STAGE_DIRECTIONS =
  '\n\nCRITICAL: Respond with spoken words only. ' +
  'Never include stage directions, action descriptions, or parenthetical ' +
  'notes about physical actions, expressions, or emotions, e.g. never write ' +
  '(smiles), (pauses), (My gaze is steady), or anything in parentheses. ' +
  'Speak only as dialogue, exactly as it would be heard aloud. ' +
  'Keep replies concise and voice-chat natural: usually 1 to 3 short sentences unless the player asks for detail.';

const UNLOCK_TOKEN = '<<UNLOCK>>';

/** Only sent when the zone actually opens a locked zone, which the server now
 *  determines for itself rather than taking the caller's word for it. */
const UNLOCK_INSTRUCTION =
  '\n\nEARNING THE UNLOCK: you are holding something back, as described above. ' +
  'When the player meets the condition, reply to them normally and fully: ' +
  'acknowledge what they just did, in your own voice, and reveal what you were ' +
  `holding back. Then add ${UNLOCK_TOKEN} at the very end of that same message.\n` +
  `The ${UNLOCK_TOKEN} is an addition to your reply, never a replacement for it. ` +
  'A message containing only the marker, or the marker with a bare acknowledgement ' +
  'and no reveal, is wrong: the player would be left in silence at the exact moment ' +
  'they succeeded. Always speak first, mark second.\n' +
  'Use it exactly once, in the message where the reveal happens, never before. ' +
  'A player who has not met the condition does not get it, however they ask. ' +
  'Never mention the marker or explain that it exists.';

/** The signed-in user, when there is one. Anonymous players have none. */
async function callerId(req: Request): Promise<string | null> {
  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    if (!jwt) return null;
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data } = await admin.auth.getUser(jwt);
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * BYOK: character chat is billed to the tour owner's Gemini key.
 * Falls back to the platform key so experiences keep working for
 * creators who haven't added a key yet.
 */
async function keyForTour(tourId: unknown): Promise<string> {
  if (typeof tourId !== 'string' || !UUID_RE.test(tourId)) return GEMINI_API_KEY;
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: tour } = await admin.from('tours').select('owner_id').eq('id', tourId).maybeSingle();
    if (!tour?.owner_id) return GEMINI_API_KEY;
    const { data: keys } = await admin.from('api_keys').select('gemini_key').eq('user_id', tour.owner_id).maybeSingle();
    return keys?.gemini_key || GEMINI_API_KEY;
  } catch {
    return GEMINI_API_KEY;
  }
}

Deno.serve(async (req) => {
  const cors = corsFor(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  try {
    const body = await req.json();
    const { type } = body;

    // Resolve which Gemini key pays for this call (tour owner's, else platform)
    const apiKey = await keyForTour(body.tourId);
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'Service not configured' }), {
        status: 503,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Two budgets, because one was never enough on its own.
    //
    // The TOUR budget is the blast radius: it caps what a single experience can
    // cost in a day, and it is set generously because a popular tour with many
    // simultaneous players shares one bucket and throttling real players is
    // worse than the abuse it guards against.
    //
    // The PLAYER budget is the one that stops a single person spending that
    // whole budget and locking out everyone else playing the same experience.
    // A playthrough is roughly 10 to 30 messages, so this sits far above honest
    // use and far below the tour ceiling.
    //
    // playerId is a uuid the client keeps in localStorage. Clearing storage
    // earns a new one, so this is a speed bump and not a wall. The alternative,
    // keying on IP, groups mobile players behind carrier NAT and would throttle
    // strangers for each other's traffic. See docs/launch-readiness.md.
    if (type === 'chat' || type === 'tts') {
      const actorKey = typeof body.tourId === 'string' && UUID_RE.test(body.tourId)
        ? body.tourId
        : 'unknown-tour';
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

      const usage = await checkAndRecordUsage(
        admin,
        `gemini-chat:${type}`,
        actorKey,
        type === 'chat'
          ? { perMinute: 30, perDay: 500 }
          : { perMinute: 30, perDay: 300 },
        actorKey === 'unknown-tour' ? null : actorKey,
      );
      if (!usage.allowed) return rateLimited(usage, cors);

      // Checked second, so a player who is over their own limit does not also
      // burn a slot from the tour's budget on the way to being refused.
      const playerId = typeof body.playerId === 'string' && UUID_RE.test(body.playerId)
        ? body.playerId
        : null;
      if (playerId) {
        const perPlayer = await checkAndRecordUsage(
          admin,
          `gemini-chat:${type}:player`,
          `${actorKey}:${playerId}`,
          type === 'chat'
            ? { perMinute: 12, perDay: 120 }
            : { perMinute: 12, perDay: 80 },
          actorKey === 'unknown-tour' ? null : actorKey,
        );
        if (!perPlayer.allowed) return rateLimited(perPlayer, cors);
      }
    }

    // ── TEXT GENERATION ──────────────────────────────────────────────────────
    if (type === 'chat') {
      const { history, userMessage, zoneId } = body as {
        history: { role: string; text: string }[];
        userMessage: string;
        zoneId: string;
      };

      // Input guard: prevent runaway context and oversized messages.
      if (!userMessage || typeof userMessage !== 'string' || userMessage.length > 2000) {
        return new Response(JSON.stringify({ error: 'Invalid or oversized message' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      // No zone, no conversation. A systemInstruction in the body is ignored
      // outright rather than merged, because accepting any part of it is what
      // made this an open proxy on other people's keys.
      if (typeof zoneId !== 'string' || !UUID_RE.test(zoneId) ||
          typeof body.tourId !== 'string' || !UUID_RE.test(body.tourId)) {
        return new Response(JSON.stringify({ error: 'Unknown character' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }

      const character = await resolveCharacter(
        createClient(SUPABASE_URL, SERVICE_ROLE_KEY),
        body.tourId, zoneId, await callerId(req),
      );
      if (!character) {
        return new Response(JSON.stringify({ error: 'Unknown character' }), {
          status: 404, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      // The recovery nudge, for when a model answered with the bare marker and
      // stripping it left nothing to show. A flag rather than caller-supplied
      // text, so the browser still composes no part of the instruction.
      const RECOVER_NUDGE =
        '\n\nThe player has just met the condition. Give them your reply now: ' +
        'acknowledge what they did, in character, and reveal what you were holding back. ' +
        'Do not include any token or marker of any kind in this message.';

      const systemInstruction =
        character.prompt
        + NO_STAGE_DIRECTIONS
        + (character.unlocks ? UNLOCK_INSTRUCTION : '')
        + (body.recover === true && character.unlocks ? RECOVER_NUDGE : '');
      const safeHistory = Array.isArray(history) ? history.slice(-40) : [];

      const contents = [
        ...safeHistory.map((h: { role: string; text: string }) => ({ role: h.role, parts: [{ text: h.text }] })),
        { role: 'user', parts: [{ text: userMessage }] },
      ];

      const res = await fetch(
        `${GEMINI_BASE}/${TEXT_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemInstruction }] },
            contents,
            // Disable "thinking" — character banter doesn't need it, and on
            // gemini-2.5-flash thinking adds latency and can eat the output
            // budget, occasionally stalling replies. Off = faster, steadier.
            generationConfig: { maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
          }),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        console.error('Gemini text error:', JSON.stringify(data));
        return new Response(
          JSON.stringify({ error: 'Generation failed' }),
          { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "I didn't catch that.";
      return new Response(JSON.stringify({ text }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ── TTS ───────────────────────────────────────────────────────────────────
    if (type === 'tts') {
      const { textToSpeak, voiceStyle, styleInstruction } = body as {
        textToSpeak: string;
        voiceStyle: string;
        styleInstruction?: string;
      };

      // This endpoint runs on the app's own Gemini key. Character replies are
      // capped at 800 output tokens (≈4,000 chars), so anything longer than
      // that is not legitimate traffic.
      if (!textToSpeak || typeof textToSpeak !== 'string' || textToSpeak.length > 4000) {
        return new Response(JSON.stringify({ error: 'Invalid or oversized text' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      const safeVoice = typeof voiceStyle === 'string' && /^[A-Za-z]{2,24}$/.test(voiceStyle)
        ? voiceStyle
        : 'Kore';

      // Gemini TTS takes a natural-language style directive prefixed to the line
      // ("Say in a warm Southern drawl: <text>"). Prepending the creator's style
      // to EVERY line keeps the accent/delivery consistent across the whole
      // conversation. Capped + sanitized so it can't be abused.
      const rawStyle = typeof styleInstruction === 'string' ? styleInstruction.trim().slice(0, 400) : '';
      const spoken = rawStyle
        ? `${rawStyle.replace(/[:\s]+$/, '')}: ${textToSpeak}`
        : textToSpeak;

      const res = await fetch(
        `${GEMINI_BASE}/${TTS_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: spoken }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              // Low temperature keeps the delivery (accent, pace, tone) steady
              // from one line to the next instead of drifting between messages.
              temperature: 0.35,
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: safeVoice },
                },
              },
            },
          }),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        console.error('Gemini TTS error:', JSON.stringify(data));
        return new Response(
          JSON.stringify({ error: 'TTS failed' }),
          { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      }

      const audioData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ?? '';
      return new Response(JSON.stringify({ audioData }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Invalid type' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Edge function error:', err);
    return new Response(JSON.stringify({ error: 'Request failed' }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
