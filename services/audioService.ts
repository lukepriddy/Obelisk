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
  /** Active volume fade timer, or null when volume is stable. */
  fadeTimer: ReturnType<typeof setInterval> | null;
  /** Short self-check after start, used to recover when play() resolves but time never advances. */
  healthTimer: ReturnType<typeof setTimeout> | null;
  currentVolume: number;
  desiredVolume: number;
  isInside: boolean;
  exitBehavior: 'stop' | 'pause' | 'keep';
  hasStarted: boolean;
  loop: boolean;
  destroyOnEnd: boolean;
  fadeIn: number;
  healthRecoveries: number;
}

// Audio waits this long after the player enters a zone before starting, so the
// sound feels like an intentional arrival rather than an abrupt jump-cut.
const ENTRY_DELAY_MS = 2000;
const MIN_EDGE_FADE_SECONDS = 0.12;

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
  private interruptionPaused = false;

  constructor() {
    const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
    if (AudioContextClass) {
      this.context = new AudioContextClass();
    }
  }

  private async resumeContext() {
    if (!this.context || this.context.state === 'running') return true;
    if (this.context.state === 'closed') return false;
    try {
      await Promise.race([
        this.context.resume(),
        new Promise<void>(resolve => window.setTimeout(resolve, 1200)),
      ]);
    } catch (error) {
      console.warn('Audio context resume failed:', error);
    }
    return this.context.state === 'running';
  }

  async init() {
    await this.resumeContext();
    this.isUnlocked = true;
    this.interruptionPaused = false;
  }

  async resume() {
    await this.resumeContext();
  }

  prepareForInterruption() {
    this.interruptionPaused = true;
    this.nodes.forEach(nodeData => {
      if (!nodeData.hasStarted || nodeData.destroyed || nodeData.played) return;
      this.cancelFade(nodeData);
      // This must be synchronous: iOS may suspend JavaScript immediately after
      // visibilitychange/pagehide. Mute before pause to avoid an output click.
      if (nodeData.gainNode && this.context) {
        const now = this.context.currentTime;
        nodeData.gainNode.gain.cancelScheduledValues(now);
        nodeData.gainNode.gain.setValueAtTime(0, now);
      }
      nodeData.audioEl.volume = 0;
      nodeData.currentVolume = 0;
      nodeData.audioEl.pause();
    });
  }

  /**
   * Restore playback after iOS interrupts the page audio session when Safari
   * is backgrounded or the device is locked. Playback position is preserved.
   */
  async recoverFromInterruption(): Promise<boolean> {
    if (!this.isUnlocked) return true;
    const recoveryTargets = new Map<NodeData, number>();
    this.nodes.forEach(nodeData => {
      const shouldAdvance =
        nodeData.isInside ||
        (nodeData.exitBehavior === 'keep' && nodeData.audioEl.currentTime > 0);
      if (!shouldAdvance || !nodeData.hasStarted || nodeData.destroyed || nodeData.played) return;
      recoveryTargets.set(nodeData, nodeData.isInside ? nodeData.desiredVolume : 0);
      this.cancelFade(nodeData);
      this.setNodeVolume(nodeData, 0);
    });

    const contextRunning = await this.resumeContext();

    const recoveries: Promise<void>[] = [];
    const playbackChecks: { nodeData: NodeData; startTime: number }[] = [];
    this.nodes.forEach((nodeData, zoneId) => {
      const { audioEl } = nodeData;
      const shouldAdvance =
        nodeData.isInside ||
        (nodeData.exitBehavior === 'keep' && audioEl.currentTime > 0);
      if (shouldAdvance && nodeData.hasStarted && nodeData.playTimer) {
        clearTimeout(nodeData.playTimer);
        nodeData.playTimer = null;
      }
      if (
        shouldAdvance &&
        nodeData.hasStarted &&
        !nodeData.destroyed &&
        !nodeData.played &&
        !audioEl.ended
      ) {
        playbackChecks.push({ nodeData, startTime: audioEl.currentTime });
      }
      if (
        !shouldAdvance ||
        nodeData.destroyed ||
        nodeData.played ||
        nodeData.playTimer ||
        !nodeData.hasStarted ||
        audioEl.ended ||
        !audioEl.paused
      ) return;

      recoveries.push(
        audioEl.play()
          .then(() => {})
          .catch(error => {
            console.warn(`Zone audio recovery failed (${zoneId}):`, error);
          }),
      );
    });

    await Promise.all(recoveries);
    recoveryTargets.forEach((target, nodeData) => {
      this.fadeTo(nodeData, target, 0.25);
    });
    if (!contextRunning) return false;
    if (playbackChecks.length === 0) return true;

    await new Promise<void>(resolve => window.setTimeout(resolve, 450));
    return playbackChecks.every(({ nodeData, startTime }) =>
      !nodeData.audioEl.paused &&
      nodeData.audioEl.currentTime > startTime + 0.03
    );
  }

  /**
   * User-gesture fallback for iOS. Restart active zone audio from the beginning
   * so the player never returns halfway through a clip after unlocking.
   */
  async restartActiveAudioFromBeginning(): Promise<boolean> {
    if (!this.isUnlocked) return false;
    this.interruptionPaused = false;

    const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
    const oldContext = this.context;
    let newContext: AudioContext | null = null;
    try {
      newContext = AudioContextClass ? new AudioContextClass() : null;
    } catch (error) {
      console.warn('Could not create replacement audio context:', error);
    }
    this.context = newContext;

    // Rebuild every media element and connection. iOS can leave the old graph
    // reporting "running" while producing silence after a lock-screen interruption.
    const rebuiltNodes = new Map<string, NodeData>();
    const playAttempts: Promise<void>[] = [];
    let activeCount = 0;

    this.nodes.forEach((oldNode, zoneId) => {
      if (oldNode.playTimer) clearTimeout(oldNode.playTimer);
      this.cancelFade(oldNode);
      this.cancelHealthCheck(oldNode);
      this.setNodeVolume(oldNode, 0);
      oldNode.audioEl.pause();
      oldNode.sourceNode?.disconnect();
      oldNode.gainNode?.disconnect();

      const audioEl = new Audio();
      const useGainNode = !!newContext && canUseWebAudioGain(oldNode.url);
      if (useGainNode) audioEl.crossOrigin = 'anonymous';
      audioEl.src = oldNode.url;
      audioEl.preload = 'auto';
      audioEl.loop = oldNode.loop;

      let sourceNode: MediaElementAudioSourceNode | null = null;
      let gainNode: GainNode | null = null;
      if (newContext && useGainNode) {
        try {
          sourceNode = newContext.createMediaElementSource(audioEl);
          gainNode = newContext.createGain();
          sourceNode.connect(gainNode);
          gainNode.connect(newContext.destination);
        } catch (error) {
          console.warn(`Rebuilt Web Audio connection failed (${zoneId}):`, error);
        }
      }

      const shouldRestart =
        oldNode.isInside &&
        !oldNode.destroyed &&
        !oldNode.played &&
        !oldNode.audioEl.ended;
      const rebuilt: NodeData = {
        ...oldNode,
        audioEl,
        sourceNode,
        gainNode,
        playTimer: null,
        fadeTimer: null,
        healthTimer: null,
        currentVolume: 0,
        hasStarted: shouldRestart,
        played: shouldRestart ? false : oldNode.played,
        healthRecoveries: 0,
      };
      this.setNodeVolume(rebuilt, 0);
      this.attachEndBehavior(rebuilt);
      rebuiltNodes.set(zoneId, rebuilt);

      if (shouldRestart) {
        activeCount += 1;
        try { audioEl.currentTime = 0; } catch { /* metadata may not be ready */ }
        playAttempts.push(
          audioEl.play().catch(error => {
            console.warn(`Tapped zone audio restart failed (${zoneId}):`, error);
          }),
        );
      }
    });

    this.nodes = rebuiltNodes;
    void oldContext?.close().catch(() => {});
    const contextResume = newContext
      ? newContext.resume().catch(error => {
          console.warn('Rebuilt audio context resume failed:', error);
        })
      : Promise.resolve();
    await Promise.all([contextResume, ...playAttempts]);
    rebuiltNodes.forEach(nodeData => {
      if (nodeData.isInside && nodeData.hasStarted) {
        this.fadeTo(nodeData, nodeData.desiredVolume, 0.25);
      }
    });
    if (newContext && newContext.state !== 'running') {
      this.interruptionPaused = true;
      return false;
    }
    if (activeCount === 0) return true;

    await new Promise<void>(resolve => window.setTimeout(resolve, 350));
    const recovered = [...rebuiltNodes.values()].filter(nodeData => nodeData.isInside && nodeData.hasStarted).every(nodeData =>
      !nodeData.audioEl.paused && nodeData.audioEl.currentTime > 0.03
    );
    this.interruptionPaused = !recovered;
    return recovered;
  }

  hasActiveAudio() {
    return [...this.nodes.values()].some(nodeData =>
      nodeData.isInside &&
      nodeData.hasStarted &&
      !nodeData.destroyed &&
      !nodeData.played &&
      !nodeData.audioEl.ended
    );
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
      // Preload plus muted priming during Begin makes the first zone less
      // vulnerable to browser autoplay and headphone-route timing quirks.
      audioEl.preload = 'auto';

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

      this.nodes.set(zoneId, {
        audioEl,
        sourceNode,
        gainNode,
        url,
        played: false,
        destroyed: false,
        playTimer: null,
        fadeTimer: null,
        healthTimer: null,
        currentVolume: 0,
        desiredVolume: 0,
        isInside: false,
        exitBehavior: 'stop',
        hasStarted: false,
        loop: false,
        destroyOnEnd: false,
        fadeIn: 0,
        healthRecoveries: 0,
      });
      audioEl.load();
    } catch (e) {
      console.error(`Failed to set up audio for zone ${zoneId}:`, e);
    }
  }

  async primeLoadedAudio(): Promise<void> {
    if (!this.isUnlocked) return;

    const attempts: Promise<void>[] = [];
    this.nodes.forEach((nodeData, zoneId) => {
      if (nodeData.destroyed || nodeData.hasStarted || nodeData.played) return;
      const { audioEl } = nodeData;
      const wasMuted = audioEl.muted;
      const previousVolume = audioEl.volume;
      audioEl.muted = true;
      audioEl.volume = 0;
      if (nodeData.gainNode) nodeData.gainNode.gain.value = 0;

      attempts.push(
        audioEl.play()
          .then(() => {
            audioEl.pause();
            try { audioEl.currentTime = 0; } catch { /* not seekable yet */ }
          })
          .catch(error => {
            console.warn(`Zone audio priming failed (${zoneId}):`, error);
          })
          .finally(() => {
            audioEl.muted = wasMuted;
            audioEl.volume = previousVolume;
            this.setNodeVolume(nodeData, 0);
          }),
      );
    });

    await Promise.race([
      Promise.all(attempts).then(() => undefined),
      new Promise<void>(resolve => window.setTimeout(resolve, 1200)),
    ]);
  }

  private setNodeVolume(nodeData: NodeData, volume: number) {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0));
    nodeData.audioEl.volume = clamped;
    if (nodeData.gainNode) {
      nodeData.gainNode.gain.value = clamped;
    }
    nodeData.currentVolume = clamped;
  }

  private cancelFade(nodeData: NodeData) {
    if (!nodeData.fadeTimer) return;
    clearInterval(nodeData.fadeTimer);
    nodeData.fadeTimer = null;
  }

  private cancelHealthCheck(nodeData: NodeData) {
    if (!nodeData.healthTimer) return;
    clearTimeout(nodeData.healthTimer);
    nodeData.healthTimer = null;
  }

  private fadeTo(
    nodeData: NodeData,
    target: number,
    durationSeconds: number,
    onComplete?: () => void,
  ) {
    this.cancelFade(nodeData);
    const clampedTarget = Math.min(1, Math.max(0, target));
    const durationMs = Math.max(0, durationSeconds) * 1000;
    if (durationMs === 0 || Math.abs(nodeData.currentVolume - clampedTarget) < 0.005) {
      this.setNodeVolume(nodeData, clampedTarget);
      onComplete?.();
      return;
    }

    const startVolume = nodeData.currentVolume;
    const startedAt = performance.now();
    nodeData.fadeTimer = setInterval(() => {
      const progress = Math.min(1, (performance.now() - startedAt) / durationMs);
      this.setNodeVolume(
        nodeData,
        startVolume + (clampedTarget - startVolume) * progress,
      );
      if (progress >= 1) {
        this.cancelFade(nodeData);
        onComplete?.();
      }
    }, 50);
  }

  private finishExit(nodeData: NodeData, exitBehavior: 'stop' | 'pause' | 'keep') {
    if (nodeData.isInside) return;
    const { audioEl } = nodeData;
    if (exitBehavior === 'keep') return;
    if (!audioEl.paused) audioEl.pause();
    if (exitBehavior === 'stop') {
      try { audioEl.currentTime = 0; } catch { /* metadata may not be ready */ }
      nodeData.hasStarted = false;
    }
    nodeData.played = false;
  }

  updateVolumes(zones: {
    id: string;
    volume: number;
    loop?: boolean;
    destroyOnEnd?: boolean;
    exitBehavior?: 'stop' | 'pause' | 'keep';
    fadeIn?: number;
    fadeOut?: number;
  }[]) {
    if (!this.isUnlocked) return;

    zones.forEach(zone => {
      const nodeData = this.nodes.get(zone.id);
      if (!nodeData) return;

      const { audioEl } = nodeData;
      nodeData.exitBehavior = zone.exitBehavior ?? 'stop';
      nodeData.loop = zone.loop === true;
      nodeData.destroyOnEnd = zone.destroyOnEnd === true;
      nodeData.fadeIn = Number(zone.fadeIn) || 0;

      // Destroyed zones stay silent for the session.
      if (nodeData.destroyed) {
        this.setNodeVolume(nodeData, 0);
        return;
      }

      // Outside zone — behaviour depends on the zone's on_exit setting.
      const volume = Number(zone.volume);

      if (volume <= 0.01 || !Number.isFinite(volume)) {
        const justExited = nodeData.isInside;
        nodeData.isInside = false;
        nodeData.desiredVolume = 0;
        nodeData.healthRecoveries = 0;
        this.cancelHealthCheck(nodeData);
        // Cancel any pending entry delay — the player left before it fired.
        if (nodeData.playTimer) {
          clearTimeout(nodeData.playTimer);
          nodeData.playTimer = null;
        }
        const exit = nodeData.exitBehavior;
        if (justExited) {
          this.fadeTo(nodeData, 0, Math.max(Number(zone.fadeOut) || 0, MIN_EDGE_FADE_SECONDS), () => {
            this.finishExit(nodeData, exit);
          });
        } else if (!nodeData.fadeTimer && nodeData.currentVolume > 0) {
          this.setNodeVolume(nodeData, 0);
          this.finishExit(nodeData, exit);
        }
        return;
      }

      const justEntered = !nodeData.isInside;
      nodeData.isInside = true;
      nodeData.desiredVolume = volume;
      if (this.interruptionPaused) return;

      // A keep-playing track may still be advancing silently outside the zone.
      // Fade it back up immediately when the player returns.
      if (!audioEl.paused && justEntered) {
        this.fadeTo(nodeData, volume, Math.max(Number(zone.fadeIn) || 0, MIN_EDGE_FADE_SECONDS));
      } else if (!audioEl.paused && !nodeData.fadeTimer) {
        // Keep attenuation responsive while the player moves inside the zone.
        this.setNodeVolume(nodeData, volume);
      }

      // Schedule playback once per visit, after a short delay, if not already
      // playing or scheduled. The delay makes the audio feel like an arrival.
      if (!nodeData.played && audioEl.paused && !nodeData.playTimer) {
        nodeData.playTimer = setTimeout(() => {
          nodeData.playTimer = null;
          if (nodeData.played || nodeData.destroyed || !nodeData.isInside) return;
          this.beginPlayback(
            nodeData,
            zone.id,
            zone.loop === true,
            zone.destroyOnEnd === true,
            Math.max(Number(zone.fadeIn) || 0, MIN_EDGE_FADE_SECONDS),
          );
        }, ENTRY_DELAY_MS);
      }
    });
  }

  /** Start a node's audio element playing and wire up its end behaviour. */
  private beginPlayback(
    nodeData: NodeData,
    zoneId: string,
    loop: boolean,
    destroyOnEnd: boolean,
    fadeIn = 0,
  ) {
    const { audioEl } = nodeData;
    audioEl.loop = loop;
    nodeData.hasStarted = true;
    nodeData.loop = loop;
    nodeData.destroyOnEnd = destroyOnEnd;
    nodeData.fadeIn = Math.max(fadeIn, MIN_EDGE_FADE_SECONDS);
    audioEl.muted = false;
    this.setNodeVolume(nodeData, 0);
    const startPosition = audioEl.currentTime || 0;
    audioEl.play().catch(e => {
      console.warn(`Zone audio play failed (${zoneId}):`, e);
      nodeData.hasStarted = false;
      nodeData.playTimer = null;
      this.setNodeVolume(nodeData, 0);
    });
    this.fadeTo(nodeData, nodeData.desiredVolume, nodeData.fadeIn);
    this.schedulePlaybackHealthCheck(nodeData, zoneId, startPosition);
    this.attachEndBehavior(nodeData);
  }

  private schedulePlaybackHealthCheck(nodeData: NodeData, zoneId: string, startPosition: number) {
    this.cancelHealthCheck(nodeData);
    nodeData.healthTimer = setTimeout(() => {
      nodeData.healthTimer = null;
      if (
        !nodeData.isInside ||
        nodeData.destroyed ||
        nodeData.played ||
        !nodeData.hasStarted ||
        nodeData.healthRecoveries >= 1
      ) return;

      const currentPosition = nodeData.audioEl.currentTime || 0;
      const playbackAdvanced = !nodeData.audioEl.paused && currentPosition > startPosition + 0.08;
      if (playbackAdvanced) return;

      nodeData.healthRecoveries += 1;
      console.warn(`Zone audio did not advance after start; retrying (${zoneId})`);
      this.cancelFade(nodeData);
      this.setNodeVolume(nodeData, 0);
      nodeData.audioEl.pause();
      try { nodeData.audioEl.currentTime = 0; } catch { /* not seekable yet */ }
      this.beginPlayback(
        nodeData,
        zoneId,
        nodeData.loop,
        nodeData.destroyOnEnd,
        Math.max(nodeData.fadeIn, MIN_EDGE_FADE_SECONDS),
      );
    }, 1200);
  }

  private attachEndBehavior(nodeData: NodeData) {
    const { audioEl } = nodeData;
    audioEl.loop = nodeData.loop;
    if (!nodeData.loop) {
      audioEl.onended = () => {
        if (nodeData.destroyOnEnd) {
          nodeData.destroyed = true;
          this.setNodeVolume(nodeData, 0);
        } else {
          // 'stop': played once per visit; a Replay button can restart it.
          nodeData.played = true;
        }
      };
    } else {
      audioEl.onended = null;
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
    this.cancelHealthCheck(n);
    n.played = false;
    n.healthRecoveries = 0;
    try { n.audioEl.currentTime = 0; } catch { /* not seekable yet */ }
    this.beginPlayback(n, zoneId, n.audioEl.loop, false);
  }

  stopAll() {
    this.nodes.forEach((data) => {
      if (data.playTimer) clearTimeout(data.playTimer);
      this.cancelFade(data);
      this.cancelHealthCheck(data);
      data.audioEl.pause();
      data.audioEl.src = '';
      data.sourceNode?.disconnect();
      data.gainNode?.disconnect();
    });
    this.nodes.clear();
    this.isUnlocked = false;
    this.interruptionPaused = false;
  }
}

export const audioService = new AudioService();
