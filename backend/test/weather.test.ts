// Live route weather (Open-Meteo): grading rules, the cache, the endpoint, and the live-mode ETA factor.
// fetch is stubbed: these tests never call the real API.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeEta } from '../src/eta/computeEta';
import { buildEtaState, getShipment } from '../src/shipments/repo';
import { REAL_FIXTURES_DIR } from '../src/sim/fixtures';
import { DEFAULT_WEATHER_CONFIG as CFG, RouteWeather, assessPoint, assessRoute, samplePoints, type PointReport } from '../src/weather/weather';
import { COORD, makeApp, T, type TestApp } from './helpers';

const clear = { precipitation_mm: 0, visibility_m: 15000, wind_kmph: 8, weather_code: 0 };

/** A fake Open-Meteo answer: every point clear except `bad` points with heavy rain. */
function fakeOpenMeteo(bad: (index: number) => boolean) {
  return vi.fn(async (url: string | URL | Request) => {
    const n = new URL(String(url)).searchParams.get('latitude')!.split(',').length;
    const body = Array.from({ length: n }, (_, i) => ({
      hourly: {
        time: ['t0', 't1', 't2'],
        precipitation: bad(i) ? [2, 6, 3] : [0, 0, 0],
        visibility: [15000, 14000, 15000],
        wind_speed_10m: [8, 9, 7],
        weather_code: bad(i) ? [61, 65, 63] : [0, 0, 0],
      },
    }));
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

describe('grading rules', () => {
  it('grades a point by the worst threshold it crosses', () => {
    expect(assessPoint(clear, CFG)).toEqual({ level: 'CLEAR', reasons: [] });
    expect(assessPoint({ ...clear, precipitation_mm: 2 }, CFG)).toEqual({ level: 'MODERATE', reasons: ['rain 2 mm/h'] });
    expect(assessPoint({ ...clear, precipitation_mm: 5, visibility_m: 600 }, CFG)).toEqual({ level: 'SEVERE', reasons: ['rain 5 mm/h', 'visibility 600 m'] });
    expect(assessPoint({ ...clear, wind_kmph: 40 }, CFG).level).toBe('MODERATE');
  });

  it('a route takes its worst point and that level of delay', () => {
    const pt = (km: number, level: PointReport['level']): PointReport => ({ km, lat: 0, lng: 0, ...clear, level, reasons: level === 'CLEAR' ? [] : ['x'] });
    expect(assessRoute([pt(0, 'CLEAR'), pt(40, 'MODERATE'), pt(80, 'SEVERE')], CFG)).toEqual({ level: 'SEVERE', suggested_delay_min: 30, worst: { km: 80, reasons: ['x'] } });
    expect(assessRoute([pt(0, 'CLEAR')], CFG)).toEqual({ level: 'CLEAR', suggested_delay_min: 0, worst: null });
  });
});

describe('RouteWeather cache', () => {
  const route = { id: 'R', name: 'Road', total_km: 100, geometry: { coordinates: [[73, 19], [74, 19]] as [number, number][] } };

  it('samples every 40 km plus the end, and grades from one request', async () => {
    expect(samplePoints(route, 40).map((p) => p.km)).toEqual([0, 40, 80, 100]);
    const f = fakeOpenMeteo((i) => i === 2);
    const w = new RouteWeather(() => [route], CFG, f as unknown as typeof fetch);
    const s = await w.refresh();
    expect(f).toHaveBeenCalledTimes(1);
    expect(s.status).toBe('OK');
    expect(s.routes[0]).toMatchObject({ level: 'SEVERE', suggested_delay_min: 30, worst: { km: 80, reasons: ['rain 6 mm/h'] } });
    await w.refresh(); // fresh: no second request
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a failed request is reported, never thrown', async () => {
    const w = new RouteWeather(() => [route], CFG, (async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(await w.refresh()).toMatchObject({ status: 'UNAVAILABLE', error: 'offline' });
    expect(w.forRoute('R')).toBeUndefined();
  });
});

describe('endpoint and ETA on the real seed', () => {
  let t: TestApp;
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t?.close();
  });

  it('GET /weather/routes is an advisory in demo mode and leaves the scripted ETAs alone', async () => {
    vi.stubGlobal('fetch', fakeOpenMeteo(() => true));
    t = await makeApp({}, REAL_FIXTURES_DIR);
    const c = await t.login(COORD);
    const r = await t.req('GET', '/weather/routes', c);
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe('ADVISORY');
    expect(r.body.routes.map((x: any) => x.route_id).sort()).toEqual(['RTE-01', 'RTE-01B', 'RTE-02', 'RTE-02B']);
    expect(r.body.routes[0].level).toBe('SEVERE');
    await t.req('POST', '/demo/scenarios/main/start', c);
    t.advanceTo(T['09:15']);
    const s = (await t.req('GET', '/shipments/SHP-1001', c)).body;
    expect(s.current_eta.eta).toBe('2026-11-16T06:15:00Z'); // still 11:45: no forecast factor in demo mode
    expect((await t.req('GET', '/weather/routes', await t.login('USR-DRV-01'))).status).toBe(403);
  });

  it('live mode: a forecast ahead becomes its own ETA factor, and a driver weather report replaces it', async () => {
    t = await makeApp({}, REAL_FIXTURES_DIR);
    const db = t.ctx.db;
    const s = getShipment(db, 'SHP-1001')!;
    const cfg = t.ctx.fixtures.config.eta;
    const now = T['08:50'];
    const base = computeEta(buildEtaState(db, s, now, cfg), now, cfg, 'EVENT');
    const forecast = { minutes: 30, at_km: 120, reasons: ['rain 6 mm/h'] };
    const withFc = computeEta(buildEtaState(db, s, now, cfg, forecast), now, cfg, 'EVENT');
    expect(withFc.factors.find((f) => f.code === 'WEATHER_FORECAST')).toEqual({
      code: 'WEATHER_FORECAST', label: 'Forecast near km 120: rain 6 mm/h (Open-Meteo)', minutes: 30,
    });
    expect(Date.parse(withFc.eta) - Date.parse(base.eta)).toBe(30 * 60_000);
    // A driver's weather report replaces the forecast, so the weather is not counted twice.
    const reported = buildEtaState(db, s, now, cfg, forecast);
    reported.disruptions = [{ id: 'd1', route_id: 'RTE-01', category: 'WEATHER', at_km: 120, expected_delay_min: 45, estimate_source: 'DRIVER', reported_at: now }];
    const withReport = computeEta(reported, now, cfg, 'EVENT');
    expect(withReport.factors.some((f) => f.code === 'WEATHER_FORECAST')).toBe(false);
    expect(withReport.factors.some((f) => f.code === 'WEATHER')).toBe(true);
    // Behind the truck: ignored.
    const behind = computeEta(buildEtaState(db, s, now, cfg, { ...forecast, at_km: 10 }), now, cfg, 'EVENT');
    expect(behind.factors.some((f) => f.code === 'WEATHER_FORECAST')).toBe(false);
  });
});
