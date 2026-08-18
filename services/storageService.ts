/**
 * storageService.ts
 * Uploads files to Supabase Storage and returns permanent public URLs.
 *
 * Requires these public buckets to exist in your Supabase project:
 *   • "audio"  — for zone audio files
 *   • "images" — for tour cover photos and character avatars
 *   • "models" — for AR GLB objects
 *
 * Every upload passes three guards before it touches storage:
 *   1. file type — an allowlist, so a renamed .exe can't ride in
 *   2. file size — a per-file ceiling
 *   3. account quota — total bytes already stored by this creator
 *
 * The guards live here rather than in the components so every call site gets
 * them; they used to be duplicated (and inconsistent) across TourInfoPanel and
 * ZoneForm, which meant new upload paths silently had none.
 *
 * Successful uploads are recorded in the `uploads` ledger, which is what the
 * account quota sums. A determined caller could hit the Storage API directly
 * and skip the ledger; closing that needs a trigger on storage.objects and is
 * tracked as a follow-up.
 */

import { supabase } from './supabaseClient';

const MB = 1024 * 1024;

export const MAX_IMAGE_BYTES = 10 * MB;
export const MAX_AUDIO_BYTES = 50 * MB;
export const MAX_MODEL_BYTES = 25 * MB;

const IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const AUDIO_TYPES = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm'];

type Kind = 'image' | 'audio' | 'model';

