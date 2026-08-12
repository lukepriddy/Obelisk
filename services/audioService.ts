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
  /** Last observed currentTime, and when it last actually moved — stall detection. */
  lastPos: number;
  lastPosAt: number;
  /** True once the full file is downloaded and playing from a local blob. */
  prefetched: boolean;
  /** Object URL of the fully-downloaded copy (revoked in stopAll). */
  localUrl: string | null;
}

// Audio waits this long after the player enters a zone before starting, so the
// sound feels like an intentional arrival rather than an abrupt jump-cut.
const ENTRY_DELAY_MS = 2000;
const MIN_EDGE_FADE_SECONDS = 0.12;
// Time constant for gain glides. Long enough to remove the click of a step
// change, short enough that attenuation still tracks movement responsively.
const VOLUME_GLIDE_SECONDS = 0.012;

function canUseWebAudioGain(url: string) {
  try {
    const audioUrl = new URL(url, window.location.href);
    return audioUrl.origin === window.location.origin || audioUrl.hostname.endsWith('.supabase.co');
  } catch {
    return false;
  }
}

/**
 * ?audio-keeper=0 turns the silent route keeper off, for A/B testing in the
 * field. On by default. See startRouteKeeper.
 */
const routeKeeperEnabled = (): boolean => {
  try {
    return new URLSearchParams(window.location.search).get('audio-keeper') !== '0';
  } catch {
    return true;
  }
};

export class AudioService {
  public context: AudioContext | null = null;
  private nodes: Map<string, NodeData> = new Map();
  private isUnlocked = false;
  private interruptionPaused = false;
  private keeperSource: AudioBufferSourceNode | null = null;
  private keeperGain: GainNode | null = null;
  private keeperTimeout: number | null = null;

  constructor() {
    const AudioContextClass = (window.AudioContext || (window as any).webkitAudioContext);
    if (AudioContextClass) {
      this.context = new AudioContextClass();
      this.attachContextListeners(this.context);
    }
  }

  /**
   * iOS flips the context to a non-standard 'interrupted' state on Siri,
   * alarms, and declined calls — none of which fire visibilitychange, and
   * media clocks can keep advancing while producing silence. Latch the
   * interruption flag so the player-facing resume UI gets surfaced by the
   * geofencing loop instead of the zone playing inaudibly.
   */
  private attachContextListeners(ctx: AudioContext) {
    ctx.addEventListener?.('statechange', () => {
      if ((ctx.state as string) === 'interrupted') {
        this.interruptionPaused = true;
      }
    });
  }

  isInterruptionPaused() {
    return this.interruptionPaused;
  }

  /**
   * Foreground recovery when nothing audible was interrupted (the common
   * "phone pocketed between zones" case). If the context resumes without a
   * user gesture, clear the latch so the next zone entry can play normally;
   * if it won't, the caller should fall back to the tap-to-resume UI.
   */
  async clearInterruptionIfIdle(): Promise<boolean> {
    if (!this.isUnlocked || !this.interruptionPaused) return true;
    if (this.hasActiveAudio()) return false;
    const running = await this.resumeContext();
    if (running) this.interruptionPaused = false;
    return running;
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
    // Cast via string: iOS reports a non-standard 'interrupted' state that
    // TypeScript's AudioContextState union doesn't know about.
    return (this.context.state as string) === 'running';
  }

  async init() {
    await this.resumeContext();
    this.isUnlocked = true;
    this.interruptionPaused = false;
  }

  /**
   * Holds the audio route open with silence for the duration of prefetch.
   *
   * Bluetooth headphones drop the audio route when nothing is playing and
   * re-engage it when something starts, and that re-engagement is a physical
   * click. On calibration the sequence is: the chime plays (route engages, the
   * chime covers the click), the chime ends, the route idles, and then priming
   * calls play() on every zone to warm it. That last step re-engages the route
   * into silence, with nothing to cover it. Over a speaker there is no route to
   * engage, which is why it is only ever reported on AirPods.
   *
   * Staggering the primes spread those clicks out but could never remove the
   * first one. Keeping the route continuously busy does, because it never
   * disengages in the first place.
   *
   * Scoped to prefetch, not to priming, and not to the whole session. Measured
   * in the browser: priming runs immediately on the Begin tap while the chime
   * is still sounding and covering it, so it never needed help. The exposed
   * work is prefetch, which swaps each zone to its downloaded copy and calls
   * load() on the element. An earlier version started this at unlock and
   * released it when priming ended, which covered neither: it opened four
   * seconds too early and shut before the download began.
   *
   * A silent looping buffer on the existing context, deliberately: it is purely
   * additive. It never touches the zone signal path, the nodes map, the unlock
   * state or the prime routine, so the worst it can do is nothing.
   */
  private startRouteKeeper() {
    if (!this.context || this.keeperSource || !routeKeeperEnabled()) return;
    try {
      const ctx = this.context;
      // One second of zeroes, looped. A buffer rather than an oscillator: an
      // oscillator still runs a generator every frame to produce samples that
      // are then multiplied away, where an empty buffer is already silence.
      const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start();
      this.keeperSource = source;
      this.keeperGain = gain;
      // Backstop. prefetchAll is what normally releases the keeper, but a tour
      // with no prefetchable zones never calls it, and a walk should not spend
      // an hour holding the headphones in their high-power profile because of
      // a path nobody took.
      window.clearTimeout(this.keeperTimeout ?? undefined);
      this.keeperTimeout = window.setTimeout(() => this.stopRouteKeeper(), 90_000);
    } catch (error) {
      // The keeper is an optimisation. Never let it block audio from starting.
      console.warn('Route keeper failed to start:', error);
      this.stopRouteKeeper();
    }
  }

