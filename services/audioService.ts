/**
 * audioService.ts
 *
 * Uses HTMLAudioElement for all playback — zone audio and generated character
 * speech. Zone audio elements and the speech element are created/unlocked from
 * the player's Begin gesture so later playback is reliable across browsers.
 */

interface NodeData {
  audioEl: HTMLAudioElement;
  url: string;
  /** True after a non-looping audio has played through once this visit.
   *  Resets to false when the user exits the zone. */
  played: boolean;
  /** True after a 'destroy' zone has played through. Never resets. */
  destroyed: boolean;
  /** Pending 2-second entry delay timer, or null when idle. */
  playTimer: ReturnType<typeof setTimeout> | null;
}

// Audio waits this long after the player enters a zone before starting, so the
// sound feels like an intentional arrival rather than an abrupt jump-cut.
const ENTRY_DELAY_MS = 2000;
const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

interface SpeechCallbacks {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: unknown) => void;
}

export class AudioService {
  public context: AudioContext | null = null;
  private nodes: Map<string, NodeData> = new Map();
  private isUnlocked = false;
  private speechEl: HTMLAudioElement | null = null;
  private speechUrl: string | null = null;

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
    this.ensureSpeechElement();
    this.primeSpeechElement();
    this.isUnlocked = true;
  }

  async resume() {
    if (this.context?.state === 'suspended') {
      await this.context.resume();
    }
  }

  async prepareSpeechPlayback() {
    await this.resume();
    this.ensureSpeechElement();
    this.primeSpeechElement();
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
      this.nodes.set(zoneId, { audioEl, url, played: false, destroyed: false, playTimer: null });
    } catch (e) {
      console.error(`Failed to set up audio for zone ${zoneId}:`, e);
    }
  }

  private ensureSpeechElement(): HTMLAudioElement {
    if (!this.speechEl) {
      const el = new Audio();
      el.preload = 'auto';
      el.playsInline = true;
      el.volume = 1;
      this.speechEl = el;
    }
    return this.speechEl;
  }

  private primeSpeechElement() {
    const el = this.ensureSpeechElement();
    if (!el.paused && el.src === SILENT_WAV) return;
    try {
      el.src = SILENT_WAV;
      el.loop = false;
      el.volume = 0;
      el.play()
        .then(() => {
          el.pause();
          el.volume = 1;
          try { el.currentTime = 0; } catch {}
        })
        .catch(() => {
          el.volume = 1;
        });
    } catch {
      el.volume = 1;
    }
  }

  async playSpeechUrl(url: string, callbacks: SpeechCallbacks = {}): Promise<boolean> {
    if (!url) return false;

    const el = this.ensureSpeechElement();
    const previousUrl = this.speechUrl;

    try {
      el.pause();
      el.loop = false;
      el.volume = 1;
      el.onplaying = () => callbacks.onStart?.();
      el.onended = () => callbacks.onEnd?.();
      el.onerror = () => {
        callbacks.onEnd?.();
        callbacks.onError?.(new Error('Speech audio failed to play'));
      };
      this.speechUrl = url;
      el.src = url;
      try { el.currentTime = 0; } catch {}

      if (previousUrl && previousUrl !== url && previousUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(previousUrl); } catch {}
      }

      await el.play();
      return true;
    } catch (error) {
      callbacks.onEnd?.();
      callbacks.onError?.(error);
      return false;
    }
  }

  stopSpeech() {
    if (!this.speechEl) return;
    this.speechEl.pause();
    this.speechEl.onplaying = null;
    this.speechEl.onended = null;
    this.speechEl.onerror = null;
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
        // Cancel any pending entry delay — the player left before it fired.
        if (nodeData.playTimer) {
          clearTimeout(nodeData.playTimer);
          nodeData.playTimer = null;
        }
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

      // Inside zone — HTMLAudioElement.volume must be 0–1. Keep it live every
      // tick (attenuation) even while the entry delay is still counting down.
      audioEl.volume = Math.min(1, Math.max(0, zone.volume));

      // Schedule playback once per visit, after a short delay, if not already
      // playing or scheduled. The delay makes the audio feel like an arrival.
      if (!nodeData.played && audioEl.paused && !nodeData.playTimer) {
        nodeData.playTimer = setTimeout(() => {
          nodeData.playTimer = null;
          if (nodeData.played || nodeData.destroyed) return;
          this.beginPlayback(nodeData, zone.id, zone.loop === true, zone.destroyOnEnd === true);
        }, ENTRY_DELAY_MS);
      }
    });
  }

  /** Start a node's audio element playing and wire up its end behaviour. */
  private beginPlayback(nodeData: NodeData, zoneId: string, loop: boolean, destroyOnEnd: boolean) {
    const { audioEl } = nodeData;
    audioEl.loop = loop;
    audioEl.play().catch(e => console.warn(`Zone audio play failed (${zoneId}):`, e));
    if (!loop) {
      audioEl.onended = () => {
        if (destroyOnEnd) {
          nodeData.destroyed = true;
          audioEl.volume = 0;
        } else {
          // 'stop': played once per visit; a Replay button can restart it.
          nodeData.played = true;
        }
      };
    }
  }

  /** True when a non-looping 'stop' zone has finished and can be replayed. */
  hasFinished(zoneId: string): boolean {
    const n = this.nodes.get(zoneId);
    return !!n && n.played && !n.destroyed;
  }

  /** Restart a finished zone's audio immediately (no entry delay). */
  replayZone(zoneId: string) {
    const n = this.nodes.get(zoneId);
    if (!n || n.destroyed) return;
    if (n.playTimer) { clearTimeout(n.playTimer); n.playTimer = null; }
    n.played = false;
    try { n.audioEl.currentTime = 0; } catch { /* not seekable yet */ }
    this.beginPlayback(n, zoneId, n.audioEl.loop, false);
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
    this.stopSpeech();
    if (this.speechUrl?.startsWith('blob:')) {
      try { URL.revokeObjectURL(this.speechUrl); } catch {}
    }
    if (this.speechEl) {
      this.speechEl.src = '';
    }
    this.speechUrl = null;
    this.isUnlocked = false;
  }
}

export const audioService = new AudioService();
