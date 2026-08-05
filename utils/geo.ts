/**
 * Calculates the distance between two coordinates in meters using the Haversine formula.
 */
export const getDistance = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const R = 6371e3; // Earth radius in meters
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLambda = ((lng2 - lng1) * Math.PI) / 180;

  const a =
    Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};

/**
 * True bearing from one coordinate to another, in degrees clockwise from north.
 */
export const bearingTo = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLng = toRad(lng2 - lng1);
  const y = Math.sin(deltaLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLng);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
};

/**
 * The coordinate you reach by travelling `meters` from a point along `bearing`.
 *
 * Flat-earth approximation, deliberately: this is the inverse of the projection
 * the AR renderer uses to turn a creator's offset into a real coordinate, and
 * the editor has to agree with the renderer exactly. A more correct geodesic
 * here would put the editor's marker in a slightly different place from the
 * object the player actually sees — invisible at a few feet, real at half a
 * mile. Both sides call this, so they cannot drift apart.
 *
 * Error against a proper geodesic is centimetres at 1km and grows with the
 * square of distance; fine for placements, not for navigation.
 */
export const destinationPoint = (
  lat: number,
  lng: number,
  bearingDegrees: number,
  meters: number,
): { lat: number; lng: number } => {
  const bearing = (bearingDegrees * Math.PI) / 180;
  const nextLat = lat + (Math.cos(bearing) * meters) / 111_320;
  // Longitude degrees shrink with latitude. Guard the pole case where the
  // cosine reaches zero and the division would explode.
  const scale = 111_320 * Math.cos((nextLat * Math.PI) / 180);
  const nextLng = lng + (Math.sin(bearing) * meters) / (scale || 1);
  return { lat: nextLat, lng: nextLng };
};

/**
 * The exact inverse of destinationPoint: the offset that would take you from
 * one coordinate to another.
 *
 * Deliberately not Haversine. getDistance measures on a sphere of radius
 * 6371km (111,195m per degree) while destinationPoint uses the flat 111,320,
 * and mixing them makes the round trip lossy: drag a marker, store what
 * Haversine measured, re-render it through destinationPoint, and it lands
 * ~0.1% of the distance away from where it was dropped. Under 2m at a mile, so
 * invisible on screen and far below compass error, but it means the stored
 * numbers do not quite describe the point the creator chose. Inverting the same
 * approximation makes the round trip exact instead.
 */
export const offsetFrom = (
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
): { meters: number; bearingDegrees: number } => {
  const northMeters = (toLat - fromLat) * 111_320;
  // Longitude scaled at the destination latitude, matching destinationPoint.
  const eastMeters = (toLng - fromLng) * (111_320 * Math.cos((toLat * Math.PI) / 180));
  return {
    meters: Math.hypot(northMeters, eastMeters),
    bearingDegrees: (((Math.atan2(eastMeters, northMeters) * 180) / Math.PI) + 360) % 360,
  };
};

/**
 * Calculates linear attenuation based on distance and radius.
 * Returns a value between 0.0 (edge) and 1.0 (center).
 */
export const calculateAttenuation = (distance: number, radius: number): number => {
  if (distance >= radius) return 0;
  // Linear fade: 0 distance = 1 volume, radius distance = 0 volume
  return Math.max(0, 1 - distance / radius);
};