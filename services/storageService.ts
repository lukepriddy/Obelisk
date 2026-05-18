/**
 * storageService.ts
 * Uploads files to Supabase Storage and returns permanent public URLs.
 *
 * Requires two public buckets to exist in your Supabase project:
 *   • "audio"  — for zone audio files
 *   • "images" — for tour cover photos and character avatars
 *
 * Create them in the Supabase dashboard → Storage → New bucket.
 * Set each bucket to Public so the generated URLs work without auth.
 */

import { supabase } from './supabaseClient';

/**
 * Upload an audio file to the "audio" bucket.
 * Files are stored under <tourId>/<timestamp>.<ext>
 * Returns the permanent public URL, or null on failure.
 */
export async function uploadAudio(file: File, tourId: string): Promise<string | null> {
  const ext  = file.name.split('.').pop() ?? 'mp3';
  const path = `${tourId}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from('audio')
    .upload(path, file, { upsert: false });

  if (error) {
    console.error('Audio upload failed:', error.message);
    return null;
  }

  const { data } = supabase.storage.from('audio').getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Upload an image file to the "images" bucket.
 * folder is typically the tourId so files stay organised per tour.
 * Returns the permanent public URL, or null on failure.
 */
export async function uploadImage(file: File, folder: string): Promise<string | null> {
  const ext  = file.name.split('.').pop() ?? 'jpg';
  const path = `${folder}/${Date.now()}.${ext}`;

  const { error } = await supabase.storage
    .from('images')
    .upload(path, file, { upsert: false });

  if (error) {
    console.error('Image upload failed:', error.message);
    return null;
  }

  const { data } = supabase.storage.from('images').getPublicUrl(path);
  return data.publicUrl;
}
