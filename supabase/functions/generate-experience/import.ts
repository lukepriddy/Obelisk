/**
 * Document import — turn a finished script into zones without touching a word of it.
 *
 * This is a different job from `generate`. Generate invents an experience from a
 * brief. Import takes a script the creator already spent a week on and does the
 * part they hate: cutting it into zones, filling in the connective tissue, and
 * placing pins on a map.
 *
 * THE MODEL NEVER HANDLES THE CREATOR'S TEXT.
 *
 * That is the whole architecture, and it is not a stylistic preference. Real
 * documents carry content that cannot survive a paraphrase:
 *   • Egyptian hieroglyphs in the U+13000 plane, where the ORDER is the puzzle
 *     answer — two sixteen-glyph strings differing only in arrangement.
 *   • "broken, broken, solid, broken, broken, broken" — a hexagram, spelled out.
 *   • Radio frequencies, six-decimal coordinates, a Caesar cipher reading
 *     R… K… G… T…
 *   • Planted phrases that pay off ten zones later, word for word.
 *
 * A model asked to copy those WILL smooth one of them eventually, and nobody
 * would notice until a player was standing in a park unable to solve a puzzle.
 * So the document is numbered by line and the model returns LINE RANGES. The
 * server slices. Fidelity stops being something we verify and becomes something
 * the pipeline cannot violate.
 *
 * Two passes:
 *   READ  — the whole document at once: what convention marks its sections,
 *           which blocks are even zones, who is speaking, what the mechanics
 *           are. Small output, thinking ON, because this is the actual judgment.
 *   FILL  — per-zone metadata the creator does not want to write: titles,
 *           production notes, entry hooks, character and voice configuration.
 *
 * Everything FILL produces is recorded in `generated_fields`, so the editor can
 * show at a glance which words are the creator's and which are ours.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL = 'gemini-2.5-flash';

/** Placeholder geometry. 10 m matches the creator's own hand-built zones
 *  (Shmerg averages 6–7 m); 50 m apart keeps them visibly separate and
 *  individually draggable without any two ever touching. */
const DEFAULT_RADIUS_M = 10;
const SPACING_M = 50;
const ARC_DEGREES_PER_STEP = 4;

/** Guardrails. A week of writing is long; a paste bomb is something else. */
const MAX_DOCUMENT_CHARS = 200_000;
const MAX_LINES = 6000;
const MAX_ZONES = 60;

// ── Types ────────────────────────────────────────────────────────────────────

export type BlockKind =
  | 'zone'
  | 'placement_manifest'
  | 'puzzle_config'
  | 'resource_glossary'
  | 'front_matter'
  | 'ignore';

interface ReadingBlock {
  kind: BlockKind;
  start_line: number;
  end_line: number;
  label: string;
  speaker_id: string | null;
  suggested_type: 'audio' | 'character';
  reason: string;
}

interface Speaker {
  id: string;
  name: string;
  description: string;
  appears_in: string[];
}

interface Reading {
  convention: string;
  interpretation: string;
  title: string;
  subtitle: string;
  description: string;
  blocks: ReadingBlock[];
  speakers: Speaker[];
  mechanics: string[];
  concerns: string[];
}

interface FilledZone {
  order: number;
  title: string;
  description: string;
  entry_message: string | null;
  character_prompt: string | null;
  character_bio: string | null;
  greeting_message: string | null;
  voice_style: string | null;
  voice_instructions: string | null;
}

export interface ImportZone {
  order: number;
  title: string;
  type: 'audio' | 'character';
  suggested_type: 'audio' | 'character';
  locked: boolean;
  lat: number;
  lng: number;
  radius: number;
  location_name: string;
  description: string;
  /** The creator's own words, sliced from the source. Never model output. */
  script: string;
  entry_message: string | null;
  character_prompt: string | null;
  character_bio: string | null;
  greeting_message: string | null;
  voice_style: string | null;
  voice_instructions: string | null;
  lock_hint: string | null;
  lock_passphrase: string | null;
  /** Who speaks this zone, when the reading pass could tell. */
  speaker_name: string | null;
  /** Which fields above were written by the model rather than the creator. */
  generated_fields: string[];
  /** How this zone got its coordinates. */
  placement: 'from_document' | 'interpolated' | 'laid_out';
  source_lines: [number, number];
}

