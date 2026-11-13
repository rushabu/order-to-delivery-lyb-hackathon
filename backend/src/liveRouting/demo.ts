import { randomUUID } from 'node:crypto';
import type { Ctx } from '../ctx';
import { nextSeq } from '../db/db';
import type { LiveDrive } from '../eta/types';
import { ingestEvent } from '../events/ingest';
import { ApiError } from '../http/errors';
import type { EventRequest, EvPreviewInput, LiveRouteStart } from '../http/schemas';
import { haversineKm, kmMarks, pointAtKm, projectToKm, type LngLat } from '../shipments/geometry';
import { recomputeEta } from '../shipments/recompute';
import { getShipment } from '../shipments/repo';
import type { PendingHint } from '../stream/hub';
import { addMinutes, MIN_MS, toIso } from '../time';
import { calculateTruckRoutes, type TruckRoute } from './tomtom';
import { previewEvRoute } from './ev';
import { generatedPlan, LIVE_SHIPMENT_PREFIX, presetPlans, type DemoArea, type ShipmentDraft } from './scenarios';

const POSITION_MS = 8000;
const REFRESH_MS = 60_000;
const FRESH_MS = 2 * REFRESH_MS;

interface Path {
  id: string;
  coordinates: LngLat[];
  marks: number[];
  km: number;
  speed: number;
}

interface Quote {
  route: TruckRoute;
  fromKm: number;
  fetchedAt: string;
  affectedSpans: LiveDrive['affectedSpans'];
}

interface Trip {
  id: string;
  draft: ShipmentDraft;
  driverName: string;
  lastPositionMs: number;
  lastAttemptMs: number;
  refreshing: boolean;
}

function quoteFor(path: Path, route: TruckRoute, fromKm: number, fetchedAt: string): Quote {
  const affectedSpans = route.sections.flatMap(({ coordinates }) => {
    const start = projectToKm(path.coordinates, path.km, coordinates[0], path.marks);
    const end = projectToKm(path.coordinates, path.km, coordinates[coordinates.length - 1], path.marks);
    return start.offKm <= 0.5 && end.offKm <= 0.5 && end.km >= start.km ? [{ fromKm: start.km, toKm: end.km }] : [];
  });
  return { route, fromKm, fetchedAt, affectedSpans };
}

function pathFrom(route: TruckRoute, id: string): Path {
  const marks = kmMarks(route.coordinates, route.distanceKm);
  if (!marks.every(Number.isFinite)) throw new Error('TomTom returned an empty route geometry');
  return { id, coordinates: route.coordinates, marks, km: route.distanceKm, speed: route.distanceKm * 60 / route.freeFlowMinutes };
}

function alternativePath(route: TruckRoute, main: Path, id: string) {
  const fork = route.deviationPoint;
  if (!fork) return null;
  const baseIndex = main.coordinates.findIndex((p) => haversineKm(p, fork) < 0.02);
  const altIndex = route.coordinates.findIndex((p) => haversineKm(p, fork) < 0.02);
  if (baseIndex < 0 || baseIndex === main.coordinates.length - 1 || altIndex < 0 || altIndex === route.coordinates.length - 1) return null;
  const alt = pathFrom(route, id);
  const exitKm = main.marks[baseIndex];
  // Align distance along the shared road with the assigned route, then use the alternative's own distance.
  const suffix = alt.marks.slice(altIndex + 1).map((km) => exitKm + km - alt.marks[altIndex]);
  const path: Path = {
    ...alt,
    coordinates: [...main.coordinates.slice(0, baseIndex + 1), ...alt.coordinates.slice(altIndex + 1)],
    marks: [...main.marks.slice(0, baseIndex + 1), ...suffix],
    km: suffix[suffix.length - 1],
  };
  return { path, exitKm };
}

