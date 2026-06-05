/**
 * upload-ambient-presets.mjs
 * Downloads free CC-licensed ambient audio from Wikimedia Commons and uploads
 * them to Supabase Storage so they can be used as audio zone presets.
 *
 * Usage:
 *   SUPABASE_SERVICE_KEY=<service-role-key> node scripts/upload-ambient-presets.mjs
 */

const SUPABASE_URL = 'https://pzlgiurtjrmkpbjlaabz.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET       = 'audio';
const PREFIX       = 'ambient-presets';

if (!SUPABASE_KEY) { console.error('Missing SUPABASE_SERVICE_KEY'); process.exit(1); }

// CC-licensed ambient sounds from Wikimedia Commons
const PRESETS = [
  {
    label: 'Rain',
    file:  'rain.ogg',
    url:   'https://upload.wikimedia.org/wikipedia/commons/8/8a/Sound_of_rain.ogg',
    mime:  'audio/ogg',
  },
  {
    label: 'Thunder',
    file:  'thunder.ogg',
    url:   'https://upload.wikimedia.org/wikipedia/commons/f/fa/Thunder_01.ogg',
    mime:  'audio/ogg',
  },
  {
    label: 'Forest',
    file:  'forest.wav',
    url:   'https://upload.wikimedia.org/wikipedia/commons/b/be/Forest_ambience_%28Gravity_Sound%29.wav',
    mime:  'audio/wav',
  },
  {
    label: 'Wind',
    file:  'wind.ogg',
    url:   'https://upload.wikimedia.org/wikipedia/commons/f/f3/Wind_in_Swedish_pine_forest_at_25_mps.ogg',
    mime:  'audio/ogg',
  },
];

// ── Ensure bucket exists ──────────────────────────────────────────────────────
process.stdout.write(`Ensuring "${BUCKET}" bucket exists… `);
const bucketRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
});
const bucketData = await bucketRes.json();
if (bucketRes.ok || bucketData.message?.includes('already exists') || bucketData.error?.includes('already exists')) {
  console.log('✓');
} else {
  console.error(`\nFailed to create bucket: ${JSON.stringify(bucketData)}`);
  process.exit(1);
}

console.log(`\nDownloading and uploading ${PRESETS.length} ambient presets…\n`);

const results = {};

for (const preset of PRESETS) {
  process.stdout.write(`  ${preset.label.padEnd(12)}`);

  try {
    // Download from Wikimedia
    const dlRes = await fetch(preset.url, {
      headers: { 'User-Agent': 'Obelisk/1.0 (https://obelisk.app; admin@obelisk.app)' },
    });
    if (!dlRes.ok) throw new Error(`Download failed: HTTP ${dlRes.status}`);
    const audioBuffer = Buffer.from(await dlRes.arrayBuffer());

    // Upload to Supabase
    const path = `${PREFIX}/${preset.file}`;
    const upRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': preset.mime,
        'x-upsert': 'true',
      },
      body: audioBuffer,
    });
    if (!upRes.ok) {
      const txt = await upRes.text();
      throw new Error(`Upload failed: ${txt}`);
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
    results[preset.label] = publicUrl;
    console.log(`✓  (${(audioBuffer.length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.log(`✗  ${err.message}`);
    results[preset.label] = null;
  }
}

// ── Print constants.ts snippet ────────────────────────────────────────────────
console.log('\n\n── Paste this into SAMPLE_AUDIO_FILES in constants.ts ──────────────────\n');
console.log('export const SAMPLE_AUDIO_FILES = [');
for (const [label, url] of Object.entries(results)) {
  if (url) console.log(`  { label: '${label}', url: '${url}' },`);
}
console.log('];\n');
console.log('Done.');