export interface ImportResult {
  title: string;
  subtitle: string;
  description: string;
  summary: string;
  zones: ImportZone[];
  reading: {
    convention: string;
    interpretation: string;
    mechanics: string[];
    speakers: { name: string; description: string; zones: number }[];
  };
  /** Blocks deliberately not made into zones, so nothing vanishes silently. */
  set_aside: { kind: BlockKind; label: string; lines: [number, number]; text: string }[];
  flags: string[];
}

// ── Geometry ─────────────────────────────────────────────────────────────────

const R_EARTH = 6371000;

function offsetPoint(lat: number, lng: number, bearingDeg: number, distM: number): [number, number] {
  const br = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const ad = distM / R_EARTH;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(ad) + Math.cos(lat1) * Math.sin(ad) * Math.cos(br));
  const lng2 = lng1 + Math.atan2(
    Math.sin(br) * Math.sin(ad) * Math.cos(lat1),
    Math.cos(ad) - Math.sin(lat1) * Math.sin(lat2),
  );
  return [(lat2 * 180) / Math.PI, (((lng2 * 180) / Math.PI + 540) % 360) - 180];
}

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}

// ── Coordinates written into the document ────────────────────────────────────

/**
 * Creators write coordinates two ways, and both appear in real scripts: a
 * manifest at the top keyed by name ("Indian Hunter 40.770321, -73.973254"),
 * or inline in the prose of the zone they belong to. Both are honoured — when
 * someone has already done the placement work, redoing it as a synthetic
 * layout would be worse than useless.
 */
const COORD_RE = /(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})/;

