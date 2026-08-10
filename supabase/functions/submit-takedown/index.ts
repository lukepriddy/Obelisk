/**
 * submit-takedown edge function
 *
 * Intake for people objecting to an experience who are not playing it: a
 * landowner whose property is a stop, a rights holder whose work is in a zone,
 * someone reporting a hazard they walked past.
 *
 * Public by design. It has to work for someone who had never heard of Obelisk
 * until they found a stranger standing in their garden, so there is no sign-in
 * anywhere near it; requiring an account would make the path decorative.
 *
 * Reached with the anon key, which satisfies verify_jwt the same way the
 * player's anonymous zone-visit and chat calls already do. That keeps the
 * function on the project's default deployment settings rather than being the
 * one endpoint with authentication switched off.
 *
 * Writes with the service role rather than exposing an anonymous INSERT policy,
 * so the table has no policies at all and cannot be read or written from a
 * browser. The contact details of someone reporting a problem should not be
 * queryable by the person they are reporting.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { corsFor } from '../_shared/cors.ts';

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const KINDS = ['property', 'copyright', 'safety', 'privacy', 'other'];
const MAX_PER_IP_PER_HOUR = 5;

/** Hashed so the table can be rate-limited without becoming an IP log. */
async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`obelisk-takedown:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).slice(0, 16)
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

const clean = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...cors, 'Content-Type': 'application/json' },
    });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Not found.' }, 404);

  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));

    const kind = typeof body?.kind === 'string' && KINDS.includes(body.kind) ? body.kind : 'other';
    const claim = clean(body?.claim, 4000);
    const contactEmail = clean(body?.contact_email, 320);

    // Only two things are actually required: what the problem is, and how to
    // reply. Everything else is whatever the reporter happens to know.
    if (!claim) return json({ error: 'Please describe the problem.' }, 400);
    if (!contactEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
      return json({ error: 'Please give an email address we can reply to.' }, 400);
    }

    const forwarded = req.headers.get('x-forwarded-for') ?? '';
    const ip = forwarded.split(',')[0].trim() || 'unknown';
    const ipHash = await hashIp(ip);

    // Rate limit. A public form with no account behind it is a spam target,
    // and the cost of a flood here is a queue nobody can triage rather than a
    // bill — which is worse, because a real report gets buried in it.
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await admin
      .from('takedown_requests')
      .select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('created_at', since);

    if ((count ?? 0) >= MAX_PER_IP_PER_HOUR) {
      return json({ error: 'Too many reports from here just now. Please try again shortly.' }, 429);
    }

    // A pasted player URL usually carries the tour id. Linking it saves the
    // triage step, but a mismatch must never block the report: the id is a
    // convenience, the claim is the thing that matters.
    const tourUrl = clean(body?.tour_url, 500);
    const match = tourUrl?.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    );
    let tourId: string | null = match ? match[1] : null;
    if (tourId) {
      const { data: exists } = await admin
        .from('tours').select('id').eq('id', tourId).maybeSingle();
      if (!exists) tourId = null;
    }

    const { error } = await admin.from('takedown_requests').insert({
      kind,
      tour_id: tourId,
      tour_url: tourUrl,
      location_text: clean(body?.location_text, 500),
      claim,
      relationship: clean(body?.relationship, 200),
      contact_name: clean(body?.contact_name, 200),
      contact_email: contactEmail,
      ip_hash: ipHash,
    });

    if (error) {
      console.error('submit-takedown insert:', error);
      return json({ error: 'Could not send that. Please try again.' }, 500);
    }

    return json({ ok: true });
  } catch (e) {
    console.error('submit-takedown:', e);
    return json({ error: 'Something went wrong.' }, 500);
  }
});
