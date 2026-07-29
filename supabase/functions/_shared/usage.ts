/**
 * Shared rate limiting for the AI edge functions.
 *
 * BYOK means a creator's own key pays for the model call, but every call still
 * costs Obelisk a function invocation, bandwidth, and often a storage write —
 * so these limits apply to everyone, on every plan. Managed subscribers get a
 * different KEY (see the billing work), never a higher ceiling here.
 *
 * Counting is a plain row-count over a time window in `api_usage_events`. That
 * is not a precise token bucket and two simultaneous requests can both slip
 * under the wire; the goal is to stop runaway loops and scripted abuse, not to
 * meter exactly.
 */

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';

export interface Limit {
  /** Max calls in the short burst window. */
  perMinute?: number;
  /** Max calls per rolling hour. */
  perHour?: number;
  /** Max calls per rolling day. */
  perDay?: number;
}

export interface UsageResult {
  allowed: boolean;
  /** Set when blocked: a user-facing explanation. */
  message?: string;
  /** Set when blocked: seconds until the relevant window frees up. */
  retryAfter?: number;
}

async function countSince(
  admin: SupabaseClient, fnName: string, actorKey: string, sinceMs: number,
): Promise<number> {
  const since = new Date(Date.now() - sinceMs).toISOString();
  const { count, error } = await admin
    .from('api_usage_events')
    .select('id', { count: 'exact', head: true })
    .eq('fn_name', fnName)
    .eq('actor_key', actorKey)
    .gte('created_at', since);
  if (error) {
    console.error('usage countSince:', error.message);
    return 0; // fail open — a bookkeeping outage must not break the product
  }
  return count ?? 0;
}

/**
 * Check the limits and, if the call is allowed, record it.
 *
 * `actorKey` is whoever should be held responsible: the creator's user id for
 * authenticated calls, or the tour id for anonymous player traffic (players
 * don't sign in, so there is no per-person identity to key on — meaning a very
 * busy tour shares one budget, which is why the player-facing limits are set
 * generously).
 */
export async function checkAndRecordUsage(
  admin: SupabaseClient,
  fnName: string,
  actorKey: string,
  limits: Limit,
  tourId?: string | null,
): Promise<UsageResult> {
  try {
    const windows: Array<[number, number | undefined, string, number]> = [
      [60_000, limits.perMinute, 'minute', 60],
      [3_600_000, limits.perHour, 'hour', 900],
      [86_400_000, limits.perDay, 'day', 3600],
    ];

    for (const [ms, cap, label, retryAfter] of windows) {
      if (!cap) continue;
      const used = await countSince(admin, fnName, actorKey, ms);
      if (used >= cap) {
        return {
          allowed: false,
          retryAfter,
          message: `Rate limit reached (${cap} per ${label}). Try again shortly.`,
        };
      }
    }

    await admin.from('api_usage_events').insert({
      fn_name: fnName, actor_key: actorKey, tour_id: tourId ?? null,
    });
    return { allowed: true };
  } catch (err) {
    // Never let the limiter itself take the feature down.
    console.error('checkAndRecordUsage:', err);
    return { allowed: true };
  }
}

/** Standard 429 response body for a blocked call. */
export function rateLimited(result: UsageResult, cors: Record<string, string>) {
  return new Response(
    JSON.stringify({ error: result.message ?? 'Rate limit reached. Try again shortly.' }),
    {
      status: 429,
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        ...(result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {}),
      },
    },
  );
}
