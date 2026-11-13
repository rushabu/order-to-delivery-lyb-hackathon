// Live route weather from Open-Meteo (https://open-meteo.com, free, no key, non-commercial use).
//
// Points are sampled every `sample_every_km` along each route. For each point we take the worst of the
// next `forecast_hours` of hourly forecast (most rain, lowest visibility, strongest wind) and grade it
// with the plain thresholds in database/seed/config.json. A route's suggested delay is the delay of its
// worst point. In demo mode this is an advisory only; in live mode it becomes an ETA factor.
import { pointAtKm, type LngLat } from '../shipments/geometry';

export type WeatherLevel = 'CLEAR' | 'MODERATE' | 'SEVERE';

export interface WeatherThreshold {
  precipitation_mm: number; // per hour, at or above
  visibility_m: number; // below
  wind_kmph: number; // at or above
  delay_min: number;
}

export interface WeatherConfig {
  sample_every_km: number;
  forecast_hours: number;
  refresh_min: number;
  moderate: WeatherThreshold;
  severe: WeatherThreshold;
}

/** Used when the seed has no weather block (for example the test stubs). Same values as the seed. */
export const DEFAULT_WEATHER_CONFIG: WeatherConfig = {
  sample_every_km: 40,
  forecast_hours: 3,
  refresh_min: 15,
  moderate: { precipitation_mm: 1, visibility_m: 5000, wind_kmph: 35, delay_min: 10 },
  severe: { precipitation_mm: 4, visibility_m: 1000, wind_kmph: 50, delay_min: 30 },
};

export interface Reading {
  precipitation_mm: number;
  visibility_m: number;
  wind_kmph: number;
  weather_code: number;
}

export interface PointReport extends Reading {
  km: number;
  lat: number;
  lng: number;
  level: WeatherLevel;
  reasons: string[];
}

export interface RouteWeatherReport {
  route_id: string;
  route_name: string;
  level: WeatherLevel;
  suggested_delay_min: number;
  worst: { km: number; reasons: string[] } | null;
  points: PointReport[];
}

export interface WeatherSnapshot {
  status: 'OK' | 'UNAVAILABLE';
  fetched_at: string | null;
  routes: RouteWeatherReport[];
  error: string | null;
}

/** Grade one point. Pure: same reading and config, same answer. */
export function assessPoint(r: Reading, cfg: WeatherConfig): { level: WeatherLevel; reasons: string[] } {
  const reasonsFor = (t: WeatherThreshold) => [
    ...(r.precipitation_mm >= t.precipitation_mm ? [`rain ${r.precipitation_mm} mm/h`] : []),
    ...(r.visibility_m < t.visibility_m ? [`visibility ${Math.round(r.visibility_m)} m`] : []),
    ...(r.wind_kmph >= t.wind_kmph ? [`wind ${Math.round(r.wind_kmph)} km/h`] : []),
  ];
  const severe = reasonsFor(cfg.severe);
  if (severe.length) return { level: 'SEVERE', reasons: severe };
  const moderate = reasonsFor(cfg.moderate);
  if (moderate.length) return { level: 'MODERATE', reasons: moderate };
  return { level: 'CLEAR', reasons: [] };
}

const RANK: Record<WeatherLevel, number> = { CLEAR: 0, MODERATE: 1, SEVERE: 2 };

/** A route takes its worst point's level and delay. */
export function assessRoute(points: PointReport[], cfg: WeatherConfig): Pick<RouteWeatherReport, 'level' | 'suggested_delay_min' | 'worst'> {
  const worst = points.reduce<PointReport | null>((w, p) => (!w || RANK[p.level] > RANK[w.level] ? p : w), null);
  const level = worst?.level ?? 'CLEAR';
  return {
    level,
    suggested_delay_min: level === 'SEVERE' ? cfg.severe.delay_min : level === 'MODERATE' ? cfg.moderate.delay_min : 0,
    worst: worst && level !== 'CLEAR' ? { km: worst.km, reasons: worst.reasons } : null,
  };
}

export interface WeatherRoute {
  id: string;
  name: string;
  total_km: number;
  geometry: { coordinates: LngLat[]; chainage_km?: number[] } | null;
}

