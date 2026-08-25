export interface User {
  id: string;
  email: string;
}

export interface Tour {
  id: string;
  owner_id: string;
  title: string;
  description: string;
  is_public: boolean;
  /** May this appear in listings? Access is is_public; this is discoverability.
   *  A DB constraint forbids listed-but-private. */
  is_listed?: boolean;
  created_at: string;
  lat: number;
  lng: number;

  // Publishing review. Written only by the moderation edge functions (a DB
  // trigger rejects client writes), and `is_public` cannot be set true until
  // `moderation_status` is 'approved' — unless the owner is a platform admin.
  moderation_status?: 'unmoderated' | 'approved' | 'rejected' | 'pending_review';
  moderation_reason?: string | null;
  moderation_categories?: string[] | null;
  moderated_at?: string | null;

  // The verdict on the DRAFT, which is a different thing from the verdict on
  // the live version above. Saving never moderates, so a creator can edit a
  // published tour freely; these fields describe the last time they submitted
  // those edits for review. Null once a draft has been approved and promoted.
  //
  // A rejection here never unpublishes anything. That is the whole point: a
  // false positive on an edit must not take down a live experience.
  draft_review_status?: 'rejected' | 'pending_review' | null;
  draft_review_reason?: string | null;
  draft_review_categories?: string[] | null;
  draft_reviewed_at?: string | null;

  /** The approved, immutable version the public is served. Written only by the
   *  review service. Null means nothing has been approved yet. */
  published_snapshot?: TourSnapshot | null;
  published_hash?: string | null;

  // Content fingerprints, maintained by database triggers on tours and zones.
  // `draft_hash !== published_content_hash` is the exact test for "this creator
  // has saved changes that players are not seeing yet". Content only, with no
  // policy version mixed in, so bumping the moderation policy does not make
  // every tour claim to have unpublished changes.
  draft_hash?: string | null;
  published_content_hash?: string | null;

  // Creator's estimate of typical completion time. Planning information, so it
  // has to appear before someone commits — twenty minutes and ninety minutes
  // are different afternoons. Distance and route shape are derived instead
  // (see utils/trail.ts); only this needs a human, because dwell time and
  // walking pace aren't inferable. Null means unset.
  duration_minutes?: number | null;

  // Welcome screen customization
  welcome_subtitle?: string;
  welcome_image_url?: string;
  description_align?: 'center' | 'left';   // alignment of the welcome description text
  accent_color?: string;   // hex e.g. '#10b981'
  bg_color?: string;       // welcome screen background color
  text_color?: string;     // welcome screen text color
  font_style?: string;     // 'sans' | 'serif' | 'mono'
  map_style?: string;      // key into MAP_STYLES
  start_zoom?: number;    // zoom level saved from editor; player starts here

  // Player UI theme — controls chrome colors (bars, cards, sheet)
  // Welcome screen always uses bg_color/text_color regardless of this setting
  player_theme?: 'dark' | 'light';

  // Free-form tags — act as lightweight folders on the dashboard
  tags?: string[];

  /** Playable with a draggable dot instead of GPS, via ?demo=1. Off unless the
   *  creator turns it on, because simulating a walk defeats the point of the
   *  product everywhere except a demo. */
  allow_simulation?: boolean;

  // Optional player progression
  progression_enabled?: boolean;
  progression_resources?: ProgressionResource[];

  // ── Closing card ─────────────────────────────────────────────────────────
  /** Finishing this zone ends the experience. Null means it has no explicit
   *  end, and no closing card is shown. Marked rather than inferred: zones
   *  have no order column, so "the last one" is whichever was created most
   *  recently, which is not the same thing as the last beat. */
  ending_zone_id?: string | null;
  /** Shown on the closing card. The creator's words. */
  closing_message?: string | null;
  /** One line above the donation buttons. */
  donation_note?: string | null;
  donation_links?: DonationLink[];
}

/** One way to support the creator, shown as a button on the closing card. */
export interface DonationLink {
  /** Button text. "PayPal", "Venmo", "Ko-fi". */
  label: string;
  url: string;
  /** Optional image of the QR the payment app generated. Deliberately an
   *  upload rather than a generated code: Venmo and PayPal already hand the
   *  creator a branded one, and players recognise it. */
  qr_url?: string | null;
}

/**
 * A frozen, approved copy of a tour and its zones — what the public is served.
 *
 * Built by `build_tour_snapshot()` in the database, which is the single
 * definition of what an approved version contains. It carries the same fields
 * the live tables do, minus ownership, visibility and moderation columns, so
 * the player can render it exactly as it renders a draft.
 */
export interface TourSnapshot {
  version: number;
  tour: Omit<Tour, 'owner_id' | 'is_public' | 'is_listed' | 'created_at'>;
  zones: Zone[];
}

export type ZoneExitBehavior = 'pause' | 'stop' | 'keep';
export type ZoneEndBehavior = 'loop' | 'stop' | 'destroy';
export type ZoneType = 'audio' | 'character' | 'discoverable';
export type ZoneLockType = 'none' | 'passphrase';
export type ProgressionResourceType = 'currency' | 'item';
export type ARObjectBehavior = 'static' | 'flyover';

