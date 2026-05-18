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
  created_at: string;
  lat: number;
  lng: number;

  // Welcome screen customization
  welcome_subtitle?: string;
  welcome_image_url?: string;
  accent_color?: string;   // hex e.g. '#10b981'
  bg_color?: string;       // welcome screen background color
  text_color?: string;     // welcome screen text color
  font_style?: string;     // 'sans' | 'serif' | 'mono'
  map_style?: string;      // key into MAP_STYLES
}

export type ZoneExitBehavior = 'pause' | 'stop' | 'keep';
export type ZoneEndBehavior = 'loop' | 'stop' | 'destroy';
export type ZoneType = 'audio' | 'character';
export type ZoneLockType = 'none' | 'passphrase';

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

  // Audio Zone Props
  media_url: string;
  volume: number; // 0.0 to 1.0
  is_visible: boolean;
  show_progress: boolean;
  use_attenuation: boolean;
  fade_in: number;
  fade_out: number;
  on_exit: ZoneExitBehavior;
  on_end: ZoneEndBehavior;

  // Character Zone Props
  character_prompt?: string;
  greeting_message?: string;        // Custom first line spoken by character; if blank, character auto-greets
  voice_style?: string;             // see VOICES in constants
  character_image_url?: string;     // Square avatar shown in chat header and character card
  character_bio?: string;           // Player-facing story/description shown on the character card
  avatar_unlock_zone_id?: string;   // Zone to auto-unlock when this conversation ends

  // Gating & Sequencing
  entry_message?: string;       // HUD text shown when player enters zone
  lock_type: ZoneLockType;      // Default 'none'
  lock_passphrase?: string;     // Required passphrase to unlock
  lock_hint?: string;           // Optional hint shown to player
  requires_zone_id?: string;    // This zone only activates after the referenced zone is visited
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