function parseCoordLine(line: string): { name: string; lat: number; lng: number } | null {
  const m = line.match(COORD_RE);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const name = line.slice(0, m.index ?? 0)
    .replace(/[()\[\]{}:—–\-•*#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { name, lat, lng };
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Loose name match: manifest entries rarely match a zone label exactly. */
function namesMatch(a: string, b: string): boolean {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// ── Gemini ───────────────────────────────────────────────────────────────────

async function callGemini(
  apiKey: string,
  body: Record<string, unknown>,
  label: string,
): Promise<unknown> {
  const res = await fetch(`${GEMINI_BASE}/${MODEL}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`Import ${label} failed:`, JSON.stringify(data).slice(0, 600));
    throw new Error(`import_${label}_failed`);
  }
  const finish = data.candidates?.[0]?.finishReason;
  if (finish && finish !== 'STOP') {
    // MAX_TOKENS here means a truncated JSON body, which parses into nonsense
    // or throws. Saying which stage ran out beats "Failed to parse".
    console.error(`Import ${label} stopped early: ${finish}`);
    throw new Error(`import_${label}_truncated`);
  }
  const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`Import ${label} returned unparseable JSON:`, raw.slice(0, 400));
    throw new Error(`import_${label}_unparseable`);
  }
}

// ── Pass 1: READ ─────────────────────────────────────────────────────────────

const READ_INSTRUCTION = `You are reading a finished script for a location-based walking experience and working out how to cut it into zones. A zone is one stop on a walk: the player arrives at a spot and hears one beat.

You are NOT writing, rewriting, improving or summarising anything. You return LINE RANGES into the document you were given. The creator's words are sacred and you never reproduce them.

FIRST, WORK OUT THE DOCUMENT'S OWN CONVENTION
Every writer marks sections differently. Some use a separator glyph. Some use numbered headings. Some use "Step N:". Some use blank lines and a change of speaker. Identify what THIS document does before you cut anything, and say so in "convention".

NOT EVERY BLOCK IS A ZONE. Classify each one:
- "zone" — content the player experiences at a location
- "placement_manifest" — a list of names with coordinates, usually near the top
- "puzzle_config" — cipher keys, symbol sequences, answers, step keys
- "resource_glossary" — definitions or reference material the player consults
- "front_matter" — title, notes to self, scratch
- "ignore" — anything else that is not player-facing

Getting this wrong is expensive: turning a puzzle key into a zone produces a stop where the player hears a list of symbols read aloud.

SEGMENT BY INTENT, NOT BY SHAPE
The document's structure is a hint, not the answer. Read the whole thing before deciding boundaries.
- A run of very short fragments is often a deliberate mechanic — one word per zone, assembling into a clue as the player walks. If earlier text says something like "you will hear six clues", then six separate zones is the intent, and merging them destroys the puzzle.
- One long section can hold two beats: an arrival, then a discovery.
- Stage directions ("the flute begins to play") are production notes, not lines to be heard. Keep them in the same zone; mention them in "reason".

SPEAKERS
Identify who speaks each zone. Give each distinct speaker one stable id and reuse it everywhere they appear — a narrator who returns three times is ONE speaker with one voice, not three. Conversely, seven different statues each narrating once are seven speakers. Speakers may be named in a label ("Bishop:"), implied by a section title, or only revealed mid-paragraph. If you cannot tell whether two sections share a speaker, say so in "concerns" rather than guessing.

TYPE
"character" means the player can talk to them. "audio" means the player listens. First-person monologue reads the same either way, so when it is genuinely ambiguous choose "audio" and note it.

CONCERNS
Report anything that looks inconsistent or that you had to guess: a stated count that does not match the content ("fourteen symbols" where you count sixteen), a speaker you could not resolve, a section that could be split either way. Be specific. This list is shown to the creator.

Return only JSON. Line numbers are 1-based and inclusive, taken from the numbered document. Ranges must not overlap. Cover as much of the document as you can — anything you leave out is reported to the creator as unused.`;

const READ_SCHEMA = {
  type: 'OBJECT',
  properties: {
    convention: { type: 'STRING' },
    interpretation: { type: 'STRING' },
    title: { type: 'STRING' },
    subtitle: { type: 'STRING' },
    description: { type: 'STRING' },
    blocks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: {
            type: 'STRING',
            enum: ['zone', 'placement_manifest', 'puzzle_config', 'resource_glossary', 'front_matter', 'ignore'],
          },
          start_line: { type: 'INTEGER' },
          end_line: { type: 'INTEGER' },
          label: { type: 'STRING' },
          speaker_id: { type: 'STRING', nullable: true },
          suggested_type: { type: 'STRING', enum: ['audio', 'character'] },
          reason: { type: 'STRING' },
        },
        required: ['kind', 'start_line', 'end_line', 'label', 'suggested_type', 'reason'],
      },
    },
    speakers: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          name: { type: 'STRING' },
          description: { type: 'STRING' },
          appears_in: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['id', 'name', 'description'],
      },
    },
    mechanics: { type: 'ARRAY', items: { type: 'STRING' } },
    concerns: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['convention', 'interpretation', 'title', 'blocks', 'speakers'],
};

async function readDocument(apiKey: string, numbered: string): Promise<Reading> {
  const reading = await callGemini(apiKey, {
    system_instruction: { parts: [{ text: READ_INSTRUCTION }] },
    contents: [{
      role: 'user',
      parts: [{
        text: `THE DOCUMENT (each line prefixed with its number — the numbers are not part of the text):\n\n${numbered}\n\nRead it and return the JSON.`,
      }],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 24576,
      responseMimeType: 'application/json',
      responseSchema: READ_SCHEMA,
      // Segmentation is the judgment this whole feature rests on — six one-word
      // zones or one merged one, a speaker who returns or a new one. Thinking
      // stays on here, and the output is small enough to afford it.
      thinkingConfig: { thinkingBudget: 8192 },
    },
  }, 'read') as Reading;

  reading.blocks = Array.isArray(reading.blocks) ? reading.blocks : [];
  reading.speakers = Array.isArray(reading.speakers) ? reading.speakers : [];
  reading.mechanics = Array.isArray(reading.mechanics) ? reading.mechanics : [];
  reading.concerns = Array.isArray(reading.concerns) ? reading.concerns : [];
  return reading;
}

// ── Pass 2: FILL ─────────────────────────────────────────────────────────────

const VOICE_OPTIONS =
  'Kore (firm/clear/F), Aoede (smooth/breezy/F), Leda (warm/friendly/F), ' +
  'Zephyr (bright/upbeat/F), Callirrhoe (soft/measured/F), Despina (gentle/thoughtful/F), ' +
  'Fenrir (intense/excitable/M), Puck (playful/youthful/M), Charon (deep/authoritative/M), ' +
  'Orus (confident/steady/M), Enceladus (smooth/professional/M), Gacrux (relaxed/conversational/M)';

const FILL_INSTRUCTION = `You are filling in the scaffolding around a script that is already written. The creator wrote every word of the zone content. You are writing ONLY the parts they do not want to write: titles, production notes, entry hooks, and character configuration.

RULES
- Never restate, summarise, paraphrase or "improve" the creator's text. It is not yours and it is not shown to you for editing.
- Never use an em dash (—) in anything you write. Use a comma, a colon, parentheses or a full stop instead. This applies to every field you return.
- Match their register. If the writing is wry and digressive, your entry hooks are wry and digressive. If it is clinical, so are you.
- A speaker who appears in several zones gets ONE consistent voice, bio and delivery direction across all of them. You are given a speaker registry; use the same characterisation everywhere that speaker appears.

FIELDS
- title: 2–5 words naming this stop. If the script already labels the section, keep that label's sense.
- description: a production note for the creator, not for the player. What happens here, what audio is needed, any stage direction present in the script. One or two sentences.
- entry_message: 1–2 sentences the player sees on arrival. A hook, never a summary, and never a spoiler. Null if the script's own opening already serves that purpose.
- character_prompt: only when there is a speaker. Second person ("You are…"), 3–5 sentences covering voice, what they want, and what they know but will not volunteer. Ground it in details from the script.
- character_bio: a short player-facing teaser, no spoilers.
- greeting_message: their opening line, in voice, at most two sentences. Null if the script already opens with one.
- voice_style: the closest prebuilt voice — ${VOICE_OPTIONS}
- voice_instructions: a delivery direction under 15 words, e.g. "Gravelly old fisherman, unhurried, faint Irish lilt".

Return one entry per zone, in the order given. Null out anything that does not apply.`;

const FILL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    zones: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          order: { type: 'INTEGER' },
          title: { type: 'STRING' },
          description: { type: 'STRING' },
          entry_message: { type: 'STRING', nullable: true },
          character_prompt: { type: 'STRING', nullable: true },
          character_bio: { type: 'STRING', nullable: true },
          greeting_message: { type: 'STRING', nullable: true },
          voice_style: { type: 'STRING', nullable: true },
          voice_instructions: { type: 'STRING', nullable: true },
        },
        required: ['order', 'title', 'description'],
      },
    },
  },
  required: ['zones'],
};

async function fillZones(
  apiKey: string,
  speakers: Speaker[],
  zones: { order: number; label: string; speaker: Speaker | null; script: string }[],
): Promise<Map<number, FilledZone>> {
  const registry = speakers.length
    ? speakers.map(s => `- ${s.id} — ${s.name}: ${s.description}`).join('\n')
    : '(no named speakers identified)';

  const body = zones.map(z => [
    `ZONE ${z.order} — ${z.label}`,
    z.speaker ? `Speaker: ${z.speaker.id} (${z.speaker.name})` : 'Speaker: none identified',
    'Script:',
    z.script,
  ].join('\n')).join('\n\n───\n\n');

  const filled = await callGemini(apiKey, {
    system_instruction: { parts: [{ text: FILL_INSTRUCTION }] },
    contents: [{
      role: 'user',
      parts: [{ text: `SPEAKER REGISTRY\n${registry}\n\nZONES\n\n${body}` }],
    }],
    generationConfig: {
      temperature: 0.8,
      maxOutputTokens: 32768,
      responseMimeType: 'application/json',
      responseSchema: FILL_SCHEMA,
      thinkingConfig: { thinkingBudget: 2048 },
    },
  }, 'fill') as { zones: FilledZone[] };

  const byOrder = new Map<number, FilledZone>();
  for (const z of filled.zones ?? []) byOrder.set(Number(z.order), z);
  return byOrder;
}

// ── Placement ────────────────────────────────────────────────────────────────

type Placed = { lat: number; lng: number; placement: ImportZone['placement'] };

/**
 * Zones with coordinates in the document keep them. Runs without coordinates
 * are interpolated between their nearest anchored neighbours, and anything
 * still unplaced is laid out along a gentle arc from the start point.
 *
 * The arc is deliberately dumb. The creator said placement is the easy part —
 * they will drag pins — so the only job here is a sequence that is legible on a
 * map and never overlapping, not a clever route.
 */
function placeZones(
  count: number,
  anchors: Map<number, [number, number]>,
  fallback: [number, number] | null,
): Placed[] {
  const out: Placed[] = new Array(count);
  for (const [i, [lat, lng]] of anchors) {
    if (i >= 0 && i < count) out[i] = { lat, lng, placement: 'from_document' };
  }

  const known = [...Array(count).keys()].filter(i => out[i]);

  if (known.length === 0) {
    const origin = fallback ?? [0, 0];
    let [lat, lng] = origin;
    let bearing = 45;
    for (let i = 0; i < count; i++) {
      out[i] = { lat, lng, placement: 'laid_out' };
      [lat, lng] = offsetPoint(lat, lng, bearing, SPACING_M);
      bearing = (bearing + ARC_DEGREES_PER_STEP) % 360;
    }
    return out;
  }

  // Gaps bounded by two anchors: spread evenly along the straight line between.
  for (let k = 0; k < known.length - 1; k++) {
    const a = known[k];
    const b = known[k + 1];
    const gap = b - a - 1;
    if (gap <= 0) continue;
    for (let j = 1; j <= gap; j++) {
      const t = j / (gap + 1);
      out[a + j] = {
        lat: out[a].lat + (out[b].lat - out[a].lat) * t,
        lng: out[a].lng + (out[b].lng - out[a].lng) * t,
        placement: 'interpolated',
      };
    }
  }

  // Leading and trailing runs: continue the arc outward from the end anchor.
  const first = known[0];
  const last = known[known.length - 1];
  let bearing = 225;
  let [lat, lng] = [out[first].lat, out[first].lng];
  for (let i = first - 1; i >= 0; i--) {
    [lat, lng] = offsetPoint(lat, lng, bearing, SPACING_M);
    out[i] = { lat, lng, placement: 'laid_out' };
    bearing = (bearing + ARC_DEGREES_PER_STEP) % 360;
  }
  bearing = 45;
  [lat, lng] = [out[last].lat, out[last].lng];
  for (let i = last + 1; i < count; i++) {
    [lat, lng] = offsetPoint(lat, lng, bearing, SPACING_M);
    out[i] = { lat, lng, placement: 'laid_out' };
    bearing = (bearing + ARC_DEGREES_PER_STEP) % 360;
  }

  return out;
}

/** Nudge any pair closer than their radii apart, so nothing ever overlaps. */
function separate(zones: ImportZone[]): number {
  let nudged = 0;
  for (let i = 1; i < zones.length; i++) {
    const prev = zones[i - 1];
    const cur = zones[i];
    if (cur.placement === 'from_document' && prev.placement === 'from_document') continue;
    const need = prev.radius + cur.radius + 5;
    const have = metersBetween(prev.lat, prev.lng, cur.lat, cur.lng);
    if (have >= need) continue;
    const bearing = 45 + i * ARC_DEGREES_PER_STEP;
    const [lat, lng] = offsetPoint(prev.lat, prev.lng, bearing, Math.max(need, SPACING_M));
    cur.lat = lat;
    cur.lng = lng;
    nudged += 1;
  }
  return nudged;
}

// ── Orchestration ────────────────────────────────────────────────────────────

export async function importDocument(
  apiKey: string,
  document: string,
  startLat?: number,
  startLng?: number,
): Promise<ImportResult> {
  const text = document.slice(0, MAX_DOCUMENT_CHARS);
  const lines = text.split('\n').slice(0, MAX_LINES);
  if (lines.filter(l => l.trim()).length < 3) throw new Error('import_document_too_short');

  const numbered = lines.map((l, i) => `${i + 1}|${l}`).join('\n');
  const reading = await readDocument(apiKey, numbered);

  const flags: string[] = [...reading.concerns];
  const lineAt = (n: number) => lines[n - 1] ?? '';
  const sliceLines = (a: number, b: number) =>
    lines.slice(Math.max(0, a - 1), Math.min(lines.length, b)).join('\n').trim();

  // Sort by position and drop anything nonsensical rather than trusting order.
  const blocks = reading.blocks
    .map(b => ({
      ...b,
      start_line: Math.max(1, Math.min(lines.length, Math.round(Number(b.start_line)))),
      end_line: Math.max(1, Math.min(lines.length, Math.round(Number(b.end_line)))),
    }))
    .filter(b => Number.isFinite(b.start_line) && Number.isFinite(b.end_line) && b.end_line >= b.start_line)
    .sort((a, b) => a.start_line - b.start_line);

  // Overlaps mean two zones would claim the same words. Trim rather than drop:
  // losing content is worse than a boundary being a line off.
  for (let i = 1; i < blocks.length; i++) {
    if (blocks[i].start_line <= blocks[i - 1].end_line) {
      blocks[i - 1].end_line = blocks[i].start_line - 1;
    }
  }

  const zoneBlocks = blocks
    .filter(b => b.kind === 'zone' && b.end_line >= b.start_line)
    .filter(b => sliceLines(b.start_line, b.end_line).length > 0)
    .slice(0, MAX_ZONES);

  if (zoneBlocks.length === 0) throw new Error('import_no_zones_found');

  const speakerById = new Map(reading.speakers.map(s => [s.id, s]));

  // ── Coordinates the creator already supplied ───────────────────────────────
  const anchors = new Map<number, [number, number]>();

  // (a) A manifest block: name-keyed lines matched to zone labels.
  const manifest: { name: string; lat: number; lng: number }[] = [];
  for (const b of blocks.filter(x => x.kind === 'placement_manifest')) {
    for (let n = b.start_line; n <= b.end_line; n++) {
      const parsed = parseCoordLine(lineAt(n));
      if (parsed?.name) manifest.push(parsed);
    }
  }
  const usedManifest = new Set<number>();
  zoneBlocks.forEach((b, i) => {
    const hit = manifest.findIndex((m, mi) =>
      !usedManifest.has(mi) && (namesMatch(m.name, b.label) ||
        (b.speaker_id ? namesMatch(m.name, speakerById.get(b.speaker_id)?.name ?? '') : false)));
    if (hit >= 0) {
      usedManifest.add(hit);
      anchors.set(i, [manifest[hit].lat, manifest[hit].lng]);
    }
  });
  const unmatched = manifest.filter((_, i) => !usedManifest.has(i));
  if (unmatched.length) {
    flags.push(`${unmatched.length} coordinate${unmatched.length === 1 ? '' : 's'} in the document could not be matched to a zone by name: ${unmatched.map(m => m.name || 'unnamed').join(', ')}.`);
  }

  // (b) Coordinates written inline in a zone's own text.
  zoneBlocks.forEach((b, i) => {
    if (anchors.has(i)) return;
    for (let n = b.start_line; n <= b.end_line; n++) {
      const parsed = parseCoordLine(lineAt(n));
      if (parsed) { anchors.set(i, [parsed.lat, parsed.lng]); return; }
    }
  });

  const fallback: [number, number] | null =
    typeof startLat === 'number' && typeof startLng === 'number' ? [startLat, startLng] : null;
  if (anchors.size === 0 && !fallback) throw new Error('import_needs_start_point');

  // ── Fill the gaps ──────────────────────────────────────────────────────────
  const forFill = zoneBlocks.map((b, i) => ({
    order: i + 1,
    label: b.label,
    speaker: b.speaker_id ? speakerById.get(b.speaker_id) ?? null : null,
    script: sliceLines(b.start_line, b.end_line),
  }));

  let filled: Map<number, FilledZone>;
  try {
    filled = await fillZones(apiKey, reading.speakers, forFill);
  } catch (e) {
    // The creator's own words are already safe on the server. Losing the
    // scaffolding is a degraded import, not a failed one.
    console.error('Import fill stage failed; returning zones without scaffolding:', e);
    filled = new Map();
    flags.push('Automatic titles and character setup were unavailable, so zones carry your text only. Everything you wrote is intact.');
  }

  const placed = placeZones(zoneBlocks.length, anchors, fallback);

  const zones: ImportZone[] = zoneBlocks.map((b, i) => {
    const f = filled.get(i + 1);
    const speaker = b.speaker_id ? speakerById.get(b.speaker_id) ?? null : null;
    const generated: string[] = [];
    const take = <T,>(field: string, value: T | null | undefined): T | null => {
      if (value == null || (typeof value === 'string' && !value.trim())) return null;
      generated.push(field);
      return value;
    };

    const title = f?.title?.trim() || b.label || `Zone ${i + 1}`;
    if (f?.title?.trim()) generated.push('title');

    return {
      order: i + 1,
      // Import always lands on 'audio'. A first-person monologue reads the same
      // whether it is a recording or someone to talk to, so guessing wrong
      // means the creator has to undo work. The suggestion rides along and the
      // character fields are filled either way, so flipping it costs one tap.
      type: 'audio',
      suggested_type: b.suggested_type === 'character' ? 'character' : 'audio',
      locked: false,
      title,
      lat: placed[i].lat,
      lng: placed[i].lng,
      radius: DEFAULT_RADIUS_M,
      location_name: b.label || title,
      description: take('description', f?.description) ?? '',
      script: sliceLines(b.start_line, b.end_line),
      entry_message: take('entry_message', f?.entry_message),
      character_prompt: take('character_prompt', f?.character_prompt),
      character_bio: take('character_bio', f?.character_bio),
      greeting_message: take('greeting_message', f?.greeting_message),
      voice_style: take('voice_style', f?.voice_style),
      voice_instructions: take('voice_instructions', f?.voice_instructions),
      // Locks are never invented on import. Real scripts gate with physical
      // props and ciphers the creator designed; a guessed passphrase would be
      // wrong and a wrong passphrase is a dead end in the middle of a walk.
      lock_hint: null,
      lock_passphrase: null,
      generated_fields: generated,
      placement: placed[i].placement,
      source_lines: [b.start_line, b.end_line],
      speaker_name: speaker?.name ?? null,
    };
  });

  const nudged = separate(zones);
  if (nudged) flags.push(`${nudged} zone${nudged === 1 ? '' : 's'} were moved slightly so no two overlap. Drag them where you want.`);

  // ── Nothing disappears quietly ─────────────────────────────────────────────
  const covered = new Set<number>();
  for (const b of blocks) for (let n = b.start_line; n <= b.end_line; n++) covered.add(n);
  const orphans = lines
    .map((l, i) => ({ n: i + 1, l }))
    .filter(x => x.l.trim() && !covered.has(x.n));
  if (orphans.length) {
    flags.push(`${orphans.length} line${orphans.length === 1 ? '' : 's'} of the document were not placed in any zone (first at line ${orphans[0].n}).`);
  }

  const setAside = blocks
    .filter(b => b.kind !== 'zone' && b.kind !== 'ignore')
    .map(b => ({
      kind: b.kind,
      label: b.label,
      lines: [b.start_line, b.end_line] as [number, number],
      text: sliceLines(b.start_line, b.end_line).slice(0, 2000),
    }))
    .filter(b => b.text.length > 0);

  const zonesPerSpeaker = new Map<string, number>();
  for (const b of zoneBlocks) {
    if (b.speaker_id) zonesPerSpeaker.set(b.speaker_id, (zonesPerSpeaker.get(b.speaker_id) ?? 0) + 1);
  }

  return {
    title: reading.title?.trim() || 'Imported experience',
    subtitle: reading.subtitle?.trim() || '',
    description: reading.description?.trim() || '',
    summary: reading.interpretation?.trim() || '',
    zones,
    reading: {
      convention: reading.convention ?? '',
      interpretation: reading.interpretation ?? '',
      mechanics: reading.mechanics,
      speakers: reading.speakers.map(s => ({
        name: s.name,
        description: s.description,
        zones: zonesPerSpeaker.get(s.id) ?? 0,
      })),
    },
    set_aside: setAside,
    flags,
  };
}
