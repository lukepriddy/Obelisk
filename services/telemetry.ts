/**
 * telemetry.ts
 *
 * Minimal client-error telemetry. Real players are anonymous and their
 * consoles are unreachable — without this, every field failure is invisible.
 * Events are insert-only (nothing public can read them back), deduplicated
 * per session, and hard-capped so a crash loop can't spam the table.
 * Telemetry must never break the app: every path is wrapped.
 */

import { supabase } from './supabaseClient';

const MAX_EVENTS_PER_SESSION = 20;
let sent = 0;
const seen = new Set<string>();

export const logClientEvent = (
  kind: string,
  message: string,
  detail: Record<string, unknown> = {},
) => {
  try {
    if (sent >= MAX_EVENTS_PER_SESSION) return;
    const signature = `${kind}:${message}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    sent += 1;

    const tourId = typeof detail.tourId === 'string' && detail.tourId.length === 36
      ? detail.tourId
      : null;

    void supabase.from('client_events').insert({
      kind: kind.slice(0, 40),
      message: String(message).slice(0, 500),
      detail,
      tour_id: tourId,
      ua: navigator.userAgent.slice(0, 300),
    }).then(() => { /* fire-and-forget; supabase-js reports errors in the result, not as rejections */ });
  } catch { /* never let telemetry throw */ }
};

export const installGlobalErrorTelemetry = () => {
  try {
    window.addEventListener('error', event => {
      logClientEvent('js_error', event.message || 'Unknown error', {
        source: `${event.filename ?? ''}:${event.lineno ?? 0}`,
      });
    });
    window.addEventListener('unhandledrejection', event => {
      logClientEvent('unhandled_rejection', String(event.reason ?? 'unknown').slice(0, 300));
    });
  } catch { /* never let telemetry throw */ }
};
