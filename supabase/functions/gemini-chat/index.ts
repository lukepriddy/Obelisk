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

    // Players are anonymous, so the budget is per TOUR rather than per person.
    // Set generously: a genuinely popular tour with many simultaneous players
    // shares one bucket, and throttling real players is worse than the abuse
    // this is guarding against.
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
    }

    // ── TEXT GENERATION ──────────────────────────────────────────────────────
    if (type === 'chat') {
      const { history, userMessage, systemInstruction } = body as {
        history: { role: string; text: string }[];
        userMessage: string;
        systemInstruction: string;
      };

      // Input guard — prevent runaway context and oversized messages.
      if (!userMessage || typeof userMessage !== 'string' || userMessage.length > 2000) {
        return new Response(JSON.stringify({ error: 'Invalid or oversized message' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
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