export interface ARObjectConfig {
  enabled: boolean;
  asset_url?: string | null;
  asset_type?: 'image' | 'glb';
  behavior: ARObjectBehavior;
  // An object's coordinate is always the zone's, offset by ground_distance_m
  // along ground_bearing_degrees. Absolute anchor fields were declared here and
  // read by the renderer but never written by anything, and reviving them would
  // give the same fact two sources of truth: an absolute anchor would silently
  // stay behind when a creator moved the zone, while the offset travels with it.
  altitude_m: number;
  scale_m: number;
  facing_degrees: number;
  // Static objects can be pushed off the zone centre so the viewer sees them on
  // a slant rather than directly overhead — where azimuth is unstable and the
  // object appears to swivel. Stored as a relative offset (distance + bearing
  // from the zone coordinate) so moving the zone carries the object with it.
  ground_distance_m?: number;
  ground_bearing_degrees?: number;
  // Flyovers travel this many metres along `flight_bearing_degrees` over one
  // loop. The midpoint passes directly over the anchor coordinate.
  flight_bearing_degrees?: number;
  flight_distance_m?: number;
  flight_duration_seconds?: number;
  // Correct the object's position from live GPS during a session. Off unless
  // set, because it trades accurate local tracking for metre-accurate GPS:
  // measured in the field, that is a clear loss for a nearby object (a 3m GPS
  // error is ~11 degrees of apparent movement at 15m) and near-invisible for a
  // distant one (~0.9 degrees at 200m). Only worth enabling for far placements,
  // where accumulated tracking drift can outgrow GPS error.
  converge?: boolean;
}

export interface ProgressionResource {
  id: string;
  name: string;
  type: ProgressionResourceType;
  color: string;
  image_url?: string | null;
  starting_amount: number;
  show_in_hud: boolean;
}

export interface ProgressionReward {
  resource_id: string;
  amount: number;
  amount_max?: number;   // when set and greater than `amount`, the actual grant is a random int in [amount, amount_max]
}

export interface ProgressionRequirement {
  resource_id: string;
  amount: number;
  consume: boolean;
}

export interface PlayerProgress {
  version: 1;
  player_id: string;
  tour_id: string;
  balances: Record<string, number>;
  granted_zone_ids: string[];
  unlocked_zone_ids: string[];
  updated_at: string;
}

export interface Zone {
  id: string;
  tour_id: string;
  lat: number;
  lng: number;
  radius: number; // in meters
  title: string;
  description?: string;

  // Type Discriminator
  type: ZoneType;

  // Media Zone Props
  media_url: string;
  zone_image_url?: string | null;       // Optional square image shown on the media-zone card
  voiceover_script?: string;        // Saved ElevenLabs voiceover script (so it survives a reopen)
  volume: number; // 0.0 to 1.0
  is_visible: boolean;
  show_progress: boolean;
  use_attenuation: boolean;
  fade_in: number;
  fade_out: number;
  on_exit: ZoneExitBehavior;
  on_end: ZoneEndBehavior;

  // Optional camera-based object for this zone. Normal audio, chat, locking,
  // and progression mechanics remain the source of truth for activation.
  ar_config?: ARObjectConfig | null;

  // Character Zone Props
  character_prompt?: string;
  greeting_message?: string;        // Custom first line spoken by character; if blank, character auto-greets
  voice_style?: string;             // see VOICES in constants (the Gemini voice name)
  voice_instructions?: string;      // Free-text accent/delivery prepended to every TTS line for consistency
  voice_enabled?: boolean;          // Reserved for the rebuilt voice mode. Public player chat is text-only for now. Default false.
  character_image_url?: string;     // Square avatar shown in chat header and character card
  character_bio?: string;           // Player-facing story/description shown on the character card
  avatar_unlock_zone_id?: string | null;   // Zone to auto-unlock when this conversation ends

  // Gating & Sequencing
  entry_message?: string;       // HUD text shown when player enters zone
  lock_type: ZoneLockType;      // Default 'none'
  lock_passphrase?: string;     // Required passphrase to unlock
  lock_hint?: string;           // Optional hint shown to player
  requires_zone_id?: string | null;    // This zone only activates after the referenced zone is visited
  progression_rewards?: ProgressionReward[];
  progression_requirements?: ProgressionRequirement[];

  // Discoverable Zone Props — a small collectible; grants progression_rewards on pickup
  is_mystery?: boolean;            // hide zone_image_url (show a generic glyph) until collected
  collect_radius?: number | null;  // inner pickup threshold in meters; falls back to `radius` when unset
}

export interface AudioState {
  isPlaying: boolean;
  volume: number;
  activeZoneId: string | null;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export interface TourAnalytics {
  tour_id: string;
  total_plays: number;
  last_played: string | null;            // ISO timestamp of most recent session
  avg_duration_seconds: number | null;   // null when no completed sessions exist
  zone_visits: { zone_id: string; visit_count: number }[]; // sorted desc by count
}
