/**
 * delete-tour edge function
 *
 * Deleting a tour used to delete one row. Everything the creator had uploaded —
 * audio, images, 3D models — stayed in storage forever, while
 * `constants/privacy.ts` told them "delete an experience and its content goes
 * with it". This function makes that sentence true.
 *
 * Why server-side: storage RLS lets a creator DELETE their own objects but
 * grants no SELECT, so the browser cannot enumerate what to delete. Only the
 * service role can see `storage.objects`.
 *
 * Order is deliberate — files first, verified, then the row. If storage fails
 * we abort with the tour still intact, so the creator can retry and the files
 * remain reachable. Deleting the row first would strip the only pointer to
 * them and turn a retryable error into permanent orphans.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor } from '../_shared/cors.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface StorageRow { bucket_id: string; name: string }

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: userRes } = await admin.auth.getUser(jwt);
    const uid = userRes?.user?.id;
    if (!uid) return json({ error: 'Not signed in.' }, 401);

    const body = await req.json().catch(() => ({}));
    const tourId = body?.tourId;
    if (!UUID_RE.test(tourId ?? '')) return json({ error: 'Invalid request.' }, 400);

    // Ownership is checked here rather than leaned on via RLS, because every
    // write below runs as the service role and bypasses RLS entirely.
    const { data: tour } = await admin
      .from('tours').select('id, owner_id').eq('id', tourId).maybeSingle();
    if (!tour) return json({ error: 'Not found.' }, 404);

    if (tour.owner_id !== uid) {
      const { data: isAdmin } = await admin
        .from('platform_admins').select('user_id').eq('user_id', uid).maybeSingle();
      if (!isAdmin) return json({ error: 'Not found.' }, 404);
    }

    // ── 1. Files ────────────────────────────────────────────────────────────
    const { data: objects, error: listErr } =
      await admin.rpc('tour_storage_objects', { p_tour_id: tourId });
    if (listErr) {
      console.error('delete-tour list:', listErr);
      return json({ error: 'Could not read this experience’s files.' }, 500);
    }

    const rows = (objects ?? []) as StorageRow[];
    const byBucket = new Map<string, string[]>();
    for (const row of rows) {
      const paths = byBucket.get(row.bucket_id) ?? [];
      paths.push(row.name);
      byBucket.set(row.bucket_id, paths);
    }

    for (const [bucket, paths] of byBucket) {
      // remove() takes the whole batch, but cap it so one pathological tour
      // can't build a request large enough to fail as a unit.
      for (let i = 0; i < paths.length; i += 100) {
        const { error } = await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
        if (error) {
          console.error(`delete-tour remove ${bucket}:`, error);
          return json({ error: 'Could not delete this experience’s files. Nothing was removed — please try again.' }, 500);
        }
      }
    }

    // Trust the verification, not the absence of an error. A partial success
    // that still reported ok is exactly the failure this whole function exists
    // to prevent.
    const { data: leftover } = await admin.rpc('tour_storage_objects', { p_tour_id: tourId });
    const remaining = ((leftover ?? []) as StorageRow[]).length;
    if (remaining > 0) {
      console.error(`delete-tour: ${remaining} object(s) survived for ${tourId}`);
      return json({ error: 'Some files could not be deleted. The experience was kept so you can try again.' }, 500);
    }

    // ── 2. Ledger, then the tour itself ─────────────────────────────────────
    await admin.from('uploads').delete().eq('tour_id', tourId);

    const { error: delErr } = await admin.from('tours').delete().eq('id', tourId);
    if (delErr) {
      console.error('delete-tour row:', delErr);
      return json({ error: 'Files were removed but the experience could not be deleted.' }, 500);
    }

    return json({ ok: true, filesDeleted: rows.length });
  } catch (e) {
    console.error('delete-tour:', e);
    return json({ error: 'Something went wrong.' }, 500);
  }
});
