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
import { corsFor } from '../_shared/cors.ts';
import { checkAndRecordUsage } from '../_shared/usage.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ELEVEN_BASE      = 'https://api.elevenlabs.io/v1';

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

    // The audio itself is billed to the creator's own ElevenLabs account, but
    // each call still costs a function invocation and a storage write.
    // `voices` is a cheap passthrough listing and is left unlimited.
    if (type === 'generate') {
      const usage = await checkAndRecordUsage(
        admin, 'elevenlabs-tts:generate', userId, { perMinute: 20, perDay: 200 },
      );
      if (!usage.allowed) {
        return json({ error: usage.message ?? 'Rate limit reached.' }, 429);
      }
    }

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

      // Record it in the same ledger client uploads write to.
      //
      // This was missed when TTS was built, and the gap was not theoretical:
      // the ledger held 106 rows against 133 objects in storage, and all 27
      // missing files were generated here. `uploads` is what getStorageQuota()
      // sums, so generated audio was costing storage while counting as free —
      // and it is the easiest kind of file to produce a lot of.
      //
      // Best effort, like recordUpload() in storageService.ts: a bookkeeping
      // failure must not lose a creator the audio they just paid to generate.
      const { error: ledgerError } = await admin.from('uploads').insert({
        user_id: userId,
        tour_id: tourId,
        bucket: 'audio',
        path,
        size_bytes: audioBytes.byteLength,
        mime_type: 'audio/mpeg',
      });
      if (ledgerError) console.error('uploads ledger:', ledgerError.message);

      const { data: urlData } = admin.storage.from('audio').getPublicUrl(path);
      return json({ url: urlData.publicUrl });
    }

    return json({ error: 'Invalid type' }, 400);

  } catch (err) {
    console.error('elevenlabs-tts error:', err);
    return json({ error: 'Request failed' }, 500);
  }
});
