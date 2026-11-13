// Route geometry: convert between a position (lat, lng) and km along a route.
// When the route's GeoJSON carries `chainage_km` (the km of each vertex, from database/seed), those
// markers are used, so a junction sits at its stated km. Otherwise the line is measured with the
// haversine formula and scaled so that its full length equals total_km. Each line piece is treated
// as flat when projecting.

export type LngLat = [number, number]; // GeoJSON order

const EARTH_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

function cumulative(coords: LngLat[]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineKm(coords[i - 1], coords[i]));
  return cum;
}

/** km of each vertex: the route's own chainage when it has one per vertex, else the scaled line length. */
export function kmMarks(coords: LngLat[], totalKm: number, chainage?: number[]): number[] {
  if (chainage && chainage.length === coords.length) return chainage;
  const cum = cumulative(coords);
  const lineKm = cum[cum.length - 1];
  return cum.map((c) => (c / lineKm) * totalKm);
}

/** Point at `km` along the route (linear inside each line piece). */
export function pointAtKm(coords: LngLat[], totalKm: number, km: number, chainage?: number[]): LngLat {
  const marks = kmMarks(coords, totalKm, chainage);
  const target = Math.min(Math.max(km, 0), totalKm);
  for (let i = 1; i < coords.length; i++) {
    if (target <= marks[i] || i === coords.length - 1) {
      const piece = marks[i] - marks[i - 1];
      const t = piece === 0 ? 0 : Math.min(1, Math.max(0, (target - marks[i - 1]) / piece));
      return [coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]), coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1])];
    }
  }
  return coords[coords.length - 1];
}

/** Project a position onto the route. Returns km along the route and the distance off the line in km. */
export function projectToKm(coords: LngLat[], totalKm: number, p: LngLat, chainage?: number[]): { km: number; offKm: number } {
  const marks = kmMarks(coords, totalKm, chainage);
  let best = { along: 0, off: Number.POSITIVE_INFINITY };
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    // Flat projection with longitude scaled by cos(latitude) of this piece.
    const k = Math.cos(rad((a[1] + b[1]) / 2));
    const ax = a[0] * k, ay = a[1], bx = b[0] * k, by = b[1], px = p[0] * k, py = p[1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2));
    const q: LngLat = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    const off = haversineKm(q, p);
    if (off < best.off) best = { along: marks[i - 1] + t * (marks[i] - marks[i - 1]), off };
  }
  return { km: Math.round(best.along * 1000) / 1000, offKm: best.off };
}

/** Positions further than this from the route line cannot be projected (schedule fallback). */
export const MAX_OFF_ROUTE_KM = 5;
