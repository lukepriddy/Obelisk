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

/** A resource the player collects. Defined once on the tour, referenced by
 *  the zones that grant or require it. */
interface ReadResource {
  id: string;
  name: string;
  description: string;
}

interface ReadReward { resource_id: string; amount: number }
interface ReadRequirement { resource_id: string; amount: number; consume: boolean }

interface ReadingBlock {
  kind: BlockKind;
  start_line: number;
  end_line: number;
  label: string;
  speaker_id: string | null;
  suggested_type: 'audio' | 'character' | 'discoverable';
  reason: string;

  /** Lines inside this block that are instructions TO US, not content.
   *  Dropped before slicing, so a note like "[[locked: PIER]]" never ends up
   *  in the voiceover script and gets read aloud to a player. */
  directive_lines: number[];

  /** True when the creator stated the type outright rather than us inferring
   *  it. An explicit instruction is obeyed; an inference is only suggested. */
  type_is_explicit: boolean;

  locked: boolean;
  lock_passphrase: string | null;
  lock_hint: string | null;

  on_end: 'loop' | 'stop' | 'destroy' | null;
  on_exit: 'pause' | 'stop' | 'keep' | null;
  is_visible: boolean | null;
  is_mystery: boolean | null;
  radius: number | null;

  /** 1-based position of the zone that must be visited first. Resolved to a
   *  real id after the zones exist. */
  requires_zone: number | null;

  rewards: ReadReward[];
  requirements: ReadRequirement[];
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
  resources: ReadResource[];
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
  type: 'audio' | 'character' | 'discoverable';
  suggested_type: 'audio' | 'character' | 'discoverable';
  /** The type came from an instruction in the script, not from inference. */
  type_is_explicit: boolean;
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

  // ── Playback and visibility, set only when the script asked for them ──────
  on_end: 'loop' | 'stop' | 'destroy' | null;
  on_exit: 'pause' | 'stop' | 'keep' | null;
  is_visible: boolean | null;
  is_mystery: boolean | null;

  // ── Progression ──────────────────────────────────────────────────────────
  rewards: ReadReward[];
  requirements: ReadRequirement[];
  /** 1-based zone number that must be visited first. The client turns this
   *  into requires_zone_id once the zones have real ids. */
  requires_zone_order: number | null;

  /** Who speaks this zone, when the reading pass could tell. */
  speaker_name: string | null;
  /** Which fields above were written by the model rather than the creator. */
  generated_fields: string[];
  /** Settings that came from an instruction you wrote, listed for review. */
  applied_settings: string[];
  /** How this zone got its coordinates. */
  placement: 'from_document' | 'interpolated' | 'laid_out';
  source_lines: [number, number];
}

/** A collectible defined once for the whole experience. */
export interface ImportResource {
  id: string;
  name: string;
  description: string;
}

