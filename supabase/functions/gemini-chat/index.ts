/**
 * gemini-chat edge function
 * Proxies both text generation and TTS calls to the Gemini API.
 * The API key is stored as a Supabase secret and never sent to the browser.
 *
 * Deploy:
 *   supabase functions deploy gemini-chat --no-verify-jwt
 *
 * Set secret:
 *   supabase secrets set GEMINI_API_KEY=<your-key>
 */

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? '';
const TEXT_MODEL     = 'gemini-2.5-flash-preview-05-20';
const TTS_MODEL      = 'gemini-2.5-flash-preview-tts';
const GEMINI_BASE    = 'https://generativelanguage.googleapis.com/v1beta/models';

const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  // Preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }

  try {
    const body = await req.json();
    const { type } = body;

    // ── TEXT GENERATION ──────────────────────────────────────────────────────
    if (type === 'chat') {
      const { history, userMessage, systemInstruction } = body as {
        history: { role: string; text: string }[];
        userMessage: string;
        systemInstruction: string;
      };

      const contents = [
        ...history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
        { role: 'user', parts: [{ text: userMessage }] },
      ];

      const res = await fetch(
        `${GEMINI_BASE}/${TEXT_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemInstruction }] },
            contents,
            generationConfig: { maxOutputTokens: 300 },
          }),
        }
      );

      const data = await res.json();

      if (!res.ok) {
        console.error('Gemini text error:', JSON.stringify(data));
        return new Response(
          JSON.stringify({ error: data.error?.message ?? 'Gemini text error' }),
          { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "I didn't catch that.";
      return new Response(JSON.stringify({ text }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ── TTS ───────────────────────────────────────────────────────────────────
    if (type === 'tts') {
      const { textToSpeak, voiceStyle } = body as {
        textToSpeak: string;
        voiceStyle: string;
      };

      const res = await fetch(
        `${GEMINI_BASE}/${TTS_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: textToSpeak }] }],
            generationConfig: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: voiceStyle || 'Kore' },
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
          JSON.stringify({ error: data.error?.message ?? 'Gemini TTS error' }),
          { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } }
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
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
