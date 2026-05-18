interface NodeData {
  source: AudioBufferSourceNode | null;
  gain: GainNode;
  buffer: AudioBuffer | null;
  url: string;
  /** True after a non-looping audio has played through once in the current visit.
   *  Resets to false when the user exits the zone (volume drops to 0). */
  played: boolean;
  /** True after a 'destroy' zone has played through. Never resets — zone is
   *  silenced for the rest of the session. */
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
    if (!this.context) return;
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
    this.isUnlocked = true;
  }

  async resume() {
    if (this.context && this.context.state === 'suspended') {
      await this.context.resume();
    }
  }

  async loadAudio(zoneId: string, url: string) {
    if (!this.context) return;
    if (this.nodes.has(zoneId)) return; // Already loaded

    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.context.decodeAudioData(arrayBuffer);

      const gainNode = this.context.createGain();
      gainNode.gain.value = 0; // Start silent
      gainNode.connect(this.context.destination);

      this.nodes.set(zoneId, {
        source: null,
        gain: gainNode,
        buffer: audioBuffer,
        url,
        played: false,
        destroyed: false,
      });
    } catch (e) {
      console.error(`Failed to load audio for ${zoneId}`, e);
    }
  }

  updateVolumes(zones: { id: string; volume: number; loop?: boolean; destroyOnEnd?: boolean }[]) {
    if (!this.context || !this.isUnlocked) return;

    const now = this.context.currentTime;

    zones.forEach(zone => {
      const nodeData = this.nodes.get(zone.id);
      if (!nodeData || !nodeData.buffer) return;

      const { gain } = nodeData;

      // Destroyed zone: keep gain at 0 and do nothing else
      if (nodeData.destroyed) {
        gain.gain.setTargetAtTime(0, now, 0.1);
        return;
      }

      // Zone is not active (user outside or inaccessible)
      if (zone.volume <= 0.01) {
        gain.gain.setTargetAtTime(0, now, 0.1);
        // Stop the source if it's still running (user left mid-playback)
        if (nodeData.source) {
          try { nodeData.source.stop(); } catch (_) {}
          nodeData.source = null;
        }
        // Reset played so the zone can play again on next entry
        nodeData.played = false;
        return;
      }

      // Zone is active — set the target volume
      gain.gain.setTargetAtTime(zone.volume, now, 0.1);

      const shouldLoop = zone.loop === true;

      // Only start a new source if one isn't already playing and it hasn't
      // played through yet this visit
      if (!nodeData.source && !nodeData.played) {
        const newSource = this.context!.createBufferSource();
        newSource.buffer = nodeData.buffer;
        newSource.loop = shouldLoop;
        newSource.connect(gain);
        newSource.start(0);

        if (!shouldLoop) {
          // When audio plays through naturally to its end
          newSource.onended = () => {
            if (nodeData.source !== newSource) return; // Stale reference
            nodeData.source = null;
            if (zone.destroyOnEnd) {
              nodeData.destroyed = true;
              gain.gain.setTargetAtTime(0, this.context!.currentTime, 0.3);
            } else {
              // 'stop': mark as played so it doesn't restart while in zone;
              // will reset when user exits
              nodeData.played = true;
            }
          };
        }

        nodeData.source = newSource;
      }
    });
  }

  playBuffer(buffer: AudioBuffer) {
    if (!this.context) return;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.start(0);
  }

  stopAll() {
    this.nodes.forEach((data) => {
      if (data.source) {
        try {
          data.source.stop();
        } catch (_) {}
        data.source.disconnect();
        data.source = null;
      }
    });
  }
}

export const audioService = new AudioService();