/** Sample points every `every` km plus the destination. */
export function samplePoints(route: WeatherRoute, every: number): { km: number; lat: number; lng: number }[] {
  if (!route.geometry) return [];
  const kms: number[] = [];
  for (let km = 0; km < route.total_km; km += every) kms.push(km);
  kms.push(route.total_km);
  return kms.map((km) => {
    const [lng, lat] = pointAtKm(route.geometry!.coordinates, route.total_km, km, route.geometry!.chainage_km);
    return { km, lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4 };
  });
}

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

interface OpenMeteoPoint {
  hourly: { time: string[]; precipitation: number[]; visibility: number[]; wind_speed_10m: number[]; weather_code: number[] };
}

/** Worst reading over the next `hours` hours of one point's hourly forecast. */
export function worstReading(p: OpenMeteoPoint, hours: number): Reading {
  const h = p.hourly;
  const n = Math.min(hours, h.time.length);
  const slice = <T>(a: T[]) => a.slice(0, n);
  return {
    precipitation_mm: Math.max(0, ...slice(h.precipitation).map((x) => x ?? 0)),
    visibility_m: Math.min(...slice(h.visibility).map((x) => x ?? 99_999)),
    wind_kmph: Math.max(0, ...slice(h.wind_speed_10m).map((x) => x ?? 0)),
    weather_code: Math.max(0, ...slice(h.weather_code).map((x) => x ?? 0)),
  };
}

/** Fetches and caches route weather. One Open-Meteo request covers every point of every route. */
export class RouteWeather {
  private snapshot: WeatherSnapshot = { status: 'UNAVAILABLE', fetched_at: null, routes: [], error: 'Not fetched yet' };
  private inFlight: Promise<WeatherSnapshot> | null = null;

  constructor(
    private readonly routes: () => WeatherRoute[],
    readonly cfg: WeatherConfig,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly wallClock: () => number = () => Date.now(),
  ) {}

  current(): WeatherSnapshot {
    return this.snapshot;
  }

  forRoute(routeId: string): RouteWeatherReport | undefined {
    return this.snapshot.status === 'OK' ? this.snapshot.routes.find((r) => r.route_id === routeId) : undefined;
  }

  isFresh(): boolean {
    const at = this.snapshot.fetched_at;
    if (at === null || this.wallClock() - Date.parse(at) >= this.cfg.refresh_min * 60_000) return false;
    const routes = this.routes().filter((route) => route.geometry);
    return routes.length === this.snapshot.routes.length && routes.every((route) => this.snapshot.routes.some((cached) => cached.route_id === route.id));
  }

  /** Refresh unless fresh. Concurrent callers share one request. Never throws. */
  async refresh(force = false): Promise<WeatherSnapshot> {
    if (!force && this.isFresh()) return this.snapshot;
    this.inFlight ??= this.load().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private async load(): Promise<WeatherSnapshot> {
    const routes = this.routes().filter((r) => r.geometry);
    const sampled = routes.map((r) => ({ route: r, points: samplePoints(r, this.cfg.sample_every_km) }));
    const all = sampled.flatMap((s) => s.points);
    if (!all.length) return this.snapshot;
    const url =
      `${OPEN_METEO}?latitude=${all.map((p) => p.lat).join(',')}&longitude=${all.map((p) => p.lng).join(',')}` +
      `&hourly=precipitation,visibility,wind_speed_10m,weather_code&forecast_hours=${this.cfg.forecast_hours}&timezone=GMT`;
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
      const body = (await res.json()) as OpenMeteoPoint | OpenMeteoPoint[];
      const list = Array.isArray(body) ? body : [body];
      if (list.length !== all.length) throw new Error('Open-Meteo returned an unexpected number of points');
      let i = 0;
      const reports: RouteWeatherReport[] = sampled.map(({ route, points }) => {
        const pts: PointReport[] = points.map((p) => {
          const reading = worstReading(list[i++], this.cfg.forecast_hours);
          return { ...p, ...reading, ...assessPoint(reading, this.cfg) };
        });
        return { route_id: route.id, route_name: route.name, points: pts, ...assessRoute(pts, this.cfg) };
      });
      this.snapshot = { status: 'OK', fetched_at: new Date(this.wallClock()).toISOString(), routes: reports, error: null };
    } catch (e) {
      // Keep the last good routes (if any) but say the latest fetch failed.
      this.snapshot = { ...this.snapshot, status: this.snapshot.routes.length ? 'OK' : 'UNAVAILABLE', error: (e as Error).message };
    }
    return this.snapshot;
  }
}