/** Fictional shipments with wall-clock ETAs and real-time simulated positions. */
export class LiveRouteDemo {
  private paths = new Map<string, Path>();
  private quotes = new Map<string, Quote>();
  private failedRoutes = new Set<string>();
  private trips = new Map<string, Trip>();
  private generation = 0;
  private starting = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly ctx: Ctx, private readonly autoTick: boolean) {}

  isLiveShipment(id: string) { return id.startsWith(`${LIVE_SHIPMENT_PREFIX}-`); }
  now() { return toIso(Date.now()); }

  state() {
    return {
      configured: Boolean(this.ctx.config.tomTomApiKey),
      presets: presetPlans(this.ctx.fixtures).map(({ draft }) => draft),
      available_drivers: this.availableDrivers().length,
      shipments: [...this.trips.values()].reverse().map((trip) => this.tripSummary(trip)),
    };
  }

  generate(seed?: number, area?: DemoArea) {
    const plan = generatedPlan(this.ctx.fixtures, seed, area);
    if (!plan) throw new ApiError(503, 'LIVE_ROUTING_SEED_REQUIRED', 'Start the API with the full database seed to generate shipments');
    return plan.draft;
  }

  private resolvePlan(input: Pick<LiveRouteStart, 'preset_id' | 'seed' | 'area'>) {
    const { fixtures } = this.ctx;
    const presets = presetPlans(fixtures);
    if (!presets.length) throw new ApiError(503, 'LIVE_ROUTING_SEED_REQUIRED', 'Start the API with the full database seed to use this shipment');
    const plan = input.seed !== undefined ? generatedPlan(fixtures, input.seed, input.area) : presets.find(({ draft }) => draft.preset_id === input.preset_id);
    if (!plan) throw new ApiError(422, 'LIVE_ROUTING_UNKNOWN_PRESET', 'Choose one of the listed shipment presets');
    return plan;
  }

  previewEv(input: EvPreviewInput) {
    const key = this.ctx.config.tomTomApiKey;
    if (!key) throw new ApiError(503, 'LIVE_ROUTING_UNCONFIGURED', 'Set TOMTOM_API_KEY on the API server to preview EV routing');
    const { lane, draft } = this.resolvePlan(input);
    if (lane.area !== 'mumbai') throw new ApiError(422, 'EV_MUMBAI_ONLY', 'Choose a Mumbai delivery-van shipment for the EV preview');
    return previewEvRoute(key, lane, draft, input.start_charge_pct);
  }

  private tripSummary(trip: Trip) {
    return { shipment_id: trip.id, driver_name: trip.driverName, draft: trip.draft, status: getShipment(this.ctx.db, trip.id)!.status };
  }

  private availableDrivers() {
    // Busy: on a live trip, or holding a trip from a new order (SHP-2xxx) that is not finished yet.
    const assigned = this.ctx.db.prepare(`SELECT driver_user_id FROM shipments
      WHERE (id LIKE ? AND status IN ('IN_TRANSIT', 'ARRIVED'))
         OR (id LIKE 'SHP-2%' AND status IN ('PLANNED', 'DISPATCHED', 'IN_TRANSIT', 'ARRIVED'))`).all(`${LIVE_SHIPMENT_PREFIX}-%`) as { driver_user_id: string }[];
    const occupied = new Set(assigned.map((row) => row.driver_user_id));
    const scripted = new Set(this.ctx.fixtures.scenario.shipments.filter((s) => s.status === 'IN_TRANSIT').map((s) => s.driver_user_id));
    // Only the scenario's drivers run live demos; drivers with no scripted trip stay free for new orders.
    const cast = new Set(this.ctx.fixtures.scenario.shipments.map((s) => s.driver_user_id));
    return this.ctx.fixtures.users.filter((user) => user.role === 'DRIVER' && user.transporter_id && cast.has(user.id) && !occupied.has(user.id))
      .sort((a, b) => Number(scripted.has(a.id)) - Number(scripted.has(b.id)));
  }

  reset() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.generation++;
    this.starting = false;
    this.trips.clear();
    this.paths.clear();
    this.quotes.clear();
    this.failedRoutes.clear();
  }

  private quoteFresh(routeId: string, quote: Quote) {
    return !this.failedRoutes.has(routeId) && Date.now() - Date.parse(quote.fetchedAt) <= FRESH_MS;
  }

  drive(routeId: string, progressKm: number | null): LiveDrive | null {
    const quote = this.quotes.get(routeId);
    const path = this.paths.get(routeId);
    if (!path || !quote || progressKm === null || !this.quoteFresh(routeId, quote)) return null;
    if (progressKm >= path.km) return { minutes: 0, trafficMinutes: 0, affectedSpans: [] };
    // Between requests, scale the latest driving estimate to the distance still remaining.
    const remaining = Math.max(0, Math.min(1, (path.km - progressKm) / (path.km - quote.fromKm)));
    return { minutes: quote.route.driveMinutes * remaining, trafficMinutes: quote.route.trafficMinutes * remaining, affectedSpans: quote.affectedSpans };
  }

  traffic(routeId: string, progressKm: number | null) {
    const quote = this.quotes.get(routeId);
    const drive = this.drive(routeId, progressKm);
    return {
      source: 'TomTom' as const,
      status: drive ? 'LIVE' as const : quote ? 'STALE' as const : 'UNAVAILABLE' as const,
      fetched_at: quote?.fetchedAt ?? null,
      drive_minutes: drive ? Math.round(drive.minutes) : null,
      traffic_delay_min: drive ? Math.round(drive.trafficMinutes) : null,
      sections: drive && quote ? quote.route.sections : [],
    };
  }

  async start(input: LiveRouteStart) {
    const suffix = Buffer.from(input.request_id.replaceAll('-', ''), 'hex').toString('base64url');
    const shipmentId = `${LIVE_SHIPMENT_PREFIX}-${suffix}`;
    const existing = this.trips.get(shipmentId);
    if (existing) return this.tripSummary(existing);
    const key = this.ctx.config.tomTomApiKey;
    if (!key) throw new ApiError(503, 'LIVE_ROUTING_UNCONFIGURED', 'Set TOMTOM_API_KEY on the API server to start this shipment');
    if (this.starting) throw new ApiError(409, 'LIVE_ROUTING_BUSY', 'A new truck route is already being calculated');
    const { db } = this.ctx;
    const { lane, draft } = this.resolvePlan(input);
    const [driver] = this.availableDrivers();
    if (!driver) throw new ApiError(409, 'LIVE_ROUTING_NO_DRIVER', 'All live-demo drivers are on trips. Wait for a delivery or reset the demo');

    const run = this.generation;
    this.starting = true;
    try {
      let mainRoute: TruckRoute;
      let alternative: TruckRoute | undefined;
      try {
        [mainRoute, alternative] = await calculateTruckRoutes(key, lane.origin, lane.destination, draft.gross_t, draft.vehicle);
      } catch {
        throw new ApiError(502, 'LIVE_ROUTING_UNAVAILABLE', 'TomTom could not calculate the truck route. Check the server key and try again');
      }
      if (run !== this.generation) throw new ApiError(409, 'LIVE_ROUTING_RESET', 'The demo was reset while loading the route');
      const main = pathFrom(mainRoute, `LIVE-${suffix}`);
      const alt = alternative && alternativePath(alternative, main, `${main.id}-ALT`);
      const now = this.now();
      const promise = addMinutes(now, Math.round(mainRoute.freeFlowMinutes) + draft.stop_min + draft.promise_buffer_min);
      this.paths.set(main.id, main);
      this.quotes.set(main.id, quoteFor(main, mainRoute, 0, now));
      if (alt && alternative) {
        this.paths.set(alt.path.id, alt.path);
        this.quotes.set(alt.path.id, quoteFor(alt.path, alternative, 0, now));
      }
      const hints: PendingHint[] = [];
      const createShipment = db.transaction(() => {
        const insertPath = (p: Path, label: string) => {
          db.prepare('INSERT INTO routes (id, name, origin, destination, total_km, geometry) VALUES (?, ?, ?, ?, ?, ?)').run(
            p.id, label, lane.origin_name, lane.destination_name, p.km,
            JSON.stringify({ type: 'LineString', coordinates: p.coordinates, chainage_km: p.marks }),
          );
          db.prepare('INSERT INTO route_segments VALUES (?, 1, 0, ?, ?, ?)').run(p.id, p.km, p.speed, draft.stop_min);
        };
        insertPath(main, 'Live truck route');
        if (alt) {
          insertPath(alt.path, 'Live truck alternative');
          db.prepare('INSERT INTO route_alternatives VALUES (?, ?, ?)').run(main.id, alt.path.id, alt.exitKm);
        }
        const sequence = nextSeq(db, 'LIVE_VEHICLE');
        const orderId = `ORD-LIVE-${String(sequence).padStart(3, '0')}`;
        const registration = `MH 99 LD ${String(sequence).padStart(4, '0')}`;
        db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)').run(orderId, lane.customer_id, draft.product, draft.quantity_t, promise, promise);
        db.prepare(`INSERT INTO shipments (id, order_id, transporter_id, driver_user_id, vehicle_reg, quantity_t, gross_t,
          status, planned_route_id, active_route_id, planned_departure, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?, ?, ?)`)
          .run(shipmentId, orderId, driver.transporter_id, driver.id, registration, draft.quantity_t, draft.gross_t, main.id, main.id, now, now);
        this.post(shipmentId, { type: 'MILESTONE', payload: { to_status: 'DISPATCHED' } }, hints);
        this.post(shipmentId, { type: 'MILESTONE', payload: { to_status: 'IN_TRANSIT' } }, hints);
        const [lng, lat] = main.coordinates[0];
        this.post(shipmentId, { type: 'POSITION', payload: { lat, lng } }, hints);
      });
      try {
        createShipment();
      } catch (error) {
        for (const id of [main.id, alt && alt.path.id]) {
          if (!id) continue;
          this.paths.delete(id);
          this.quotes.delete(id);
        }
        throw error;
      }
      const startedAt = Date.now();
      const trip = { id: shipmentId, draft, driverName: driver.name, lastPositionMs: startedAt, lastAttemptMs: startedAt, refreshing: false };
      this.trips.set(shipmentId, trip);
      if (this.autoTick && !this.timer) this.timer = setInterval(() => this.tick(), POSITION_MS);
      this.ctx.hub.publish(hints);
      return this.tripSummary(trip);
    } finally {
      if (run === this.generation) this.starting = false;
    }
  }

  tick() {
    let running = false;
    const now = Date.now();
    for (const trip of this.trips.values()) {
      const shipment = getShipment(this.ctx.db, trip.id);
      if (shipment?.status === 'ARRIVED' && shipment.arrived_at) {
        const unloadMs = trip.draft.stop_min * MIN_MS;
        if (now - Date.parse(shipment.arrived_at) >= unloadMs) this.post(trip.id, { type: 'MILESTONE', payload: { to_status: 'DELIVERED' } });
        else running = true;
      }
      if (shipment?.status !== 'IN_TRANSIT') continue;
      running = true;
      const path = this.paths.get(shipment.active_route_id)!;
      const progress = shipment.last_progress_km ?? 0;
      const driving = this.drive(path.id, progress);
      // Advance at the average speed implied by the latest traffic-aware estimate.
      const kmPerMinute = driving && driving.minutes > 0 ? (path.km - progress) / driving.minutes : path.speed / 60;
      const km = Math.min(path.km, progress + kmPerMinute * (now - trip.lastPositionMs) / MIN_MS);
      const [lng, lat] = pointAtKm(path.coordinates, path.km, km, path.marks);
      trip.lastPositionMs = now;
      this.post(trip.id, { type: 'POSITION', payload: { lat, lng } });
      if (km >= path.km) this.post(trip.id, { type: 'MILESTONE', payload: { to_status: 'ARRIVED' } });
      else if (!trip.refreshing && now - trip.lastAttemptMs >= REFRESH_MS) void this.refresh(trip.id).catch(() => undefined);
    }
    if (!running) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async refresh(shipmentId: string) {
    const { db } = this.ctx;
    const key = this.ctx.config.tomTomApiKey;
    const trip = this.trips.get(shipmentId);
    const shipment = getShipment(db, shipmentId);
    if (!key || !trip || shipment?.status !== 'IN_TRANSIT') throw new ApiError(409, 'LIVE_ROUTING_INACTIVE', 'The live shipment must be in transit');
    if (trip.refreshing) throw new ApiError(409, 'LIVE_ROUTING_BUSY', 'This shipment’s traffic is already being refreshed');
    const progress = shipment.last_progress_km ?? 0;
    const alternative = db.prepare('SELECT alt_route_id FROM route_alternatives WHERE route_id = ? AND exit_km >= ?').get(shipment.active_route_id, progress) as { alt_route_id: string } | undefined;
    const pathIds = [shipment.active_route_id, ...(alternative ? [alternative.alt_route_id] : [])];
    const run = this.generation;
    trip.refreshing = true;
    trip.lastAttemptMs = Date.now();
    try {
      const replies = await Promise.allSettled(pathIds.map(async (id) => {
        const path = this.paths.get(id)!;
        const point = pointAtKm(path.coordinates, path.km, progress, path.marks);
        const remaining = [point, ...path.coordinates.filter((_, index) => path.marks[index] > progress)];
        const [route] = await calculateTruckRoutes(key, point, remaining[remaining.length - 1], shipment.gross_t, trip.draft.vehicle, remaining);
        return quoteFor(path, route, progress, this.now());
      }));
      if (run !== this.generation) throw new ApiError(409, 'LIVE_ROUTING_RESET', 'The demo was reset during the refresh');
      const latest = getShipment(db, shipmentId);
      if (latest?.status !== 'IN_TRANSIT' || latest.active_route_id !== shipment.active_route_id) return this.tripSummary(trip);
      replies.forEach((reply, index) => {
        const id = pathIds[index];
        if (reply.status === 'fulfilled') {
          this.quotes.set(id, reply.value);
          this.failedRoutes.delete(id);
        } else this.failedRoutes.add(id);
      });
      const hints: PendingHint[] = [];
      db.transaction(() => {
        db.prepare('UPDATE shipments SET plan_version = plan_version + 1 WHERE id = ?').run(shipmentId);
        recomputeEta(this.ctx, shipmentId, this.now(), null, 'EVENT', hints);
      })();
      this.ctx.hub.publish(hints);
      if (replies[0].status === 'rejected') throw new ApiError(502, 'LIVE_ROUTING_UNAVAILABLE', 'TomTom refresh failed. The shipment is using its estimated drive time');
      return this.tripSummary(trip);
    } finally {
      trip.refreshing = false;
    }
  }

  private post(shipmentId: string, event: Omit<Extract<EventRequest, { type: 'POSITION' }>, 'event_id'> | Omit<Extract<EventRequest, { type: 'MILESTONE' }>, 'event_id'>, pendingHints?: PendingHint[]) {
    ingestEvent(this.ctx, { shipment_id: shipmentId, event: { ...event, event_id: randomUUID() }, source: 'SIMULATOR', actor: null, pendingHints });
  }
}