  private stopRouteKeeper() {
    window.clearTimeout(this.keeperTimeout ?? undefined);
    this.keeperTimeout = null;
    try { this.keeperSource?.stop(); } catch { /* already stopped */ }
    try { this.keeperSource?.disconnect(); } catch { /* already detached */ }
    try { this.keeperGain?.disconnect(); } catch { /* already detached */ }
    this.keeperSource = null;
    this.keeperGain = null;
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
    if (newContext) this.attachContextListeners(newContext);
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
      audioEl.src = oldNode.localUrl || oldNode.url;
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
        lastPos: 0,
        lastPosAt: 0,
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
      } else {
        // Prime the zones the player is NOT standing in.
        //
        // Every element above is brand new, and an element only becomes freely
        // playable once a real user gesture has played it — that is the entire
        // reason loadAudio/primeLoadedAudio run from the Begin tap. This
        // rebuild replaced all of them and played only the active one, so every
        // zone still ahead on the walk was left in the state Begin exists to
        // avoid, silently, from one tap on a recovery button.
        //
        // Started here rather than after the awaits below: the gesture that
        // authorises playback is the tap that called this function, and it does
        // not survive an await. Muted, so priming is inaudible; the element is
        // paused and rewound as soon as it starts.
        audioEl.muted = true;
        playAttempts.push(
          audioEl.play()
            .then(() => {
              audioEl.pause();
              try { audioEl.currentTime = 0; } catch { /* not seekable yet */ }
            })
            .catch(() => { /* priming is best effort, exactly as at Begin */ })
            .finally(() => { audioEl.muted = false; }),
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
        lastPos: 0,
        lastPosAt: 0,
        prefetched: false,
        localUrl: null,
      });
      audioEl.load();
    } catch (e) {
      console.error(`Failed to set up audio for zone ${zoneId}:`, e);
    }
  }

  /**
   * Background prefetch: fully download each zone's audio (nearest first,
   * one at a time to be gentle on cellular) and switch the element to the
   * local copy, so zones reached later in the walk play even in cellular
   * dead spots. Never blocks the walk and never touches a track that has
   * started playing — those keep streaming as before.
   */
  async prefetchAll(zoneIds: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
    const targets = zoneIds
      .map(id => this.nodes.get(id))
      .filter((n): n is NodeData => !!n && !n.prefetched && !!n.url);
    const total = targets.length;
    let done = 0;
    onProgress?.(0, total);

    // Open the route just before the work that disturbs it, and only if there
    // is any. This used to start at unlock, which stopped being right once
    // prefetch moved to the "I'm ready" tap: the keeper would have spent the
    // whole calibration holding the route open for nothing, and its 90s
    // backstop could close it before prefetch had even begun.
    if (total > 0) this.startRouteKeeper();

    for (const nodeData of targets) {
      try {
        const res = await fetch(nodeData.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const localUrl = URL.createObjectURL(blob);
        nodeData.prefetched = true;
        nodeData.localUrl = localUrl;
        // Swap only when safe — never yank a track that's playing or has begun.
        const { audioEl } = nodeData;
        if (!nodeData.hasStarted && audioEl.paused && !nodeData.playTimer) {
          audioEl.src = localUrl;
          audioEl.load();
        }
      } catch (error) {
        // CORS-restricted external links or a dead spot mid-download: the zone
        // simply keeps streaming from the network like before.
        console.warn('Audio prefetch failed; zone will stream instead:', error);
      }
      done += 1;
      onProgress?.(done, total);
    }

    // Every src swap that could re-engage the Bluetooth route has now happened,
    // so the route can be allowed to idle again. See startRouteKeeper.
    this.stopRouteKeeper();
  }

  async primeLoadedAudio(): Promise<void> {
    if (!this.isUnlocked) return;

    // Primed one at a time rather than all at once.
    //
    // Each play()/pause() pair activates the audio route. Over a speaker that
    // is silent, but on Bluetooth — AirPods especially — every activation can
    // produce a physical blip, so firing one per zone simultaneously turns a
    // warm-up into a burst of clicks. Spacing them lets the route settle
    // between primes. Nothing else changes: the same elements are primed, in
    // the same way, just not in the same instant.
    const STAGGER_MS = 120;
    const pending = Array.from(this.nodes.entries())
      .filter(([, nodeData]) => !nodeData.destroyed && !nodeData.hasStarted && !nodeData.played);

    const attempts: Promise<void>[] = [];
    pending.forEach(([zoneId, nodeData], index) => {
      const { audioEl } = nodeData;
      const wasMuted = audioEl.muted;
      const previousVolume = audioEl.volume;
      audioEl.muted = true;
      audioEl.volume = 0;
      if (nodeData.gainNode) nodeData.gainNode.gain.value = 0;

      attempts.push(
        new Promise<void>(resolve => window.setTimeout(resolve, index * STAGGER_MS))
          .then(() => {
            // The zone may have been torn down, or genuinely started playing,
            // during the wait — neither should be primed over.
            if (nodeData.destroyed || nodeData.hasStarted) return undefined;
            return audioEl.play();
          })
          .then(() => {
            // On slow networks this promise can resolve AFTER the zone's real
            // playback legitimately started (player begins inside zone 1).
            // Never pause/rewind a track that's now genuinely playing.
            if (nodeData.hasStarted) return;
            audioEl.pause();
            try { audioEl.currentTime = 0; } catch { /* not seekable yet */ }
          })
          .catch(error => {
            console.warn(`Zone audio priming failed (${zoneId}):`, error);
          })
          .finally(() => {
            audioEl.muted = wasMuted;
            if (nodeData.hasStarted) return;
            audioEl.volume = previousVolume;
            this.setNodeVolume(nodeData, 0);
          }),
      );
    });

    // The safety timeout has to outlast the stagger, or it would fire while
    // later zones are still queued and leave them unprimed.
    await Promise.race([
      Promise.all(attempts).then(() => undefined),
      new Promise<void>(resolve =>
        window.setTimeout(resolve, Math.min(5000, 1200 + pending.length * STAGGER_MS))),
    ]);

  }

  /**
   * Sets a node's loudness without clicking.
   *
   * Assigning gain.value directly applies a step change at the next audio
   * frame — if the waveform is mid-swing (it usually is), that discontinuity
   * IS a pop. Gliding to the target over a few milliseconds is inaudible as a
   * transition but removes the discontinuity entirely. This also de-zippers
   * the interval-driven fades, whose 50ms steps were each a separate click.
   *
   * Only one stage applies gain: element.volume is upstream of the graph tap,
   * so setting both it and the gain node multiplied the two (0.8 played at
   * ~0.64). Gain-node zones keep the element at 1 and attenuate in the graph;
   * zones without a gain node (cross-origin links) use element volume.
   */
  private setNodeVolume(nodeData: NodeData, volume: number, options?: { instant?: boolean }) {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : 0));

    if (nodeData.gainNode && this.context) {
      const gain = nodeData.gainNode.gain;
      const now = this.context.currentTime;
      gain.cancelScheduledValues(now);
      if (options?.instant) {
        gain.setValueAtTime(clamped, now);
      } else {
        // Anchor at the true current value so an in-flight ramp can't jump.
        gain.setValueAtTime(gain.value, now);
        gain.setTargetAtTime(clamped, now, VOLUME_GLIDE_SECONDS);
      }
      if (nodeData.audioEl.volume !== 1) nodeData.audioEl.volume = 1;
    } else {
      nodeData.audioEl.volume = clamped;
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

      // Ongoing stall watchdog. The 1200ms health check only covers the moment
      // of starting; a track can also wedge mid-playback (network or decoder
      // hiccup) while still reporting itself as un-paused. "Paused when it
      // should be playing" is already handled below by the re-scheduling
      // branch, so this only has to catch the frozen-clock case.
      if (nodeData.hasStarted && !nodeData.played && !nodeData.destroyed && !audioEl.paused) {
        const now = performance.now();
        if (audioEl.currentTime > nodeData.lastPos + 0.05) {
          nodeData.lastPos = audioEl.currentTime;
          nodeData.lastPosAt = now;
        } else if (nodeData.lastPosAt && now - nodeData.lastPosAt > 3000 && nodeData.healthRecoveries < 3) {
          nodeData.healthRecoveries += 1;
          console.warn(`Zone audio stalled mid-playback; restarting (${zone.id})`);
          nodeData.lastPosAt = now;
          this.cancelFade(nodeData);
          this.setNodeVolume(nodeData, 0);
          audioEl.pause();
          this.beginPlayback(nodeData, zone.id, nodeData.loop, nodeData.destroyOnEnd, nodeData.fadeIn);
          return;
        }
      }

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
    nodeData.lastPos = startPosition;
    nodeData.lastPosAt = performance.now();
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
        nodeData.healthRecoveries >= 3
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
      if (data.localUrl) { try { URL.revokeObjectURL(data.localUrl); } catch { /* already gone */ } }
    });
    this.nodes.clear();
    this.stopRouteKeeper();
    this.isUnlocked = false;
    this.interruptionPaused = false;
  }
}

export const audioService = new AudioService();
