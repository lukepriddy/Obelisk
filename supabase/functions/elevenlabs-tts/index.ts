/**
 * elevenlabs-tts edge function
 *
 * BYOK: each creator stores their own ElevenLabs key in the api_keys table
 * (Dashboard → Settings). This function reads it server-side — the key never
 * reaches the browser.
 *
 * Actions:
 *   type: 'voices'   — list the creator's ElevenLabs voices
 *   type: 'generate' — TTS the text, upload MP3 to the public "audio" bucket,
 *                      return the permanent URL. Generated once, saved forever —
 *                      playback never calls ElevenLabs again.
 *
 * Deployed with verify_jwt so only signed-in creators can call it.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ELEVEN_BASE      = 'https://api.elevenlabs.io/v1';

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

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Identify the caller from their JWT
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace('Bearer ', '');
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) {
      return json({ error: 'Not authenticated' }, 401);
    }
    const userId = userData.user.id;

    // Fetch the creator's ElevenLabs key
    const { data: keyRow } = await admin
      .from('api_keys')
      .select('elevenlabs_key')
      .eq('user_id', userId)
      .maybeSingle();

    const elevenKey = keyRow?.elevenlabs_key;
    if (!elevenKey) {
      return json({ error: 'no_key', message: 'No ElevenLabs API key configured. Add one in Settings.' }, 400);
    }

    const body = await req.json();
    const { type } = body;

    // ── VOICES ──────────────────────────────────────────────────────────────
    if (type === 'voices') {
      const res = await fetch(`${ELEVEN_BASE}/voices`, {
        headers: { 'xi-api-key': elevenKey },
      });
      if (!res.ok) {
        const detail = await res.text();
        console.error('ElevenLabs voices error:', res.status, detail.slice(0, 300));
        return json({
          error: 'voices_failed',
          message: res.status === 401
            ? 'ElevenLabs rejected the API key — make sure it has the "Text to Speech" and "Voices: Read" permissions, or use a key with full access. Update it in Dashboard → Settings.'
            : 'Could not load voices.',
        }, 502);
      }
      const data = await res.json();
      const voices = (data.voices ?? []).map((v: any) => ({
        voice_id: v.voice_id,
        name: v.name,
        category: v.category ?? '',
        preview_url: v.preview_url ?? null,
      }));
      return json({ voices });
    }

    // ── GENERATE ────────────────────────────────────────────────────────────
    if (type === 'generate') {
      const { text, voiceId, tourId } = body as { text: string; voiceId: string; tourId: string };

      if (!text?.trim() || !voiceId || !tourId) {
        return json({ error: 'text, voiceId, and tourId are required' }, 400);
      }
      // Generous cap — this runs on the creator's own ElevenLabs key, so cost
      // is theirs by design. 10,000 chars matches ElevenLabs' per-request max;
      // their plan limits are enforced by ElevenLabs itself.
      if (text.length > 10000) {
        return json({ error: 'Text too long — keep it under 10,000 characters.' }, 400);
      }

      const res = await fetch(
        `${ELEVEN_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
        {
          method: 'POST',
          headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text.trim(),
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        }
      );

      if (!res.ok) {
        const detail = await res.text();
        console.error('ElevenLabs TTS error:', res.status, detail.slice(0, 300));
        const message =
          res.status === 401 ? 'ElevenLabs rejected the API key — make sure it has the "Text to Speech" permission, or use a key with full access. Update it in Dashboard → Settings.' :
          res.status === 429 ? 'ElevenLabs rate limit or quota reached. Check your ElevenLabs account.' :
          'Voice generation failed.';
        return json({ error: 'tts_failed', message }, 502);
      }

      const audioBytes = new Uint8Array(await res.arrayBuffer());

      // Save to the public audio bucket — playback never hits ElevenLabs again
      const path = `${tourId}/tts-${Date.now()}.mp3`;
      const { error: uploadError } = await admin.storage
        .from('audio')
        .upload(path, audioBytes, { contentType: 'audio/mpeg', upsert: false });

      if (uploadError) {
        console.error('Storage upload error:', uploadError.message);
        return json({ error: 'upload_failed', message: 'Audio generated but saving failed. Try again.' }, 500);
      }

      const { data: urlData } = admin.storage.from('audio').getPublicUrl(path);
      return json({ url: urlData.publicUrl });
    }

    return json({ error: 'Invalid type' }, 400);

  } catch (err) {
    console.error('elevenlabs-tts error:', err);
    return json({ error: 'Request failed' }, 500);
  }
});
