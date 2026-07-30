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
    return fail('Upload failed — check your connection and try again.');
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
  const path = `${folder}/${Date.now()}.${extOf(file, 'jpg')}`;
  return upload('images', path, file, 'image', folder.split('/')[0] || null, opts);
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
