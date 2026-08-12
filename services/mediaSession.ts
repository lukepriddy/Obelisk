/**
 * mediaSession.ts
 *
 * Tells the operating system what is playing, so the iOS lock screen, the
 * Android notification and macOS Now Playing show the truth.
 *
 * Worth knowing what this can and cannot do. iOS creates a Now Playing session
 * from any LOADED audio element, whether or not it is playing, and setting the
 * playback state to 'none' does not retire it — the widget simply falls back to
 * the page title and the site icon. The only thing that removes it is unloading
 * the audio, which audioService.stopAll() does when the player is torn down.
 * Between zones the elements stay loaded on purpose, because that is what makes
 * the first zone reliable and dead spots survivable.
 *
 * So the real choice is not "widget or no widget" — it is "our description or
 * the OS's guess". This module supplies the description.
 *
 * Deliberately does NOT register play/pause action handlers. Registering them
 * changes which controls the OS shows and hands it the ability to drive
 * playback directly, which would cut across the interruption handling in
 * audioService — the part that works on the platform that matters most. This
 * module describes; it never controls.
 */

interface NowPlaying {
  /** The zone, since that is what a player is actually listening to. */
  title: string;
  /** The experience it belongs to. */
  artist: string;
  artwork?: string | null;
  /** Painted behind artwork that has transparency. See flattenArtwork. */
  background?: string | null;
  /** False while audio is paused by an interruption, so the OS shows a paused
   *  transport rather than claiming sound is coming out. */
  playing?: boolean;
}

const ARTWORK_SIZE = 512;
const DEFAULT_BACKGROUND = '#09090b';

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

/** Flattened artwork, keyed by source URL and background. Zones repeat, and
 *  redoing the work on every entry would flash the widget for no reason. */
const flattened = new Map<string, string>();

/**
 * Paint the image onto an opaque square and return it as a data URL.
 *
 * iOS does not honour transparency in media artwork — it composites onto white,
 * so a character portrait with a cut-out background arrives on the lock screen
 * sitting in a white box. Creators upload transparent PNGs constantly and there
 * is no reason they should have to think about this, so it is flattened here
 * against the experience's own background colour.
 *
 * Drawn "cover" rather than stretched: the widget is square and artwork rarely
 * is, and squashing someone's character portrait is worse than cropping it.
 *
 * Returns null on any failure — a cross-origin image that taints the canvas, a
 * load error, a browser without canvas. The caller then falls back to the raw
 * URL, which is exactly today's behaviour.
 */
async function flattenArtwork(url: string, background: string): Promise<string | null> {
  const key = `${url}|${background}`;
  const cached = flattened.get(key);
  if (cached) return cached;

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      // Supabase storage returns access-control-allow-origin: *, so this keeps
      // the canvas untainted and toDataURL usable.
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('artwork load failed'));
      img.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = ARTWORK_SIZE;
    canvas.height = ARTWORK_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = background || DEFAULT_BACKGROUND;
    ctx.fillRect(0, 0, ARTWORK_SIZE, ARTWORK_SIZE);

    const scale = Math.max(ARTWORK_SIZE / image.width, ARTWORK_SIZE / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    ctx.drawImage(image, (ARTWORK_SIZE - w) / 2, (ARTWORK_SIZE - h) / 2, w, h);

    // JPEG, because the point is that there is no transparency left to encode.
    const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    flattened.set(key, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

let currentKey: string | null = null;

function applyMetadata(title: string, artist: string, art: string | null, type: string) {
  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist,
    artwork: art ? [{ src: art, sizes: `${ARTWORK_SIZE}x${ARTWORK_SIZE}`, type }] : [],
  });
}

/**
 * Describe what is playing. Cheap to call repeatedly — it only touches the OS
 * when something actually changed, because the geofencing loop runs often and
 * rewriting metadata every tick makes some platforms flicker the artwork.
 */
export function setNowPlaying(info: NowPlaying) {
  if (!supported()) return;
  const { title, artist, artwork } = info;
  const playing = info.playing !== false;
  const background = info.background || DEFAULT_BACKGROUND;

  const key = [title, artist, artwork ?? '', background, String(playing)].join('|');
  if (key === currentKey) return;
  currentKey = key;

  try {
    // Text first, with no artwork. Flattening needs a decode and a paint, and
    // showing the raw image meanwhile would put the white box on screen for a
    // moment — the exact thing being fixed.
    applyMetadata(title, artist, null, 'image/jpeg');
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  } catch {
    // Metadata is a nicety. Never let it interfere with playback.
    return;
  }

  if (!artwork) return;

  void flattenArtwork(artwork, background).then(flat => {
    // The player may have walked into another zone while that resolved.
    if (currentKey !== key) return;
    try {
      applyMetadata(title, artist, flat ?? artwork, flat ? 'image/jpeg' : artworkType(artwork));
    } catch { /* see above */ }
  });
}

/**
 * Say that nothing is playing.
 *
 * Both halves matter where they work at all: clearing the metadata removes the
 * title, and the state change is what retires the widget on platforms that
 * honour it. On iOS the widget survives until the audio elements are unloaded,
 * which is a property of the platform rather than something to keep fighting.
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
