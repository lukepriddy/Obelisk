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
 * Calculates linear attenuation based on distance and radius.
 * Returns a value between 0.0 (edge) and 1.0 (center).
 */
export const calculateAttenuation = (distance: number, radius: number): number => {
  if (distance >= radius) return 0;
  // Linear fade: 0 distance = 1 volume, radius distance = 0 volume
  return Math.max(0, 1 - distance / radius);
};