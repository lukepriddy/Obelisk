/**
 * audioService.ts
 *
 * Uses HTMLAudioElement for zone audio playback — no CORS or fetch required,
 * so any publicly accessible URL works. Volume is controlled directly via
 * audioEl.volume (clamped 0–1). The AudioContext is kept alive solely for
 * TTS playback in ChatInterface (playBuffer / context).
 */

interface NodeData {
  audioEl: HTMLAudioElement;
  url: string;
  /** True after a non-looping audio has played through once this visit.
   *  Resets to false when the user exits the zone. */
  played: boolean;
  /** True after a 'destroy' zone has played through. Never resets. */
  destroyed: boolean;
}

export class AudioService {
  public context: AudioContext | null = null;
  private nodes: Map<string, NodeData> = new Map();
  private isUnlocked = false;

  constructor() {
    const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
    if (AudioContextClass) {
      this.context = new AudioContextClass();
    }
  }

  async init() {
    if (this.context?.state === 'suspended') {
      await this.context.resume();
    }
    this.isUnlocked = true;
  }

  async resume() {
    if (this.context?.state === 'suspended') {
      await this.context.resume();
    }
  }

  /**
   * Call once per zone during startAudio() — which runs inside a user-gesture
   * handler — so that subsequent play() calls from setInterval are allowed by
   * the browser's autoplay policy.
   */
  loadAudio(zoneId: string, url: string) {
    if (!url || this.nodes.has(zoneId)) return;

    try {
      const audioEl = new Audio(url);
      // preload='none' — stream on demand; avoids any upfront network cost or
      // accidental playback during initialisation.
      audioEl.preload = 'none';
      this.nodes.set(zoneId, { audioEl, url, played: false, destroyed: false });
    } catch (e) {
      console.error(`Failed to set up audio for zone ${zoneId}:`, e);
    }
  }

  updateVolumes(zones: { id: string; volume: number; loop?: boolean; destroyOnEnd?: boolean; exitBehavior?: 'stop' | 'pause' | 'keep' }[]) {
    if (!this.isUnlocked) return;

    zones.forEach(zone => {
      const nodeData = this.nodes.get(zone.id);
      if (!nodeData) return;

      const { audioEl } = nodeData;

      // Destroyed zones stay silent for the session.
      if (nodeData.destroyed) {
        audioEl.volume = 0;
        return;
      }

      // Outside zone — behaviour depends on the zone's on_exit setting.
      if (zone.volume <= 0.01) {
        audioEl.volume = 0;
        const exit = zone.exitBehavior ?? 'stop';
        if (exit === 'keep') {
          // Triggered audio plays to completion regardless of zone exit.
          // Leave it running — volume is 0 but the element keeps advancing.
          return;
        }
        if (exit === 'pause') {
          // Pause at current position; resume from here on re-entry.
          if (!audioEl.paused) audioEl.pause();
          nodeData.played = false; // allows .play() on re-entry
          return;
        }
        // 'stop' (default): pause and rewind to start.
        if (!audioEl.paused) {
          audioEl.pause();
          audioEl.currentTime = 0;
        }
        nodeData.played = false;
        return;
      }

      // Inside zone — HTMLAudioElement.volume must be 0–1.
      audioEl.volume = Math.min(1, Math.max(0, zone.volume));

      // Start playback if not already running and not yet played this visit.
      if (!nodeData.played && audioEl.paused) {
        audioEl.loop = zone.loop === true;
        audioEl.play().catch(e => console.warn(`Zone audio play failed (${zone.id}):`, e));

        if (!zone.loop) {
          audioEl.onended = () => {
            if (zone.destroyOnEnd) {
              nodeData.destroyed = true;
              audioEl.volume = 0;
            } else {
              // 'stop': played once per visit, resets when the user exits.
              nodeData.played = true;
            }
          };
        }
      }
    });
  }

  /** Play a decoded AudioBuffer directly — used by ChatInterface for TTS. */
  playBuffer(buffer: AudioBuffer) {
    if (!this.context) return;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.start(0);
  }

  stopAll() {
    this.nodes.forEach((data) => {
      data.audioEl.pause();
      data.audioEl.src = '';
    });
    this.nodes.clear();
    this.isUnlocked = false;
  }
}

export const audioService = new AudioService();
