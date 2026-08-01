import type { Tour, Zone } from '../types';
import { getDistance } from './geo';

/**
 * Planning information for an experience: how far, what shape, how long.
 *
 * Twenty minutes and ninety minutes are different plans, and someone deciding
 * what to do with an afternoon needs this before committing rather than after
 * starting. Everything here is therefore meant for surfaces that come *before*
 * play — the welcome screen, share cards, listings.
 *
 * Distances are derived; only the completion estimate needs a human, because
 * dwell time, chat length and walking pace are not inferable.
 */

const M_PER_FT = 0.3048;
const M_PER_MILE = 1609.344;

export interface TrailStats {
  zoneCount: number;
  /** Approximate walking distance through the zones, in metres. */
  distanceMeters: number;
  /**
   * How far the furthest stop is from the start, in metres.
   *
   * This replaced a loop/point-to-point classification, which could not be
   * computed honestly: with no authored path the route is approximated by
   * nearest-neighbour, and that always ends at the furthest stop, so every
   * tour would have been labelled one-way regardless of its real shape.
   * "How far out does this go" answers the same planning question — how much
   * walking am I committing to, and how far from the car do I get — without
   * asserting something the data cannot support.
   */
  furthestMeters: number;
}

/**
 * Zones carry no authored order — only `requires_zone_id` gating, which is a
 * partial order at best and absent in most tours. So the route is approximated
 * by walking nearest-unvisited-neighbour from the start pin, which is roughly
 * what a player actually does when the map shows them several markers.
 *
 * That makes the distance an estimate, and it is presented as one. A creator
 * who wants an exact number would need an authored path, which does not exist
 * and would be a much larger feature.
 */
export function trailStats(tour: Tour, zones: Zone[]): TrailStats {
  const placed = zones.filter(z => Number.isFinite(z.lat) && Number.isFinite(z.lng));
  const hasStart = Number.isFinite(tour.lat) && Number.isFinite(tour.lng)
    && (tour.lat !== 0 || tour.lng !== 0);

  if (placed.length === 0) {
    return { zoneCount: 0, distanceMeters: 0, furthestMeters: 0 };
  }

  // Start from the tour's start pin when it has one, otherwise from the first
  // zone — a tour without a start pin still has a shape.
  let currentLat = hasStart ? tour.lat : placed[0].lat;
  let currentLng = hasStart ? tour.lng : placed[0].lng;
  const originLat = currentLat;
  const originLng = currentLng;

  const remaining = [...placed];
  let distanceMeters = 0;

  while (remaining.length) {
    let nearest = 0;
    let nearestDistance = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = getDistance(currentLat, currentLng, remaining[i].lat, remaining[i].lng);
      if (d < nearestDistance) { nearestDistance = d; nearest = i; }
    }
    const [next] = remaining.splice(nearest, 1);
    distanceMeters += nearestDistance;
    currentLat = next.lat;
    currentLng = next.lng;
  }

  // Order-independent, unlike anything derived from the walking order above.
  const furthestMeters = placed.reduce(
    (max, z) => Math.max(max, getDistance(originLat, originLng, z.lat, z.lng)),
    0,
  );

  return { zoneCount: placed.length, distanceMeters, furthestMeters };
}

/** Feet under a quarter mile, miles beyond it. Matches the rest of the UI. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters <= 0) return '';
  if (meters < M_PER_MILE / 4) return `${Math.round(meters / M_PER_FT / 10) * 10} ft`;
  const miles = meters / M_PER_MILE;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

/**
 * Deliberately vague. The number is a creator's estimate of something that
 * varies by person, so rendering "37 min" would imply a precision nobody has.
 */
export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return '';
  if (minutes < 90) return `about ${Math.round(minutes / 5) * 5} min`;
  // Nearest half hour. An earlier version compared the fractional part against
  // thresholds and reported 105 minutes as "1½ hr", which is 90.
  const halves = Math.round(minutes / 30) / 2;
  const whole = Math.floor(halves);
  return `about ${halves % 1 ? `${whole}½` : `${whole}`} hr`;
}

/**
 * The one line that goes on a welcome screen, a share card or a listing:
 * "1.2 mi · 5 stops · about 40 min". Parts missing are simply left out rather
 * than shown empty, so a tour with nothing filled in reads as nothing at all.
 */
export function trailSummary(stats: TrailStats, durationMinutes?: number | null): string {
  const parts = [
    formatDistance(stats.distanceMeters),
    stats.zoneCount ? `${stats.zoneCount} ${stats.zoneCount === 1 ? 'stop' : 'stops'}` : '',
    formatDuration(durationMinutes),
  ].filter(Boolean);
  return parts.join(' · ');
}

/**
 * What to put in front of a creator when they're filling in the duration field.
 *
 * Real completion times from finished sessions beat any guess, so they win when
 * they exist. Otherwise fall back to walking the route at a slow amble plus a
 * couple of minutes standing at each stop — deliberately rough, and framed as a
 * starting point rather than an answer.
 */
export function suggestDuration(
  stats: TrailStats,
  measuredAverageSeconds?: number | null,
  completedSessions = 0,
): { minutes: number; basis: 'measured' | 'estimated'; note: string } | null {
  if (measuredAverageSeconds && completedSessions > 0) {
    // Rounded to five like everything else, so the button and the note below
    // it don't disagree ("Use 38" beside "averaged 40 min").
    const minutes = Math.max(5, Math.round(measuredAverageSeconds / 60 / 5) * 5);
    return {
      minutes,
      basis: 'measured',
      note: `Players have averaged ${formatDuration(minutes).replace('about ', '')} across `
        + `${completedSessions} completed ${completedSessions === 1 ? 'play' : 'plays'}.`,
    };
  }
  if (!stats.zoneCount) return null;
  // ~1.1 m/s is an unhurried walking pace with stops and looking around.
  const walkMinutes = stats.distanceMeters / 1.1 / 60;
  const dwellMinutes = stats.zoneCount * 2;
  const minutes = Math.max(5, Math.round((walkMinutes + dwellMinutes) / 5) * 5);
  return {
    minutes,
    basis: 'estimated',
    note: `Rough guess from ${formatDistance(stats.distanceMeters)} of walking and `
      + `${stats.zoneCount} ${stats.zoneCount === 1 ? 'stop' : 'stops'}.`,
  };
}
