// One-off export of route geometry, run while authoring the seed. The output is committed as
// database/sources/route_geometry.json; nothing in the backend or the generator calls a routing service.
//
// Providers (only coordinates are sent):
//   osrm (default)  public OSRM demo router, car profile, no key
//   ors             OpenRouteService, heavy-goods-vehicle profile with a 34 t weight; needs a free key
//                   in the ORS_API_KEY environment variable (never written to a file)
//
// Usage (from database/): npx tsx scripts/export-route-geometry.ts [--provider ors]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SOURCES, haversineKm, round, type LngLat } from './seed-lib';

const OUT = join(SOURCES, 'route_geometry.json');
const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
const ORS = 'https://api.openrouteservice.org/v2/directions/driving-hgv/geojson';
const PROVIDER = process.argv.includes('--provider') ? process.argv[process.argv.indexOf('--provider') + 1] : 'osrm';
const TRUCK_WEIGHT_T = 34; // the heaviest loaded truck in the seed (SHP-1002)
const MAX_POINTS = 60;

type LatLng = [number, number];
const PLANT_X: LatLng = [18.955, 73.123]; // fictional site in the Panvel area
const RANJANGAON: LatLng = [18.77, 74.25]; // Deccan Mouldings (fictional), Ranjangaon MIDC, Pune district
const SATPUR: LatLng = [20.01, 73.73]; // Godavari Flexipack (fictional), Satpur MIDC, Nashik

// Each pair: base route and its alternative. Via points force the alternative road.
const PAIRS: [string, LatLng[], string, LatLng[]][] = [
  ['RTE-01', [PLANT_X, RANJANGAON], 'RTE-01B', [PLANT_X, [18.6, 73.76], RANJANGAON]], // via Pune, then the Pune-Ahmednagar road
  ['RTE-02', [PLANT_X, SATPUR], 'RTE-02B', [PLANT_X, [19.65, 73.14], [19.93, 73.53], SATPUR]], // via Wada and Trimbakeshwar
];

async function fetchRoute(points: LatLng[]): Promise<LngLat[]> {
  return PROVIDER === 'ors' ? fetchOrs(points) : fetchOsrm(points);
}

async function fetchOrs(points: LatLng[]): Promise<LngLat[]> {
  const key = process.env.ORS_API_KEY;
  if (!key) throw new Error('Set ORS_API_KEY (free key from openrouteservice.org) to use --provider ors');
  const res = await fetch(ORS, {
    method: 'POST',
    headers: { Authorization: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      coordinates: points.map(([lat, lng]) => [lng, lat]),
      options: { vehicle_type: 'hgv', profile_params: { restrictions: { weight: TRUCK_WEIGHT_T } } },
    }),
  });
  if (!res.ok) throw new Error(`OpenRouteService ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { features: { geometry: { coordinates: LngLat[] } }[] };
  return data.features[0].geometry.coordinates;
}

async function fetchOsrm(points: LatLng[]): Promise<LngLat[]> {
  const path = points.map(([lat, lng]) => `${lng},${lat}`).join(';');
  const res = await fetch(`${OSRM}${path}?overview=full&geometries=geojson`, { headers: { 'User-Agent': 'fixture-authoring-script' } });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const data = (await res.json()) as { routes: { geometry: { coordinates: LngLat[] } }[] };
  return data.routes[0].geometry.coordinates;
}

const lengthKm = (c: LngLat[]) => c.slice(1).reduce((s, p, i) => s + haversineKm(c[i], p), 0);

/** Douglas-Peucker: keep the end points; drop points closer than tolM metres to the chord. */
function douglasPeucker(c: LngLat[], tolM: number): LngLat[] {
  const k = Math.cos((c[0][1] * Math.PI) / 180);
  const pts = c.map(([lng, lat]) => [lng * 111320 * k, lat * 110540]);
  const keep = c.map((_, i) => i === 0 || i === c.length - 1);
  const stack: [number, number][] = [[0, c.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [x1, y1] = pts[s];
    const [x2, y2] = pts[e];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const norm = Math.hypot(dx, dy) || 1;
    let best = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs(dy * (pts[i][0] - x1) - dx * (pts[i][1] - y1)) / norm;
      if (d > best) [best, idx] = [d, i];
    }
    if (idx >= 0 && best > tolM) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return c.filter((_, i) => keep[i]);
}

/** Smallest tolerance whose simplified pieces fit the point budget (shared joins counted once). */
function simplifyPieces(pieces: LngLat[][], budget: number): LngLat[][] {
  let lo = 1;
  let hi = 20000;
  for (let n = 0; n < 40; n++) {
    const mid = (lo + hi) / 2;
    const total = pieces.reduce((s, p) => s + douglasPeucker(p, mid).length, 0) - (pieces.length - 1);
    if (total > budget) lo = mid;
    else hi = mid;
  }
  return pieces.map((p) => douglasPeucker(p, hi));
}

const rounded = (c: LngLat[]): LngLat[] => c.map(([lng, lat]) => [round(lng, 5), round(lat, 5)]);

async function main() {
  const routes: Record<string, unknown> = {};
  for (const [baseId, basePts, altId, altPts] of PAIRS) {
    const base = await fetchRoute(basePts);
    const alt = await fetchRoute(altPts);
    let split = 0;
    while (split < Math.min(base.length, alt.length) && base[split][0] === alt[split][0] && base[split][1] === alt[split][1]) split++;
    split -= 1; // last shared vertex
    const prefix = base.slice(0, split + 1);
    // The prefix is simplified once (with the base route) and reused by the alternative,
    // so the two routes share it vertex for vertex.
    const [p, baseTail] = simplifyPieces([prefix, base.slice(split)], MAX_POINTS);
    const [altTail] = simplifyPieces([alt.slice(split)], MAX_POINTS - p.length + 1);
    for (const [id, tail, raw] of [[baseId, baseTail, base], [altId, altTail, alt]] as const) {
      routes[id] = {
        coordinates: rounded([...p, ...tail.slice(1)]),
        split_index: p.length - 1,
        osrm_length_km: round(lengthKm(raw as LngLat[]), 1),
        shared_prefix_osrm_km: round(lengthKm(prefix), 1),
      };
      const r = routes[id] as { coordinates: unknown[]; split_index: number; osrm_length_km: number };
      console.log(id, r.coordinates.length, 'points; split at index', r.split_index, '; OSRM length', r.osrm_length_km, 'km');
    }
  }
  const out = {
    fictional_endpoints: true,
    source:
      PROVIDER === 'ors'
        ? `OpenRouteService (openrouteservice.org), driving-hgv profile, weight ${TRUCK_WEIGHT_T} t, OpenStreetMap data`
        : 'OSRM demo router (router.project-osrm.org), driving profile, OpenStreetMap data',
    exported_on: '2026-11-12',
    method: 'Full geometry fetched once, shared prefix detected, each piece simplified with Douglas-Peucker to at most 60 points per route',
    routes,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
