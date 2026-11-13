// Helpers shared by the fixture generator, the validator and the fixture tests.
// Nothing here touches the network, the wall clock or unseeded randomness.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SEED_DIR = join(ROOT, 'seed');
export const SCHEMAS = join(ROOT, 'schemas');
export const SOURCES = join(ROOT, 'sources');
export const SEED = 20261116;

export const FIXTURE_FILES = [
  'config.json',
  'customers.json',
  'transporters.json',
  'users.json',
  'routes.json',
  'history.json',
  'scenario-main.json',
] as const;
export type FixtureFile = (typeof FIXTURE_FILES)[number];

/** Header fields at the top of every file. Top level, because the API loader reads `fictional` there. */
export function header() {
  return { fictional: true, generated_by: 'database/scripts/generate-seed.ts', seed: SEED, schema_version: 1 } as const;
}

// ------------------------------------------------------------------ time

const IST_OFFSET_MIN = 330;

/** '2026-11-16', '08:50' in India Standard Time -> '2026-11-16T03:20:00Z'. */
export function ist(date: string, hhmm: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return toIso(Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MIN * 60_000);
}

export function toIso(ms: number): string {
  return new Date(Math.round(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

export function addMin(iso: string, minutes: number): string {
  return toIso(Date.parse(iso) + minutes * 60_000);
}

export function minutesBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 60_000;
}

/** Local IST parts of a UTC timestamp. */
export function istParts(iso: string) {
  const local = new Date(Date.parse(iso) + IST_OFFSET_MIN * 60_000);
  const hhmm = local.toISOString().slice(11, 16);
  return { date: local.toISOString().slice(0, 10), hhmm, weekday: local.getUTCDay() }; // weekday 0 = Sunday
}

export const istHhmm = (iso: string) => istParts(iso).hhmm;

// ------------------------------------------------------------------ randomness

/** SplitMix64: a few lines that fully define the sequence, so it cannot drift between Node versions. */
export class Rng {
  private state: bigint;
  private static readonly MASK = (1n << 64n) - 1n;

  constructor(seed: number) {
    this.state = BigInt(seed) & Rng.MASK;
  }

  nextU64(): bigint {
    const M = Rng.MASK;
    this.state = (this.state + 0x9e3779b97f4a7c15n) & M;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M;
    return z ^ (z >> 31n);
  }

  below(n: number): number {
    return Number(this.nextU64() % BigInt(n));
  }

  randint(a: number, b: number): number {
    return a + this.below(b - a + 1);
  }

  choice<T>(items: readonly T[]): T {
    return items[this.below(items.length)];
  }

  shuffle<T>(items: T[]): void {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.below(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
  }

  sample<T>(items: readonly T[], k: number): T[] {
    const copy = [...items];
    this.shuffle(copy);
    return copy.slice(0, k);
  }

  uuid4(): string {
    const hex = (this.nextU64().toString(16).padStart(16, '0') + this.nextU64().toString(16).padStart(16, '0')).split('');
    hex[12] = '4';
    hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    const h = hex.join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

// ------------------------------------------------------------------ files

export function dump(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n';
}

export function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, dump(obj), 'utf8');
}

export function readJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadAll(dir: string = SEED_DIR): Record<FixtureFile, any> {
  return Object.fromEntries(FIXTURE_FILES.map((f) => [f, readJson(join(dir, f))])) as Record<FixtureFile, any>;
}

export const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;

// ------------------------------------------------------------------ geometry

export type LngLat = [number, number];

export function haversineKm(a: LngLat, b: LngLat): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
}

/** Point at chainage `km`, interpolating between the route's per-vertex km markers. */
export function pointAtKm(route: { geometry: { coordinates: LngLat[]; chainage_km: number[] } }, km: number): LngLat {
  const c = route.geometry.coordinates;
  const marks = route.geometry.chainage_km;
  if (km <= marks[0]) return c[0];
  for (let i = 1; i < marks.length; i++) {
    if (km <= marks[i]) {
      const t = (km - marks[i - 1]) / (marks[i] - marks[i - 1]);
      return [c[i - 1][0] + t * (c[i][0] - c[i - 1][0]), c[i - 1][1] + t * (c[i][1] - c[i - 1][1])];
    }
  }
  return c[c.length - 1];
}

// ------------------------------------------------------------------ ground truth

export interface Piece { route_id: string; from_km: number; to_km: number; speed_kmph: number; note?: string }
export interface Incident { route_id: string; km: number; category: string; start: string; clear: string }
export interface Dwell { route_id: string; km: number; minutes: number }
export interface Branch { speed_profile: Piece[]; incidents: Incident[]; dwells: Dwell[] }
export interface Breakpoint { t: number; route_id: string; km: number }

/**
 * Replay one branch: drive each piece in order. On reaching an incident's km while it is
 * active (start <= t < clear) wait until clear; on reaching a dwell km stop for the dwell.
 * Returns breakpoints in minutes after departure.
 */
export function simulateBranch(branch: Branch, departure: string): Breakpoint[] {
  let t = 0;
  const first = branch.speed_profile[0];
  const out: Breakpoint[] = [{ t, route_id: first.route_id, km: first.from_km }];
  for (const piece of branch.speed_profile) {
    let km = piece.from_km;
    const inPiece = (r: string, k: number) => r === piece.route_id && piece.from_km < k && k <= piece.to_km;
    const stops = [
      ...branch.incidents.filter((i) => inPiece(i.route_id, i.km)).map((i) => ({ km: i.km, incident: i, dwell: null as Dwell | null })),
      ...branch.dwells.filter((d) => inPiece(d.route_id, d.km)).map((d) => ({ km: d.km, incident: null as Incident | null, dwell: d })),
    ].sort((a, b) => a.km - b.km);
    for (const stop of [...stops, { km: piece.to_km, incident: null, dwell: null }]) {
      t += ((stop.km - km) / piece.speed_kmph) * 60;
      km = stop.km;
      out.push({ t, route_id: piece.route_id, km });
      if (stop.incident) {
        const start = minutesBetween(departure, stop.incident.start);
        const clear = minutesBetween(departure, stop.incident.clear);
        if (start <= t && t < clear) {
          t = clear;
          out.push({ t, route_id: piece.route_id, km });
        }
      } else if (stop.dwell) {
        t += stop.dwell.minutes;
        out.push({ t, route_id: piece.route_id, km });
      }
    }
  }
  // Drop zero-length repeats (piece boundaries produce the same point twice).
  return out.filter((p, i) => i === 0 || p.t !== out[i - 1].t || p.km !== out[i - 1].km);
}

export function positionAt(points: Breakpoint[], minutes: number): { route_id: string; km: number } {
  if (minutes <= points[0].t) return points[0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (minutes <= b.t) {
      return b.t === a.t ? b : { route_id: b.route_id, km: a.km + ((b.km - a.km) * (minutes - a.t)) / (b.t - a.t) };
    }
  }
  return points[points.length - 1];
}

export function timeAtKm(points: Breakpoint[], routeId: string, km: number): number {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (b.route_id === routeId && a.km <= km && km <= b.km && b.km > a.km) return a.t + ((b.t - a.t) * (km - a.km)) / (b.km - a.km);
  }
  throw new Error(`km ${km} on ${routeId} not reached`);
}

export interface Waypoint { at: string; km: number }
export interface GroundTruth { deliver_after_min: number; common: Waypoint[]; branches: Record<string, Waypoint[]> }

/**
 * Turn per-branch speed profiles into the API's waypoint format: `common` up to the
 * branch km (where the alternative leaves), then one waypoint list per route.
 * Every branch must reach branch_km at the same time.
 */
export function waypointsFromProfiles(
  departure: string,
  branchKm: number,
  baseRouteId: string,
  branches: Record<string, Branch>,
  deliverAfterMin: number,
): GroundTruth {
  let common: Waypoint[] | null = null;
  const out: Record<string, Waypoint[]> = {};
  for (const [routeId, branch] of Object.entries(branches)) {
    const pts = simulateBranch(branch, departure);
    const tSplit = timeAtKm(pts, baseRouteId, branchKm);
    const before = pts.filter((p) => p.t < tSplit).map((p) => ({ at: addMin(departure, p.t), km: round(p.km, 3) }));
    before.push({ at: addMin(departure, tSplit), km: branchKm });
    const after = pts.filter((p) => p.t > tSplit).map((p) => ({ at: addMin(departure, p.t), km: round(p.km, 3) }));
    if (common && JSON.stringify(common) !== JSON.stringify(before)) throw new Error(`branches disagree before km ${branchKm}`);
    common = before;
    out[routeId] = after;
  }
  return { deliver_after_min: deliverAfterMin, common: common!, branches: out };
}
