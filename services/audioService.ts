/**
 * audioService.ts
 *
 * Uses HTMLAudioElement for locative zone playback. Zone audio elements are
 * created/unlocked from the player's Begin gesture so later playback is
 * reliable across browsers.
 */

interface NodeData {
  audioEl: HTMLAudioElement;
  sourceNode: MediaElementAudioSourceNode | null;
  gainNode: GainNode | null;
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

function canUseWebAudioGain(url: string) {
  try {
    const audioUrl = new URL(url, window.location.href);
    return audioUrl.origin === window.location.origin || audioUrl.hostname.endsWith('.supabase.co');
  } catch {
    return false;
  }
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
      const audioEl = new Audio();
      const useGainNode = !!this.context && canUseWebAudioGain(url);
      if (useGainNode) audioEl.crossOrigin = 'anonymous';
      audioEl.src = url;
      // preload='none' — stream on demand; avoids any upfront network cost or
      // accidental playback during initialisation.
      audioEl.preload = 'none';

      let sourceNode: MediaElementAudioSourceNode | null = null;
      let gainNode: GainNode | null = null;
      if (this.context && useGainNode) {
        try {
          sourceNode = this.context.createMediaElementSource(audioEl);
          gainNode = this.context.createGain();
          gainNode.gain.value = 0;
          sourceNode.connect(gainNode);
          gainNode.connect(this.context.destination);
        } catch (e) {
          console.warn(`Web Audio gain unavailable for zone ${zoneId}; falling back to media volume:`, e);
          sourceNode = null;
          gainNode = null;
        }
      }

      this.nodes.set(zoneId, { audioEl, sourceNode, gainNode, url, played: false, destroyed: false, playTimer: null });
    } catch (e) {
      console.error(`Failed to set up audio for zone ${zoneId}:`, e);
    }
  }

  private setNodeVolume(nodeData: NodeData, volume: number) {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0));
    nodeData.audioEl.volume = clamped;
    if (nodeData.gainNode) {
      nodeData.gainNode.gain.value = clamped;
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
        this.setNodeVolume(nodeData, 0);
        return;
      }

      // Outside zone — behaviour depends on the zone's on_exit setting.
      const volume = Number(zone.volume);

      if (volume <= 0.01 || !Number.isFinite(volume)) {
        this.setNodeVolume(nodeData, 0);
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
        if (!audioEl.paused) audioEl.pause();
        // A finished element reports paused=true. Always rewinding prevents a
        // later visit from restarting at the end and producing silence.
        try { audioEl.currentTime = 0; } catch { /* metadata may not be ready */ }
        nodeData.played = false;
        return;
      }

      // Inside zone — HTMLAudioElement.volume must be 0–1. Keep it live every
      // tick (attenuation) even while the entry delay is still counting down.
      this.setNodeVolume(nodeData, volume);

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
          this.setNodeVolume(nodeData, 0);
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

  stopAll() {
    this.nodes.forEach((data) => {
      data.audioEl.pause();
      data.audioEl.src = '';
      data.sourceNode?.disconnect();
      data.gainNode?.disconnect();
    });
    this.nodes.clear();
    this.isUnlocked = false;
  }
}

export const audioService = new AudioService();