export interface ImportResult {
  title: string;
  subtitle: string;
  description: string;
  summary: string;
  zones: ImportZone[];
  /** Collectibles found in the script, to be defined on the tour. */
  resources: ImportResource[];
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
"character" means the player can talk to them. "audio" means the player listens. "discoverable" is a small collectible the player picks up at a spot, granting them something. First-person monologue reads the same as audio or character either way, so when it is genuinely ambiguous choose "audio", set type_is_explicit false, and note it. When the creator states the type outright, set type_is_explicit true.

INSTRUCTIONS TO US, MIXED INTO THE SCRIPT
Creators annotate their own documents. A line may say "[[locked: PIER]]", "[[character]]", "make this one loop", "hidden zone", "radius 8m". These are instructions, NOT content, and this matters twice over: the setting has to be applied, and the line must never reach the player. Put every such line number in directive_lines so it is stripped before the text is used. A missed one gets read aloud by a text-to-speech voice.

Set the matching field when you see an instruction, and leave it null when you do not. Never invent one:
- locked / lock_passphrase / lock_hint. The passphrase must be copied EXACTLY as written. It is verified against the document and dropped if it does not match, so do not tidy it.
- on_end: "loop" for audio that repeats, "destroy" for play-once-then-gone, "stop" otherwise.
- on_exit: what happens when the player walks out ("pause", "stop", "keep").
- is_visible: false for a zone hidden from the map. Lines like "do not look for me" are a hint, but only set this when the creator means the zone is hidden.
- is_mystery: a collectible shown as an unknown glyph until picked up.
- radius: in metres, only when a number is given.
- requires_zone: the 1-based number of the zone that must be visited first, when the script gates one beat behind another.

PROGRESSION
Many scripts are built around collecting things: symbols, tokens, clues, an object carried from one place to another. Where that is happening, define it.
- resources: one entry per collectible, with a short slug id, the creator's name for it, and a one-line description. A glossary block listing symbols and their meanings is exactly this. So is a prop introduced early and used late.
- rewards: on the zone where the player GETS one, reference the resource id and an amount.
- requirements: on a zone that cannot proceed without them. Set consume true only if the item is spent there.
Only reference resource ids you defined. Anything dangling is dropped and reported.
If the script has no collecting in it, return an empty list. Do not manufacture a mechanic.

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
          suggested_type: { type: 'STRING', enum: ['audio', 'character', 'discoverable'] },
          reason: { type: 'STRING' },
          directive_lines: { type: 'ARRAY', items: { type: 'INTEGER' } },
          type_is_explicit: { type: 'BOOLEAN' },
          locked: { type: 'BOOLEAN' },
          lock_passphrase: { type: 'STRING', nullable: true },
          lock_hint: { type: 'STRING', nullable: true },
          on_end: { type: 'STRING', enum: ['loop', 'stop', 'destroy'], nullable: true },
          on_exit: { type: 'STRING', enum: ['pause', 'stop', 'keep'], nullable: true },
          is_visible: { type: 'BOOLEAN', nullable: true },
          is_mystery: { type: 'BOOLEAN', nullable: true },
          radius: { type: 'NUMBER', nullable: true },
          requires_zone: { type: 'INTEGER', nullable: true },
          rewards: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { resource_id: { type: 'STRING' }, amount: { type: 'INTEGER' } },
              required: ['resource_id', 'amount'],
            },
          },
          requirements: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                resource_id: { type: 'STRING' },
                amount: { type: 'INTEGER' },
                consume: { type: 'BOOLEAN' },
              },
              required: ['resource_id', 'amount', 'consume'],
            },
          },
        },
        required: ['kind', 'start_line', 'end_line', 'label', 'suggested_type', 'reason'],
      },
    },
    resources: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          name: { type: 'STRING' },
          description: { type: 'STRING' },
        },
        required: ['id', 'name', 'description'],
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
  reading.resources = Array.isArray(reading.resources) ? reading.resources : [];
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
  finish: [number, number] | null,
  spacing: number,
  notes: string[],
): Placed[] {
  const out: Placed[] = new Array(count);
  for (const [i, [lat, lng]] of anchors) {
    if (i >= 0 && i < count) out[i] = { lat, lng, placement: 'from_document' };
  }

  const known = [...Array(count).keys()].filter(i => out[i]);

  if (known.length === 0) {
    const origin = fallback ?? [0, 0];

    // With an end point, the walk has a shape the creator chose: run the
    // zones evenly from one to the other. Without one, fall back to an arc,
    // which is only there to make the sequence legible before they drag it.
    if (finish && count > 1) {
      const span = metersBetween(origin[0], origin[1], finish[0], finish[1]);
      const needed = (count - 1) * spacing;
      if (span >= needed) {
        for (let i = 0; i < count; i++) {
          const t = i / (count - 1);
          out[i] = {
            lat: origin[0] + (finish[0] - origin[0]) * t,
            lng: origin[1] + (finish[1] - origin[1]) * t,
            placement: 'laid_out',
          };
        }
        return out;
      }
      // The route is too short to hold this many zones without them touching.
      // Keep the bearing, overshoot the end, and say so rather than stacking.
      notes.push(`Your start and end are ${Math.round(span)} m apart, which is not enough room for ${count} zones at this size. They were spaced out past the end point instead. Drag them where you want.`);
      const bearing = bearingBetween(origin[0], origin[1], finish[0], finish[1]);
      for (let i = 0; i < count; i++) {
        const [lat, lng] = i === 0 ? origin : offsetPoint(origin[0], origin[1], bearing, i * spacing);
        out[i] = { lat, lng, placement: 'laid_out' };
      }
      return out;
    }

    let [lat, lng] = origin;
    let bearing = 45;
    for (let i = 0; i < count; i++) {
      out[i] = { lat, lng, placement: 'laid_out' };
      [lat, lng] = offsetPoint(lat, lng, bearing, spacing);
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
    [lat, lng] = offsetPoint(lat, lng, bearing, spacing);
    out[i] = { lat, lng, placement: 'laid_out' };
    bearing = (bearing + ARC_DEGREES_PER_STEP) % 360;
  }
  bearing = 45;
  [lat, lng] = [out[last].lat, out[last].lng];
  for (let i = last + 1; i < count; i++) {
    [lat, lng] = offsetPoint(lat, lng, bearing, spacing);
    out[i] = { lat, lng, placement: 'laid_out' };
    bearing = (bearing + ARC_DEGREES_PER_STEP) % 360;
  }

  return out;
}

function bearingBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos((bLat * Math.PI) / 180);
  const x = Math.cos((aLat * Math.PI) / 180) * Math.sin((bLat * Math.PI) / 180) -
    Math.sin((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Nudge any pair closer than their radii apart, so nothing ever overlaps. */
function separate(zones: ImportZone[], spacing: number): number {
  let nudged = 0;
  for (let i = 1; i < zones.length; i++) {
    const prev = zones[i - 1];
    const cur = zones[i];
    if (cur.placement === 'from_document' && prev.placement === 'from_document') continue;
    const need = prev.radius + cur.radius + 5;
    const have = metersBetween(prev.lat, prev.lng, cur.lat, cur.lng);
    if (have >= need) continue;
    const bearing = 45 + i * ARC_DEGREES_PER_STEP;
    const [lat, lng] = offsetPoint(prev.lat, prev.lng, bearing, Math.max(need, spacing));
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
  endLat?: number,
  endLng?: number,
  defaultRadius?: number,
): Promise<ImportResult> {
  // The creator sets the zone size on the way in, because theirs run small:
  // their own hand-built experiences average 6 to 7 metres, not the 15 to 40
  // a generated one uses. Anything a script asks for per zone overrides this.
  const baseRadius = Number.isFinite(Number(defaultRadius)) && Number(defaultRadius) > 0
    ? Math.min(120, Math.max(3, Math.round(Number(defaultRadius))))
    : DEFAULT_RADIUS_M;
  // Zones sit at least their own width apart, so a small zone size gives a
  // tight walk and a large one spreads out, without ever overlapping.
  const spacing = Math.max(SPACING_M, baseRadius * 4);
  const text = document.slice(0, MAX_DOCUMENT_CHARS);
  const lines = text.split('\n').slice(0, MAX_LINES);
  if (lines.filter(l => l.trim()).length < 3) throw new Error('import_document_too_short');

  const numbered = lines.map((l, i) => `${i + 1}|${l}`).join('\n');
  const reading = await readDocument(apiKey, numbered);

  const flags: string[] = [...reading.concerns];
  const lineAt = (n: number) => lines[n - 1] ?? '';

  /**
   * Slice a range, dropping the lines the creator wrote as instructions to us.
   *
   * This is the second half of the fidelity guarantee and it is easy to
   * underrate. A line reading "[[locked: PIER]]" is not content; if it stays
   * in the slice it lands in voiceover_script, and a text-to-speech voice
   * reads the creator's note out loud to a player standing in a park.
   */
  const sliceLines = (a: number, b: number, skip: Set<number> = new Set()) =>
    lines
      .slice(Math.max(0, a - 1), Math.min(lines.length, b))
      .filter((_, i) => !skip.has(a + i))
      .join('\n')
      .trim();

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

  const skipFor = (b: ReadingBlock) =>
    new Set((Array.isArray(b.directive_lines) ? b.directive_lines : []).map(Number).filter(Number.isFinite));

  const zoneBlocks = blocks
    .filter(b => b.kind === 'zone' && b.end_line >= b.start_line)
    .filter(b => sliceLines(b.start_line, b.end_line, skipFor(b)).length > 0)
    .slice(0, MAX_ZONES);

  if (zoneBlocks.length === 0) throw new Error('import_no_zones_found');

  const speakerById = new Map(reading.speakers.map(s => [s.id, s]));

  // ── Progression, checked before anything references it ────────────────────
  //
  // A dangling resource id is the progression equivalent of a passphrase that
  // appears nowhere: the player reaches a gate they cannot open. So the
  // defined set is the only thing zones may point at, and anything else is
  // dropped and reported rather than written and discovered in the field.
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

  const resources: ImportResource[] = [];
  const resourceIds = new Set<string>();
  const byName = new Map<string, string>();
  for (const r of reading.resources) {
    const id = slug(r?.id || r?.name || '');
    if (!id || resourceIds.has(id)) continue;
    resourceIds.add(id);
    byName.set(slug(r?.name || ''), id);
    resources.push({ id, name: (r?.name || id).trim(), description: (r?.description || '').trim() });
  }

  const droppedRefs: string[] = [];
  const resolveResource = (raw: string): string | null => {
    const s = slug(raw || '');
    if (resourceIds.has(s)) return s;
    const byNameHit = byName.get(s);
    if (byNameHit) return byNameHit;
    if (raw) droppedRefs.push(raw);
    return null;
  };

  // The passphrase is the one short string the model hands back rather than
  // the server slicing it, because "the answer is PIER" cannot be captured by
  // a line range. It is only accepted if it appears in the document exactly.
  const documentHas = (needle: string) => text.includes(needle);

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
  const finish: [number, number] | null =
    typeof endLat === 'number' && typeof endLng === 'number' ? [endLat, endLng] : null;
  if (anchors.size === 0 && !fallback) throw new Error('import_needs_start_point');

  // ── Fill the gaps ──────────────────────────────────────────────────────────
  const forFill = zoneBlocks.map((b, i) => ({
    order: i + 1,
    label: b.label,
    speaker: b.speaker_id ? speakerById.get(b.speaker_id) ?? null : null,
    script: sliceLines(b.start_line, b.end_line, skipFor(b)),
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

  const placed = placeZones(zoneBlocks.length, anchors, fallback, finish, spacing, flags);

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

    // Settings the creator asked for, listed so the review screen can show
    // exactly what was applied rather than leaving it to be found later.
    const applied: string[] = [];
    const suggested: ImportZone['type'] =
      b.suggested_type === 'character' || b.suggested_type === 'discoverable'
        ? b.suggested_type : 'audio';

    // An explicit instruction is obeyed. An inference is only ever a
    // suggestion, because a first-person monologue reads the same whether it
    // is a recording or someone to talk to, and guessing wrong means the
    // creator undoes work. The character fields are filled either way, so
    // switching an audio zone over costs one tap.
    const type: ImportZone['type'] = b.type_is_explicit === true ? suggested : 'audio';
    if (b.type_is_explicit === true && type !== 'audio') applied.push(`type: ${type}`);

    // A passphrase is only trusted if it is really in the document. A locked
    // zone whose answer appears nowhere is a dead end in the middle of a walk,
    // so a mismatch unlocks the zone and says so.
    let locked = b.locked === true;
    let passphrase = b.lock_passphrase?.trim() || null;
    if (locked && passphrase && !documentHas(passphrase)) {
      flags.push(`Zone ${i + 1} asked for the passphrase "${passphrase}", which does not appear in your script exactly as written. The zone was left unlocked.`);
      locked = false;
      passphrase = null;
    } else if (locked && !passphrase) {
      flags.push(`Zone ${i + 1} is marked locked but no passphrase was given, so it was left unlocked.`);
      locked = false;
    } else if (locked) {
      applied.push('locked');
    }

    const rewards = (Array.isArray(b.rewards) ? b.rewards : [])
      .map(r => ({ resource_id: resolveResource(r?.resource_id), amount: Math.max(1, Math.round(Number(r?.amount) || 1)) }))
      .filter((r): r is ReadReward => !!r.resource_id);
    const requirements = (Array.isArray(b.requirements) ? b.requirements : [])
      .map(r => ({
        resource_id: resolveResource(r?.resource_id),
        amount: Math.max(1, Math.round(Number(r?.amount) || 1)),
        consume: r?.consume === true,
      }))
      .filter((r): r is ReadRequirement => !!r.resource_id);
    if (rewards.length) applied.push(`grants ${rewards.length} item${rewards.length === 1 ? '' : 's'}`);
    if (requirements.length) applied.push(`needs ${requirements.length} item${requirements.length === 1 ? '' : 's'}`);

    const onEnd = b.on_end === 'loop' || b.on_end === 'destroy' || b.on_end === 'stop' ? b.on_end : null;
    if (onEnd) applied.push(`on end: ${onEnd}`);
    const onExit = b.on_exit === 'pause' || b.on_exit === 'keep' || b.on_exit === 'stop' ? b.on_exit : null;
    if (onExit) applied.push(`on exit: ${onExit}`);
    const isVisible = typeof b.is_visible === 'boolean' ? b.is_visible : null;
    if (isVisible === false) applied.push('hidden from the map');
    const isMystery = typeof b.is_mystery === 'boolean' ? b.is_mystery : null;
    if (isMystery) applied.push('mystery');

    const askedRadius = Number(b.radius);
    const radius = Number.isFinite(askedRadius) && askedRadius > 0
      ? Math.min(120, Math.max(3, Math.round(askedRadius)))
      : baseRadius;
    if (radius !== baseRadius) applied.push(`radius ${radius} m`);

    // Gating points at a zone NUMBER here. Real ids do not exist until the
    // zones are created, so the client resolves it in a second pass.
    const reqZone = Math.round(Number(b.requires_zone));
    const requiresZoneOrder =
      Number.isFinite(reqZone) && reqZone >= 1 && reqZone <= zoneBlocks.length && reqZone !== i + 1
        ? reqZone : null;
    if (requiresZoneOrder) applied.push(`after zone ${requiresZoneOrder}`);

    return {
      order: i + 1,
      type,
      suggested_type: suggested,
      type_is_explicit: b.type_is_explicit === true,
      locked,
      title,
      lat: placed[i].lat,
      lng: placed[i].lng,
      radius,
      location_name: b.label || title,
      description: take('description', f?.description) ?? '',
      script: sliceLines(b.start_line, b.end_line, skipFor(b)),
      entry_message: take('entry_message', f?.entry_message),
      character_prompt: take('character_prompt', f?.character_prompt),
      character_bio: take('character_bio', f?.character_bio),
      greeting_message: take('greeting_message', f?.greeting_message),
      voice_style: take('voice_style', f?.voice_style),
      voice_instructions: take('voice_instructions', f?.voice_instructions),
      // Locks are never invented, only obeyed. Every one here came from an
      // instruction in the script and survived the check that its passphrase
      // really appears in the document.
      lock_hint: locked ? (b.lock_hint?.trim() || null) : null,
      lock_passphrase: passphrase,
      on_end: onEnd,
      on_exit: onExit,
      is_visible: isVisible,
      is_mystery: isMystery,
      rewards,
      requirements,
      requires_zone_order: requiresZoneOrder,
      generated_fields: generated,
      applied_settings: applied,
      placement: placed[i].placement,
      source_lines: [b.start_line, b.end_line],
      speaker_name: speaker?.name ?? null,
    };
  });

  if (droppedRefs.length) {
    const unique = [...new Set(droppedRefs)];
    flags.push(`${unique.length} reference${unique.length === 1 ? '' : 's'} to an item that was never defined ${unique.length === 1 ? 'was' : 'were'} dropped: ${unique.join(', ')}.`);
  }
  // A collectible nothing hands out is a gate that never opens.
  const granted = new Set(zones.flatMap(z => z.rewards.map(r => r.resource_id)));
  const ungettable = resources.filter(r => !granted.has(r.id));
  if (ungettable.length) {
    flags.push(`${ungettable.map(r => r.name).join(', ')} ${ungettable.length === 1 ? 'is' : 'are'} defined but never granted by any zone, so ${ungettable.length === 1 ? 'it' : 'they'} cannot be collected.`);
  }

  const nudged = separate(zones, spacing);
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
      text: sliceLines(b.start_line, b.end_line, skipFor(b)).slice(0, 2000),
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
    resources,
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
