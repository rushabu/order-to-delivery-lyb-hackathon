import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatedPlan } from '../src/liveRouting/scenarios';
import { getShipment } from '../src/shipments/repo';
import { loadFixtures, REAL_FIXTURES_DIR } from '../src/sim/fixtures';
import { COORD, CUST1, DRIVER1, makeApp, uuid } from './helpers';

const KEY = 'fake-test-key';
const startPreset = (preset_id = 'ranjangaon-standard') => ({ preset_id, request_id: uuid() });
const origin = { latitude: 19, longitude: 73 };
const junction = { latitude: 19.2, longitude: 73.4 };
const destination = { latitude: 19.5, longitude: 74 };
const bypass = { latitude: 19.5, longitude: 73.6 };

function route(points: (typeof origin)[], drive: number, delay: number, alternate = false) {
  return {
    summary: {
      lengthInMeters: alternate ? 116_000 : 110_000,
      travelTimeInSeconds: drive * 60,
      noTrafficTravelTimeInSeconds: 110 * 60,
      trafficDelayInSeconds: delay * 60,
      ...(alternate ? { deviationPoint: junction } : {}),
    },
    legs: [{ points }],
    sections: delay > 0 ? [{ sectionType: 'TRAFFIC', simpleCategory: 'JAM', startPointIndex: 1, endPointIndex: 2 }] : [],
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('live truck routing demo', () => {
  it('previews EV charging for Mumbai drafts without starting a shipment', async () => {
    const provider = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.pathname).toContain('/calculateLongDistanceEVRoute/');
      expect(init.method).toBe('POST');
      expect(url.searchParams.get('vehicleWeight')).toBe('2700');
      expect(url.searchParams.get('minChargeAtDestinationInkWh')).toBe('8');
      expect(url.searchParams.get('currentChargeInkWh')).toBe('10');
      expect(JSON.parse(String(init.body)).chargingModes).toHaveLength(1);
      return Response.json({ routes: [{
        summary: { lengthInMeters: 19638, travelTimeInSeconds: 3755, totalChargingTimeInSeconds: 604,
          batteryConsumptionInkWh: 4.8948, remainingChargeAtArrivalInkWh: 9.3242 },
        legs: [{ summary: { chargingInformationAtEndOfLeg: { chargingParkName: 'Demo charger', chargingTimeInSeconds: 604 } } }, { summary: {} }],
      }] });
    });
    vi.stubGlobal('fetch', provider);
    const t = await makeApp({ tomTomApiKey: KEY }, REAL_FIXTURES_DIR);
    try {
      const coordinator = await t.login(COORD);
      const driver = await t.login(DRIVER1);
      const path = '/demo/live-route/ev-preview';
      const input = { preset_id: 'kandivali-vikhroli', start_charge_pct: 25 };
      expect((await t.req('POST', path, driver, input)).status).toBe(403);
      expect((await t.req('POST', path, coordinator, { ...input, start_charge_pct: 101 })).status).toBe(422);
      expect((await t.req('POST', path, coordinator, { ...input, preset_id: 'ranjangaon-standard' })).status).toBe(422);
      expect(provider).not.toHaveBeenCalled();

      const preview = await t.req('POST', path, coordinator, input);
      expect(preview.status).toBe(200);
      expect(preview.body).toEqual({
        distance_km: 19.6, travel_min: 63, charging_min: 11, consumption_kwh: 4.9, arrival_charge_pct: 23,
        reserve_pct: 20, battery_kwh: 40, stops: [{ name: 'Demo charger', charging_min: 11 }],
      });
      expect((await t.req('GET', '/demo/live-route', coordinator)).body).toMatchObject({ available_drivers: 3, shipments: [] });
      provider.mockResolvedValueOnce(Response.json({ detailedError: { code: 'NO_ROUTE_FOUND' } }, { status: 400 }));
      expect((await t.req('POST', path, coordinator, input)).body.error.code).toBe('EV_NO_ROUTE');
    } finally { await t.close(); }
  });

  it('shares route-matched traffic with the customer and handles independent feed failures', async () => {
    let now = Date.parse('2026-11-12T10:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const road = [73, 73.025, 73.05, 73.075, 73.1].map((longitude) => ({ longitude, latitude: 19 }));
    const matched = { ...route(road, 20, 0), summary: { ...route(road, 20, 0).summary, lengthInMeters: 10_000 } };
    let flowUnavailable = false;
    const provider = vi.fn(async (url: URL) => {
      if (url.pathname.includes('/calculateRoute/')) return Response.json({ routes: [matched] });
      if (url.pathname.endsWith('/incidentDetails')) {
        const incident = (id: string, latitude: number) => ({
          geometry: { type: 'Point', coordinates: [73.06, latitude] },
          properties: { id, iconCategory: 8, delay: 300 },
        });
        return Response.json({ incidents: [incident('near', 19), incident('elsewhere', 19.015)] });
      }
      expect(url.pathname).toContain('/flowSegmentData/');
      if (flowUnavailable) return new Response(null, { status: 503 });
      return Response.json({ flowSegmentData: {
        currentSpeed: 20, freeFlowSpeed: 60, roadClosure: false,
        coordinates: { coordinate: [...road, { longitude: 73.13, latitude: 19.04 }] },
      } });
    });
    vi.stubGlobal('fetch', provider);
    const t = await makeApp({ tomTomApiKey: KEY }, REAL_FIXTURES_DIR);
    try {
      const coordinator = await t.login(COORD);
      const customer = await t.login('USR-CUST-04');
      const other = await t.login(CUST1);
      const started = await t.req('POST', '/demo/live-route/start', coordinator, startPreset('kandivali-vikhroli'));
      expect(started.status).toBe(200);
      const shipment = `/shipments/${started.body.shipment_id}`;
      const path = `${shipment}/road-conditions`;
      const before = (await t.req('GET', shipment, customer)).body;
      expect((await t.req('GET', path)).status).toBe(401);
      expect((await t.req('GET', path, other)).status).toBe(404);
      expect(provider).toHaveBeenCalledTimes(1);

      const snapshot = await t.req('GET', path, coordinator);
      expect(snapshot.status).toBe(200);
      expect(snapshot.body).toMatchObject({
        route_id: before.active_route_id, horizon_km: 10, flow_status: 'LIVE', incidents_status: 'LIVE',
        flow: [{ condition: 'HEAVY', coordinates: road.map(({ longitude, latitude }) => [longitude, latitude]), current_kph: 20, free_flow_kph: 60 }],
        incidents: [{ id: 'near', category: 'Road closed', delay_min: 5, at_km: 6 }],
      });
      expect((await t.req('GET', path, customer)).body).toEqual(snapshot.body);
      expect(provider).toHaveBeenCalledTimes(5);
      expect((await t.req('GET', shipment, customer)).body.current_eta).toEqual(before.current_eta);

      now += 120_001;
      flowUnavailable = true;
      expect((await t.req('GET', path, customer)).body).toMatchObject({
        flow_status: 'UNAVAILABLE', incidents_status: 'LIVE', flow: [], incidents: [{ id: 'near' }],
      });
      expect(provider).toHaveBeenCalledTimes(9);
    } finally { await t.close(); }
  });

  it('requires a configured server key and coordinator role', async () => {
    const t = await makeApp({}, REAL_FIXTURES_DIR);
    try {
      const c = await t.login(COORD);
      const d = await t.login(DRIVER1);
      const state = (await t.req('GET', '/demo/live-route', c)).body;
      expect(state).toMatchObject({ configured: false, available_drivers: 3, shipments: [] });
      expect(state.presets.map((draft: { quantity_t: number; gross_t: number }) => [draft.quantity_t, draft.gross_t])).toEqual([[0.6, 2.7], [0.8, 2.9], [24, 34], [28, 40], [8, 15]]);
      const generated = await t.req('GET', '/demo/live-route/generate?seed=42', c);
      expect(generated.status).toBe(200);
      expect((await t.req('GET', '/demo/live-route/generate?seed=42', c)).body).toEqual(generated.body);
      const mumbai = await t.req('GET', '/demo/live-route/generate?seed=42&area=mumbai', c);
      expect(mumbai.body).toMatchObject({ area: 'mumbai', seed: 42, vehicle: { label: 'Delivery van' } });
      expect((await t.req('GET', '/demo/live-route/generate?seed=42&area=mumbai', c)).body).toEqual(mumbai.body);
      expect((await t.req('GET', '/demo/live-route/generate?seed=-1', c)).status).toBe(422);
      expect((await t.req('POST', '/demo/live-route/start', d)).status).toBe(403);
      expect((await t.req('POST', '/demo/live-route/start', c, startPreset())).status).toBe(503);
    } finally { await t.close(); }
  });

  it('routes a fictional shipment, updates the customer ETA, approves a faster route, and falls back on provider failure', async () => {
    let now = Date.parse('2026-11-12T10:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let unavailable = false;
    const provider = vi.fn(async (input: URL, init?: RequestInit) => {
      expect(input.hostname).toBe('api.tomtom.com');
      expect(input.searchParams.get('key')).toBe(KEY);
      expect(input.searchParams.get('travelMode')).toBe('truck');
      expect(input.searchParams.get('vehicleWeight')).toBe('34000');
      if (unavailable) return new Response(null, { status: 503 });
      if (init?.method !== 'POST') return Response.json({ routes: [route([origin, junction, destination], 110, 0), route([origin, junction, bypass, destination], 115, 5, true)] });
      expect(input.searchParams.get('reconstructionMode')).toBe('strict');
      const { supportingPoints } = JSON.parse(String(init.body));
      expect(supportingPoints.at(-1)).toEqual(destination);
      const alternate = supportingPoints.some((p: typeof origin) => p.longitude === bypass.longitude);
      return Response.json({ routes: [route(supportingPoints, alternate ? 112 : 145, alternate ? 2 : 35, alternate)] });
    });
    vi.stubGlobal('fetch', provider);
    const t = await makeApp({ tomTomApiKey: KEY }, REAL_FIXTURES_DIR);
    try {
      const c = await t.login(COORD);
      const customer = await t.login(CUST1);
      const other = await t.login('USR-CUST-03');
      const request = startPreset();
      const started = await t.req('POST', '/demo/live-route/start', c, request);
      expect(started.status).toBe(200);
      const id = started.body.shipment_id;
      const shipment = `/shipments/${id}`;
      const refresh = `/demo/live-route/${id}/refresh`;
      expect((await t.req('POST', '/demo/live-route/start', c, request)).body.shipment_id).toBe(id);
      expect(provider).toHaveBeenCalledTimes(1);
      const original = (await t.req('GET', shipment, customer)).body;
      expect(original.status).toBe('IN_TRANSIT');
      expect(original.milestones.map((m: { status: string }) => m.status)).toEqual(['PLANNED', 'DISPATCHED', 'IN_TRANSIT']);
      expect(original.current_eta.eta).toBe('2026-11-12T12:05:00Z');
      expect(original.live_traffic).toMatchObject({ status: 'LIVE', drive_minutes: 110, traffic_delay_min: 0 });
      const geometry = (await t.req('GET', `/routes/${original.active_route_id}`, customer)).body.geometry;
      expect(geometry.coordinates[0]).toEqual([origin.longitude, origin.latitude]);
      expect((await t.req('GET', shipment, other)).status).toBe(404);

      now += 8000;
      t.ctx.liveRouteDemo!.tick();
      const moved = (await t.req('GET', shipment, customer)).body;
      expect(moved.last_position.progress_km - original.last_position.progress_km).toBeCloseTo(0.133, 2);
      expect((await t.req('POST', refresh, c)).status).toBe(200);
      const late = (await t.req('GET', shipment, customer)).body;
      expect(late.active_route_id).toBe(original.active_route_id);
      expect(late.current_eta).toMatchObject({ eta: '2026-11-12T12:40:08Z', risk_level: 'HIGH' });
      expect(late.live_traffic).toMatchObject({ traffic_delay_min: 35, sections: [{ category: 'JAM' }] });
      expect((await t.req('GET', '/notifications', customer)).body).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'RISK_HIGH', shipment_id: id }),
      ]));

      const options = (await t.req('GET', `/alerts/${late.open_alert.id}/options`, c)).body;
      const chosen = options.options.find((o: { id: string }) => o.id === options.recommended_option_id);
      expect(chosen).toMatchObject({ type: 'REROUTE', improvement_min: 33 });
      const decision = await t.req('POST', `${shipment}/decisions`, c, { decision_id: uuid(), option_id: chosen.id, option_set_id: options.id });
      expect(decision.status).toBe(201);
      const changed = (await t.req('GET', shipment, customer)).body;
      expect(changed.active_route_id).not.toBe(original.active_route_id);
      expect(changed.current_eta.eta).toBe(chosen.projected_eta);

      const driver = await t.login('USR-DRV-03');
      const disruptionId = uuid();
      expect((await t.req('POST', `${shipment}/events`, driver, {
        event_id: uuid(), type: 'DISRUPTION_REPORTED',
        payload: { disruption_id: disruptionId, category: 'ACCIDENT', at_km: 5, expected_delay_min: 20 },
      })).status).toBe(201);
      const reported = (await t.req('GET', shipment, customer)).body;
      expect(reported.current_eta.factors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ACCIDENT', minutes: 20 })]));

      unavailable = true;
      expect((await t.req('POST', refresh, c)).status).toBe(502);
      const stale = (await t.req('GET', shipment, customer)).body;
      expect(stale.live_traffic).toMatchObject({ status: 'STALE', traffic_delay_min: null, sections: [] });
      expect(stale.current_eta.confidence).toBe('LOW');
      expect((await t.req('POST', '/demo/reset', c)).status).toBe(200);
      expect((await t.req('GET', shipment, customer)).status).toBe(404);
    } finally { await t.close(); }
  });

  it('generates reproducible loads within the selected truck capacity', () => {
    const fixtures = loadFixtures(REAL_FIXTURES_DIR);
    const generated = Array.from({ length: 50 }, (_, seed) => generatedPlan(fixtures, seed)!.draft);
    for (const draft of generated) {
      expect(generatedPlan(fixtures, draft.seed!)!.draft).toEqual(draft);
      expect(draft.gross_t).toBe(draft.quantity_t + draft.vehicle.tare_t);
      expect(draft.gross_t).toBeLessThanOrEqual(draft.vehicle.max_gross_t);
    }
    expect(new Set(generated.map((draft) => draft.lane)).size).toBe(3);
    expect(new Set(generated.map((draft) => draft.quantity_t)).size).toBeGreaterThan(8);
    const city = Array.from({ length: 20 }, (_, seed) => generatedPlan(fixtures, seed, 'mumbai')!.draft);
    expect(new Set(city.map((draft) => draft.lane))).toEqual(new Set(['Kandivali → Vikhroli', 'Goregaon → Powai']));
    for (const draft of city) {
      expect(draft.gross_t).toBeCloseTo(draft.quantity_t + draft.vehicle.tare_t, 2);
      expect(draft.gross_t).toBeLessThanOrEqual(draft.vehicle.max_gross_t);
    }
  });

  it('starts independent routes with distinct drivers and sends each load and truck dimensions to TomTom', async () => {
    let now = Date.parse('2026-11-12T10:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const provider = vi.fn(async (input: URL) => {
      const [, , , , endpoints] = input.pathname.split('/');
      const points = endpoints.split(':').map((point) => {
        const [latitude, longitude] = point.split(',').map(Number);
        return { latitude, longitude };
      });
      return Response.json({ routes: [route(points, 110, 0)] });
    });
    vi.stubGlobal('fetch', provider);
    const t = await makeApp({ tomTomApiKey: KEY }, REAL_FIXTURES_DIR);
    try {
      const c = await t.login(COORD);
      const ranjangaon = await t.req('POST', '/demo/live-route/start', c, startPreset());
      const satpur = await t.req('POST', '/demo/live-route/start', c, startPreset('satpur-heavy'));
      const generated = await t.req('GET', '/demo/live-route/generate?seed=42', c);
      const third = await t.req('POST', '/demo/live-route/start', c, { seed: 42, request_id: uuid() });
      expect([ranjangaon.status, satpur.status, third.status]).toEqual([200, 200, 200]);
      expect(third.body.draft).toEqual(generated.body);
      const requests = provider.mock.calls.map(([url]) => url);
      expect(requests.map((url) => url.searchParams.get('vehicleWeight'))).toEqual(['34000', '40000', String(generated.body.gross_t * 1000)]);
      expect(requests[1].searchParams.get('vehicleLength')).toBe('16');
      expect(requests[0].pathname).not.toBe(requests[1].pathname);
      const full = (await t.req('GET', '/demo/live-route', c)).body;
      expect(new Set(full.shipments.map((trip: { driver_name: string }) => trip.driver_name)).size).toBe(3);
      expect(full.available_drivers).toBe(0);
      expect((await t.req('POST', '/demo/live-route/start', c, startPreset('chakan-light'))).status).toBe(409);

      now += 111 * 60_000;
      t.ctx.liveRouteDemo!.tick();
      expect((await t.req('GET', '/demo/live-route', c)).body.available_drivers).toBe(0);
      now += 25 * 60_000;
      t.ctx.liveRouteDemo!.tick();
      const finished = (await t.req('GET', '/demo/live-route', c)).body;
      expect(finished.available_drivers).toBe(3);
      expect(finished.shipments.every((trip: { status: string }) => trip.status === 'DELIVERED')).toBe(true);
      const chakan = await t.req('POST', '/demo/live-route/start', c, startPreset('chakan-light'));
      expect(chakan.status).toBe(200);
      expect(chakan.body.draft.lane).toContain('Chakan');
      expect(provider.mock.lastCall?.[0].searchParams.get('vehicleWeight')).toBe('15000');
    } finally { await t.close(); }
  });
});