const prettyBytes = (n: number) =>
  n >= 1024 * MB ? `${(n / 1024 / MB).toFixed(1)} GB`
  : n >= MB ? `${Math.round(n / MB)} MB`
  : `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * Validate a file's type and size. Returns an error message, or null if it's
 * acceptable. Exported so callers can check before showing an upload spinner.
 */
export function validateFile(file: File, kind: Kind): string | null {
  const name = file.name.toLowerCase();

  if (kind === 'image') {
    // HEIC deserves its own message: it's the iPhone default and the fix
    // isn't obvious.
    if (name.endsWith('.heic') || name.endsWith('.heif') ||
        file.type === 'image/heic' || file.type === 'image/heif') {
      return 'iPhone HEIC photos aren\'t supported. In Photos, tap Share → Options → "Most Compatible" to export as JPEG.';
    }
    if (file.type && !IMAGE_TYPES.includes(file.type)) {
      return 'That file isn\'t an image. Use a JPEG, PNG, WebP, or GIF.';
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return `Image too large (${prettyBytes(file.size)}). The limit is ${prettyBytes(MAX_IMAGE_BYTES)}.`;
    }
  }

  if (kind === 'audio') {
    if (file.type && !AUDIO_TYPES.includes(file.type)) {
      return 'That file isn\'t audio. Use an MP3, WAV, M4A, or OGG.';
    }
    if (file.size > MAX_AUDIO_BYTES) {
      return `Audio too large (${prettyBytes(file.size)}). The limit is ${prettyBytes(MAX_AUDIO_BYTES)}.`;
    }
  }

  if (kind === 'model') {
    if (!name.endsWith('.glb')) return 'AR objects must be a .glb file.';
    if (file.size > MAX_MODEL_BYTES) {
      return `Model too large (${prettyBytes(file.size)}). The limit is ${prettyBytes(MAX_MODEL_BYTES)}.`;
    }
  }

  if (file.size === 0) return 'That file is empty.';
  return null;
}

/** Current account storage usage, or null if it can't be determined. */
export async function getStorageQuota(): Promise<{ used: number; limit: number } | null> {
  const { data, error } = await supabase.rpc('my_storage_quota');
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return null;
  return { used: Number(row.used_bytes ?? 0), limit: Number(row.limit_bytes ?? 0) };
}

/**
 * Refuse the upload if it would put the account over its storage limit.
 * A failure to READ the quota is not treated as a failure to pass it — an
 * unrelated outage shouldn't block a creator from working.
 */
async function quotaError(size: number): Promise<string | null> {
  const quota = await getStorageQuota();
  if (!quota || !quota.limit) return null;
  if (quota.used + size <= quota.limit) return null;
  return `This would exceed your ${prettyBytes(quota.limit)} storage limit (${prettyBytes(quota.used)} used). Delete some files or upgrade your plan.`;
}

/** Record a stored file so it counts toward the account's quota. */
async function recordUpload(
  bucket: string, path: string, file: File, tourId: string | null,
) {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) return;
  const { error } = await supabase.from('uploads').insert({
    user_id: userId,
    tour_id: tourId,
    bucket,
    path,
    size_bytes: file.size,
    mime_type: file.type || null,
  });
  // A missing ledger row under-counts usage; it must not fail the upload the
  // creator just completed successfully.
  if (error) console.error('recordUpload:', error.message);
}

interface UploadOptions {
  /** Receives a specific, user-facing reason when an upload is refused. */
  onError?: (message: string) => void;
  /** Longest edge to keep, in pixels. See downscaleImage. */
  maxEdge?: number;
}

/**
 * Default longest edge for uploaded images, in pixels.
 *
 * Sized for the largest place an image is actually shown — a welcome screen or
 * character portrait on a high-DPI phone — with headroom. Measured before
 * choosing it: 62 stored images averaged 1.7MB and reached 5.9MB, 101MB in
 * total across twelve tours, all displayed at a few hundred pixels or less.
 */
const DEFAULT_MAX_EDGE = 1600;

/** Icons are rendered at 20-44px. A 2.4MB PNG for a 20px chip is why the HUD
 *  icon appeared not to load: it had not finished downloading. */
export const ICON_MAX_EDGE = 256;

/** Below this, resizing is not worth the quality loss of a re-encode. */
const RESIZE_FLOOR_BYTES = 150 * 1024;

let webpSupport: boolean | null = null;
function supportsWebp(): boolean {
  if (webpSupport !== null) return webpSupport;
  try {
    const probe = document.createElement('canvas');
    probe.width = probe.height = 1;
    webpSupport = probe.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    webpSupport = false;
  }
  return webpSupport;
}

/**
 * Shrink an image in the browser before it is uploaded.
 *
 * Supabase can resize on delivery, but that is a paid feature and it is off for
 * this project — the render endpoint answers 403 FeatureNotEnabled — so the
 * only place this can happen is here, once, at upload.
 *
 * WebP because it keeps transparency, which matters: character portraits and
 * resource icons are routinely cut-out PNGs, and re-encoding those to JPEG
 * would put them on a white box. Falls back to the original file whenever it
 * cannot do better — an unsupported format, a decode failure, an already-small
 * file, or a result that came out larger than what it started with.
 *
 * Animated GIFs are passed through untouched. A canvas only ever sees the first
 * frame, so "optimising" one would silently throw the animation away.
 */
async function downscaleImage(file: File, maxEdge: number): Promise<File> {
  if (file.type === 'image/gif') return file;
  if (!supportsWebp()) return file;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, maxEdge / Math.max(width, height));

    // Already small in both senses: leave it exactly as the creator made it.
    if (scale === 1 && file.size <= RESIZE_FLOOR_BYTES) return file;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>(resolve =>
      canvas.toBlob(resolve, 'image/webp', 0.85),
    );
    if (!blob || blob.size >= file.size) return file;

    const base = file.name.replace(/\.[^.]+$/, '') || 'image';
    return new File([blob], `${base}.webp`, { type: 'image/webp' });
  } catch {
    // HEIC and anything else the browser will not decode lands here. The
    // original is returned and validateFile gives the creator the real reason.
    return file;
  } finally {
    bitmap?.close?.();
  }
}

async function upload(
  bucket: string, path: string, file: File, kind: Kind,
  tourId: string | null, opts?: UploadOptions,
): Promise<string | null> {
  const fail = (msg: string) => { opts?.onError?.(msg); return null; };

  const invalid = validateFile(file, kind);
  if (invalid) return fail(invalid);

  const overQuota = await quotaError(file.size);
  if (overQuota) return fail(overQuota);

  const { error } = await supabase.storage.from(bucket).upload(path, file, { upsert: false });
  if (error) {
    console.error(`${bucket} upload failed:`, error.message);
    return fail('Upload failed. Check your connection and try again.');
  }

  await recordUpload(bucket, path, file, tourId);
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

const extOf = (file: File, fallback: string) =>
  file.name.includes('.') ? (file.name.split('.').pop() || fallback) : fallback;

/**
 * Upload an audio file to the "audio" bucket.
 * Files are stored under <tourId>/<timestamp>.<ext>
 */
export async function uploadAudio(
  file: File, tourId: string, opts?: UploadOptions,
): Promise<string | null> {
  const path = `${tourId}/${Date.now()}.${extOf(file, 'mp3')}`;
  return upload('audio', path, file, 'audio', tourId, opts);
}

/**
 * Upload an image file to the "images" bucket.
 * `folder` is typically the tourId (sometimes with a suffix) so files stay
 * organised per tour — the leading segment is what maps a file to its owner.
 */
export async function uploadImage(
  file: File, folder: string, opts?: UploadOptions,
): Promise<string | null> {
  // Validate the ORIGINAL first. Downscaling turns a HEIC into a failed decode
  // and hands back the untouched file, so checking afterwards would report
  // something vague instead of the specific "export as JPEG" advice.
  const invalid = validateFile(file, 'image');
  if (invalid) { opts?.onError?.(invalid); return null; }

  const prepared = await downscaleImage(file, opts?.maxEdge ?? DEFAULT_MAX_EDGE);
  // Extension comes from the prepared file: it may now be .webp, and the stored
  // path has to say so — mediaSession guesses artwork type from the extension.
  const path = `${folder}/${Date.now()}.${extOf(prepared, 'jpg')}`;
  return upload('images', path, prepared, 'image', folder.split('/')[0] || null, opts);
}

/** Upload a GLB model to the "models" bucket. */
export async function uploadModel(
  file: File, tourId: string, opts?: UploadOptions,
): Promise<string | null> {
  const path = `${tourId}/ar/${Date.now()}.glb`;
  return upload('models', path, file, 'model', tourId, opts);
}

/**
 * Camera-object images remain in the public images bucket. GLB models use their
 * own public bucket because the images bucket intentionally allows image MIME
 * types only.
 */
/**
 * Upload an AR object: a GLB model, or a flat image used as a billboard.
 *
 * Dispatches to the shared upload path rather than talking to storage
 * directly, so AR assets get the same type and size validation as everything
 * else, count toward the account's storage quota, and land in the `uploads`
 * ledger. This previously bypassed all three — a creator could store unlimited
 * 3D models without them registering against any limit.
 */
export async function uploadARAsset(
  file: File, tourId: string, opts?: UploadOptions,
): Promise<string | null> {
  const isGlb = file.name.toLowerCase().endsWith('.glb') || file.type === 'model/gltf-binary';
  return isGlb
    ? uploadModel(file, tourId, opts)
    : uploadImage(file, `${tourId}/ar`, opts);
}

// ── Reusing what a tour already has ──────────────────────────────────────────
/**
 * List the files already uploaded under a tour, so a creator can pick one
 * instead of uploading the same thing again.
 *
 * Reads storage directly rather than the `uploads` ledger, and that choice
 * matters: the ledger is written by this module, but generated voiceovers are
 * uploaded by the elevenlabs-tts edge function, which never touches it. At the
 * time of writing that was 27 of 133 files — and generated narration is exactly
 * what gets reused across zones, so a ledger-backed picker would have missed
 * the most useful case.
 *
 * Needs the "Creators list their own tour files" policy on storage.objects;
 * before that, listing returned nothing at all for creators.
 */
export interface TourMediaFile {
  /** Bare filename, for display. */
  name: string;
  /** Full storage path, unique within the bucket. */
  path: string;
  url: string;
  sizeBytes: number | null;
  updatedAt: string | null;
}

/**
 * List one folder, and recurse into any subfolders it reports.
 *
 * `list()` is not recursive: it returns files in the folder plus pseudo-entries
 * for subfolders, which have a null id and no metadata. The first version of
 * this hardcoded the subfolder names it expected, which was a guess and a wrong
 * one — it looked for `ar/`, while the images actually live under
 * `progression/`. Eight files platform-wide were invisible to the picker
 * because of it.
 *
 * Enumerating instead of guessing means a new upload path cannot quietly go
 * missing from the picker the way that one did. Depth is capped because the
 * layout is one level deep today and a runaway recursion in an editor control
 * is a worse failure than a missing file.
 */
async function listBucketFolder(
  bucket: string, folder: string, depth = 0,
): Promise<TourMediaFile[]> {
  const { data, error } = await supabase.storage.from(bucket).list(folder, {
    limit: 200,
    sortBy: { column: 'created_at', order: 'desc' },
  });
  if (error) { console.error(`list ${bucket}/${folder}:`, error.message); return []; }

  const entries = data ?? [];
  const files = entries
    .filter(entry => entry.id !== null && entry.name !== '.emptyFolderPlaceholder')
    .map(entry => {
      const path = `${folder}/${entry.name}`;
      return {
        name: entry.name,
        path,
        url: supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl,
        sizeBytes: (entry.metadata as { size?: number } | null)?.size ?? null,
        updatedAt: entry.updated_at ?? entry.created_at ?? null,
      };
    });

  if (depth >= 2) return files;

  const subfolders = entries.filter(
    entry => entry.id === null && entry.name !== '.emptyFolderPlaceholder',
  );
  const nested = await Promise.all(
    subfolders.map(sub => listBucketFolder(bucket, `${folder}/${sub.name}`, depth + 1)),
  );
  return [...files, ...nested.flat()];
}

const newestFirst = (a: TourMediaFile, b: TourMediaFile) =>
  (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');

/** Audio already uploaded or generated for this tour, newest first. */
export async function listTourAudio(tourId: string): Promise<TourMediaFile[]> {
  return (await listBucketFolder('audio', tourId)).sort(newestFirst);
}

/**
 * Images already uploaded for this tour, newest first.
 *
 * Covers subfolders too — `progression/` for resource icons, `ar/` for
 * billboard images. A character portrait and a progression icon are the same
 * kind of thing to a creator, so there is no reason to hide one from the other.
 */
export async function listTourImages(tourId: string): Promise<TourMediaFile[]> {
  return (await listBucketFolder('images', tourId)).sort(newestFirst);
}
