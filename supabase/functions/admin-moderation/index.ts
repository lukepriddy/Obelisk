/**
 * admin-moderation edge function
 *
 * The rare-case human queue behind the automatic gate in `moderate-tour`:
 * borderline verdicts, review outages, and player reports land here.
 *
 * Authorisation is membership in `platform_admins`, checked server-side on
 * every call. That table has RLS enabled with no policies, so it is invisible
 * and unwritable from the browser — there is no code path by which anyone can
 * grant themselves access. Never gate this on an email string in the client.
 *
 * Actions:
 *   list            — tours awaiting review + unresolved reports
 *   decide          — approve (publishes) or reject a queued tour
 *   force_unpublish — take any tour offline, including another creator's.
 *                     This is the takedown lever behind the deferred risks
 *                     (audio, 3D models, real-world placement) that automatic
 *                     content review cannot cover.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor } from '../_shared/cors.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const { data: isAdmin } = await admin
      .from('platform_admins').select('user_id').eq('user_id', uid).maybeSingle();
    // Same response as a non-admin signed-in user would get: don't confirm the
    // endpoint exists to anyone probing it.
    if (!isAdmin) return json({ error: 'Not found.' }, 404);

    const body = await req.json().catch(() => ({}));
    const action = body?.action;

    if (action === 'list') {
      const { data: queue } = await admin
        .from('tours')
        .select('id, title, description, owner_id, moderation_status, moderation_reason, moderation_categories, moderated_at, is_public')
        .eq('moderation_status', 'pending_review')
        .order('moderated_at', { ascending: true });

      const { data: reports } = await admin
        .from('tour_reports')
        .select('id, tour_id, reason, created_at, tours(title, owner_id, is_public)')
        .is('resolved_at', null)
        .order('created_at', { ascending: true })
        .limit(200);

      // People asking to be let in while Obelisk is invite-only, with what
      // they said they want to build.
      const { data: accessRequests } = await admin
        .from('access_allowlist')
        .select('email, request_note, requested_at')
        .eq('status', 'requested')
        .order('requested_at', { ascending: false })
        .limit(200);

      // Takedown requests come from outside: landowners and rights holders who
      // never played the experience and have no account. Listed first in
      // priority terms even though the shape matches the others, because these
      // are the ones with a person waiting on a reply.
      const { data: takedowns } = await admin
        .from('takedown_requests')
        .select('id, kind, tour_id, tour_url, location_text, claim, relationship, contact_name, contact_email, created_at')
        .is('resolved_at', null)
        .order('created_at', { ascending: true })
        .limit(200);

      return json({
        queue: queue ?? [],
        reports: reports ?? [],
        accessRequests: accessRequests ?? [],
        takedowns: takedowns ?? [],
      });
    }

    if (action === 'decide') {
      const tourId = body?.tourId;
      const decision = body?.decision;
      if (!UUID_RE.test(tourId ?? '') || (decision !== 'approve' && decision !== 'reject')) {
        return json({ error: 'Invalid request.' }, 400);
      }
      const approved = decision === 'approve';
      const { error } = await admin.from('tours').update({
        moderation_status: approved ? 'approved' : 'rejected',
        moderation_reason: approved
          ? null
          : (typeof body?.note === 'string' && body.note.trim()
              ? body.note.slice(0, 600)
              : 'This experience was not approved for publishing.'),
        moderated_at: new Date().toISOString(),
        // Approving from the queue completes the publish the creator asked
        // for; rejecting leaves it private.
        ...(approved ? { is_public: true } : {}),
      }).eq('id', tourId);
      if (error) return json({ error: 'Could not save that decision.' }, 500);
      return json({ ok: true, status: approved ? 'approved' : 'rejected' });
    }

    if (action === 'force_unpublish') {
      const tourId = body?.tourId;
      if (!UUID_RE.test(tourId ?? '')) return json({ error: 'Invalid request.' }, 400);
      const { error } = await admin.from('tours').update({
        is_public: false,
        moderation_status: 'rejected',
        moderation_reason: typeof body?.note === 'string' && body.note.trim()
          ? body.note.slice(0, 600)
          : 'This experience was taken offline by a platform administrator.',
        moderated_at: new Date().toISOString(),
      }).eq('id', tourId);
      if (error) return json({ error: 'Could not unpublish that experience.' }, 500);
      // Close out any open reports so the queue reflects the action taken.
      await admin.from('tour_reports')
        .update({ resolved_at: new Date().toISOString() })
        .eq('tour_id', tourId).is('resolved_at', null);
      // Same for outside reports that named this tour. A landowner who
      // reported it should not still be sitting in the queue after the thing
      // they reported has gone.
      await admin.from('takedown_requests')
        .update({ resolved_at: new Date().toISOString(), resolution: 'Experience taken offline.' })
        .eq('tour_id', tourId).is('resolved_at', null);
      return json({ ok: true });
    }

    if (action === 'resolve_takedown') {
      const id = Number(body?.id);
      if (!Number.isInteger(id) || id <= 0) return json({ error: 'Invalid request.' }, 400);
      const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 600) : '';
      const { error } = await admin.from('takedown_requests').update({
        resolved_at: new Date().toISOString(),
        resolution: note || 'Reviewed.',
      }).eq('id', id);
      if (error) return json({ error: 'Could not close that report.' }, 500);
      return json({ ok: true });
    }

    if (action === 'decide_access') {
      const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
      const decision = body?.decision;
      if (!email || (decision !== 'approve' && decision !== 'decline')) {
        return json({ error: 'Invalid request.' }, 400);
      }
      const { error } = await admin.from('access_allowlist')
        .update({ status: decision === 'approve' ? 'approved' : 'declined' })
        .eq('email', email);
      if (error) return json({ error: 'Could not update that request.' }, 500);

      if (decision !== 'approve') return json({ ok: true });

      // Public signup is disabled at the project level, so an approved person
      // can't just go and register — they have to be invited. This is the
      // admin API, which runs on the service role and is therefore allowed to
      // create the account regardless of that setting.
      const { error: inviteError } = await admin.auth.admin.inviteUserByEmail(email);
      if (inviteError) {
        // The row is already approved; only the email failed. Say so plainly
        // rather than implying nothing happened.
        console.error('inviteUserByEmail:', inviteError);
        const already = /already.*registered|already been registered/i.test(inviteError.message ?? '');
        return json({
          ok: true,
          invited: false,
          message: already
            ? 'Approved. That address already has an account, so no invite was sent.'
            : 'Approved, but the invite email could not be sent. Send them the link yourself.',
        });
      }
      return json({ ok: true, invited: true });
    }

    if (action === 'resolve_report') {
      const reportId = Number(body?.reportId);
      if (!Number.isInteger(reportId)) return json({ error: 'Invalid request.' }, 400);
      const { error } = await admin.from('tour_reports')
        .update({ resolved_at: new Date().toISOString() })
        .eq('id', reportId);
      if (error) return json({ error: 'Could not resolve that report.' }, 500);
      return json({ ok: true });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (err) {
    console.error('admin-moderation:', err);
    return json({ error: 'Something went wrong.' }, 500);
  }
});