describe('TomTom ETA for scripted and ordered shipments', () => {
  it('quotes the seeded bypass and recovers when TomTom cannot reconstruct the seed geometry', async () => {
    const provider = vi.fn(async (url: URL, init: RequestInit) => {
      if (init.method === 'POST') {
        return Response.json({ detailedError: { code: 'CANNOT_RESTORE_BASEROUTE' } }, { status: 400 });
      }
      expect(url.pathname.split('/').at(-2)?.split(':')).toHaveLength(5);
      return Response.json({ routes: [route([origin, junction, destination], 90, 20)] });
    });
    vi.stubGlobal('fetch', provider);
    const t = await makeApp({ tomTomApiKey: KEY }, REAL_FIXTURES_DIR);
    try {
      const coordinator = await t.login(COORD);
      const refreshed = await t.req('POST', '/shipments/SHP-1001/traffic/refresh', coordinator);
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.live_traffic.status).toBe('LIVE');
      const paths = provider.mock.calls.filter(([, init]) => init.method !== 'POST').map(([url]) => url.pathname);
      expect(new Set(paths).size).toBe(2);
      expect(paths).toHaveLength(2);
      const shipment = getShipment(t.ctx.db, 'SHP-1001')!;
      expect(t.ctx.routeTraffic?.drive(shipment, 'RTE-01B')?.minutes).toBe(90);
    } finally { await t.close(); }
  });

  it('uses TomTom drive time and traffic for SHP-1001 after a refresh, and baseline speeds before', async () => {
    const provider = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.searchParams.get('travelMode')).toBe('truck');
      expect(init.method).toBe('POST');
      return Response.json({ routes: [route([origin, junction, destination], 90, 20)] });
    });
    vi.stubGlobal('fetch', provider);
    const t = await makeApp({ tomTomApiKey: KEY }, REAL_FIXTURES_DIR);
    try {
      const c = await t.login(COORD);
      const before = (await t.req('GET', '/shipments/SHP-1001', c)).body;
      expect(provider).not.toHaveBeenCalled();
      expect(before.live_traffic.status).toBe('UNAVAILABLE');
      expect(before.current_eta.factors.map((f: { label: string }) => f.label)).not.toContain('Remaining drive estimate (TomTom)');

      expect((await t.req('POST', '/shipments/SHP-1001/traffic/refresh', await t.login(CUST1))).status).toBe(403);
      const after = await t.req('POST', '/shipments/SHP-1001/traffic/refresh', c);
      expect(after.status).toBe(200);
      expect(provider).toHaveBeenCalledTimes(2); // active route and the reachable bypass
      expect(after.body.live_traffic).toMatchObject({ status: 'LIVE', drive_minutes: 90, traffic_delay_min: 20 });
      const factors = after.body.current_eta.factors as { code: string; label: string; minutes: number }[];
      expect(factors).toContainEqual({ code: 'BASE_TRAVEL', label: 'Remaining drive estimate (TomTom)', minutes: 70 });
      expect(factors).toContainEqual({ code: 'CONGESTION', label: 'Live traffic delay (TomTom)', minutes: 20 });

      // Reset clears the quotes, so the seeded ETA goes back to baseline speeds until TomTom answers again.
      expect((await t.req('POST', '/demo/reset', c)).status).toBe(200);
      expect((await t.req('GET', '/shipments/SHP-1001', c)).body.live_traffic.status).toBe('UNAVAILABLE');
    } finally { await t.close(); }
  });
});
