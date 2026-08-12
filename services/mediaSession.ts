/**
 * mediaSession.ts
 *
 * Tells the operating system what is playing, so the iOS lock screen, the
 * Android notification and macOS Now Playing show the truth.
 *
 * Nothing used this API before, and the gap was visible: priming plays and
 * immediately pauses every zone's audio during Begin — the trick that makes the
 * first zone reliable — which is enough for iOS to register a media session.
 * With nothing ever saying "playback finished", the lock screen kept offering
 * the tour, paused at 0:00, hours later and miles from any zone.
 *
 * Deliberately does NOT register play/pause action handlers. Registering them
 * changes which controls the OS shows and hands it the ability to drive
 * playback directly, which would cut across the interruption handling in
 * audioService — the part that currently works on the platform that matters
 * most. This module only ever describes; it never controls.
 */

interface NowPlaying {
  /** The zone, since that is what a player is actually listening to. */
  title: string;
  /** The experience it belongs to. */
  artist: string;
  artwork?: string | null;
  /** False while audio is paused by an interruption, so the OS shows a paused
   *  transport rather than claiming sound is coming out. */
  playing?: boolean;
}

const supported = () =>
  typeof navigator !== 'undefined' && 'mediaSession' in navigator;

/** Guess the MIME type from the extension. The OS is lenient, but an empty
 *  type makes some versions skip the image entirely. */
function artworkType(url: string): string {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

let currentKey: string | null = null;

/**
 * Describe what is playing. Cheap to call repeatedly — it only touches the OS
 * when something actually changed, because the geofencing loop runs often and
 * rewriting metadata every tick makes some platforms flicker the artwork.
 */
export function setNowPlaying(info: NowPlaying) {
  if (!supported()) return;
  const { title, artist, artwork } = info;
  const playing = info.playing !== false;

  const key = [title, artist, artwork ?? '', String(playing)].join('|');
  if (key === currentKey) return;
  currentKey = key;

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      artwork: artwork
        ? [{ src: artwork, sizes: '512x512', type: artworkType(artwork) }]
        : [],
    });
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  } catch {
    // Metadata is a nicety. Never let it interfere with playback.
  }
}

/**
 * Say that nothing is playing.
 *
 * Both halves matter: clearing the metadata removes the title, and setting the
 * state to 'none' is what actually retires the widget. Doing only the first
 * leaves an empty player sitting on the lock screen, which is worse than the
 * problem it was meant to fix.
 */
export function clearNowPlaying() {
  if (!supported()) return;
  if (currentKey === null) return;
  currentKey = null;

  try {
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.playbackState = 'none';
  } catch {
    /* see above */
  }
}
