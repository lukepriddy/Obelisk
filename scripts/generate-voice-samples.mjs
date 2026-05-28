/**
 * generate-voice-samples.mjs
 * Run ONCE to generate WAV samples for every Gemini voice and upload them
 * to Supabase storage. After running, copy the printed URLs into VOICES in
 * constants.ts as a `sampleUrl` field.
 *
 * Usage:
 *   GEMINI_API_KEY=<key> SUPABASE_SERVICE_KEY=<service-role-key> node scripts/generate-voice-samples.mjs
 *
 * Requirements: Node 18+ (uses built-in fetch)
 */

const GEMINI_KEY      = process.env.GEMINI_API_KEY;
const SUPABASE_URL    = 'https://pzlgiurtjrmkpbjlaabz.supabase.co';
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY; // service role key (NOT anon key)
const BUCKET          = 'audio';
const PREFIX          = 'voice-samples';
const TTS_MODEL       = 'gemini-2.5-flash-preview-tts';
const GEMINI_BASE     = 'https://generativelanguage.googleapis.com/v1beta/models';

// Short phrase that showcases tone without being too long (keeps costs minimal)
const SAMPLE_TEXT = "Welcome. I'm glad you found me here. There's much to discover on this journey.";

// Only voices confirmed valid by the Gemini TTS API.
// Iocaste, Isonoe, Altair, Hydrus were rejected as unsupported.
const VOICES = [
  'Kore', 'Aoede', 'Leda', 'Zephyr', 'Callirrhoe', 'Autonoe', 'Despina',
  'Erinome', 'Laomedeia', 'Pulcherrima', 'Vindemiatrix',
  'Fenrir', 'Puck', 'Charon', 'Orus', 'Enceladus', 'Gacrux',
  'Rasalgethi', 'Sadachbia', 'Sadaltager', 'Schedar', 'Umbriel',
];

// ── WAV header builder ────────────────────────────────────────────────────────
// Gemini TTS returns raw 16-bit signed PCM at 24 kHz, mono.
function pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const dataLen  = pcmBuffer.length;
  const wav      = Buffer.alloc(44 + dataLen);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataLen, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);           // PCM chunk size
  wav.writeUInt16LE(1, 20);            // AudioFormat = PCM
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataLen, 40);
  pcmBuffer.copy(wav, 44);
  return wav;
}

// ── Generate one voice sample via Gemini TTS ──────────────────────────────────
async function generatePcm(voiceName) {
  const url = `${GEMINI_BASE}/${TTS_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const body = {
    contents: [{ parts: [{ text: SAMPLE_TEXT }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Gemini ${res.status}: ${JSON.stringify(data.error ?? data)}`);
  }

  const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!b64) {
    throw new Error(`No audio in response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return Buffer.from(b64, 'base64');
}

// ── Upload WAV to Supabase Storage ────────────────────────────────────────────
async function uploadWav(voiceName, wavBuffer) {
  const path = `${PREFIX}/${voiceName.toLowerCase()}.wav`;

  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'audio/wav',
        'x-upsert': 'true',
      },
      body: wavBuffer,
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed: ${text}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
if (!GEMINI_KEY)   { console.error('Missing GEMINI_API_KEY');      process.exit(1); }
if (!SUPABASE_KEY) { console.error('Missing SUPABASE_SERVICE_KEY'); process.exit(1); }

// ── Ensure the storage bucket exists ─────────────────────────────────────────
process.stdout.write(`Ensuring "${BUCKET}" storage bucket exists… `);
const bucketRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
});
const bucketData = await bucketRes.json();
if (bucketRes.ok || bucketData.message?.includes('already exists') || bucketData.error?.includes('already exists')) {
  console.log('✓');
} else {
  console.error(`\nFailed to create bucket: ${JSON.stringify(bucketData)}`);
  process.exit(1);
}

console.log(`\nGenerating ${VOICES.length} voice samples…\n`);

const results = {};

for (const voice of VOICES) {
  process.stdout.write(`  ${voice.padEnd(16)}`);
  try {
    const pcm = await generatePcm(voice);
    const wav = pcmToWav(pcm);
    const url = await uploadWav(voice, wav);
    results[voice] = url;
    console.log(`✓`);
  } catch (err) {
    console.log(`✗  ${err.message}`);
    results[voice] = null;
  }

  // Gemini 2.5 Flash TTS limit is 10 RPM — wait 7s between each call
  if (VOICES.indexOf(voice) < VOICES.length - 1) {
    process.stdout.write('  (waiting 7s for rate limit…)\n');
    await new Promise(r => setTimeout(r, 7000));
  }
}

// ── Print constants.ts snippet ────────────────────────────────────────────────
console.log('\n\n── Paste this into VOICES in constants.ts ──────────────────────────\n');

for (const [voice, url] of Object.entries(results)) {
  if (url) {
    console.log(`  sampleUrl for ${voice}:\n  "${url}"\n`);
  }
}

console.log('\nDone.');
