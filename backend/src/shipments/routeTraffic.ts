// TomTom drive time and traffic for every shipment that is not a live-demo trip (those keep their own
// quotes in liveRouting/demo.ts). Each quote covers the road still ahead on the shipment's active route.
// Between requests the quote is scaled to the distance still remaining, the same rule the live demo uses.
// Without a fresh quote the ETA engine falls back to baseline speeds and observed pace.
import type { Ctx } from '../ctx';
import { shipmentNow } from '../ctx';
import type { LiveDrive } from '../eta/types';
import { ApiError } from '../http/errors';
import { LIVE_SHIPMENT_PREFIX, vehicleFor } from '../liveRouting/scenarios';
import { calculateTruckRoutes, RouteReconstructionError, type TruckRoute } from '../liveRouting/tomtom';
import type { PendingHint } from '../stream/hub';
import { toIso } from '../time';
import { kmMarks, pointAtKm, projectToKm, type LngLat } from './geometry';
import { recomputeEta } from './recompute';
import { getAlternatives, getRoute, getShipment, type ShipmentRow } from './repo';

// Refresh the active corridor and any reachable, eligible bypasses every five minutes.
export const TRAFFIC_REFRESH_MS = 5 * 60_000;
const FRESH_MS = 12 * 60_000;
const RETRY_MS = 60_000;
const ACTIVE = new Set(['PLANNED', 'DISPATCHED', 'IN_TRANSIT']);

interface Quote {
  routeId: string;
  grossTonnes: number;
  fromKm: number;
  totalKm: number;
  route: TruckRoute;
  fetchedAt: number;
  affectedSpans: LiveDrive['affectedSpans'];
}

export class RouteTraffic {
  private quotes = new Map<string, Map<string, Quote>>();
  private inflight = new Set<string>();
  private lastAttempt = new Map<string, number>();
  private generation = 0;
  private closed = false;

  /** `auto` false (tests): TomTom is called only on an explicit refresh. */
  constructor(private readonly ctx: Ctx, private readonly key: string, private readonly auto: boolean) {}

  covers(shipmentId: string) { return !shipmentId.startsWith(`${LIVE_SHIPMENT_PREFIX}-`); }

  clear() {
    this.generation++;
    this.quotes.clear();
    this.inflight.clear();
    this.lastAttempt.clear();
  }

  close() {
    this.closed = true;
    this.clear();
  }

  private fresh(s: ShipmentRow, routeId: string): Quote | null {
    const q = this.quotes.get(s.id)?.get(routeId);
    return q && q.grossTonnes === s.gross_t && Date.now() - q.fetchedAt <= FRESH_MS ? q : null;
  }

  drive(s: ShipmentRow, routeId = s.active_route_id): LiveDrive | null {
    if (!ACTIVE.has(s.status)) return null;
    const q = this.fresh(s, routeId);
    if (!q) {
      if (routeId === s.active_route_id) this.requestSoon(s.id);
      return null;
    }
    const progress = s.last_progress_km ?? 0;
    if (progress >= q.totalKm) return { minutes: 0, trafficMinutes: 0, affectedSpans: [] };
    const share = Math.max(0, Math.min(1, (q.totalKm - progress) / (q.totalKm - q.fromKm)));
    return { minutes: q.route.driveMinutes * share, trafficMinutes: q.route.trafficMinutes * share, affectedSpans: q.affectedSpans };
  }

  /** The `live_traffic` block of the shipment detail. */
  traffic(s: ShipmentRow) {
    const q = this.quotes.get(s.id)?.get(s.active_route_id);
    const drive = this.drive(s);
    return {
      source: 'TomTom' as const,
      status: drive ? 'LIVE' as const : q ? 'STALE' as const : 'UNAVAILABLE' as const,
      fetched_at: q ? toIso(q.fetchedAt) : null,
      drive_minutes: drive ? Math.round(drive.minutes) : null,
      traffic_delay_min: drive ? Math.round(drive.trafficMinutes) : null,
      sections: drive && q ? q.route.sections : [],
    };
  }

  private requestSoon(id: string) {
    if (this.closed || !this.auto || this.inflight.has(id) || Date.now() - (this.lastAttempt.get(id) ?? 0) < RETRY_MS) return;
    queueMicrotask(() => {
      if (!this.closed && !this.inflight.has(id) && Date.now() - (this.lastAttempt.get(id) ?? 0) >= RETRY_MS) {
        void this.refresh(id).catch(() => undefined);
      }
    });
  }

  /** Every active shipment, one request at a time. */
  async refreshAll() {
    const rows = this.ctx.db.prepare(`SELECT id FROM shipments WHERE status IN ('PLANNED', 'DISPATCHED', 'IN_TRANSIT')`).all() as { id: string }[];
    for (const { id } of rows) {
      if (this.closed) return;
      if (this.covers(id) && Date.now() - (this.lastAttempt.get(id) ?? 0) >= RETRY_MS) await this.refresh(id).catch(() => undefined);
    }
  }

  private async quote(s: ShipmentRow, route: NonNullable<ReturnType<typeof getRoute>>): Promise<Quote | null> {
    if (!route.geometry) return null;
    const g = JSON.parse(route.geometry) as { coordinates: LngLat[]; chainage_km?: number[] };
    const marks = kmMarks(g.coordinates, route.total_km, g.chainage_km);
    const fromKm = Math.min(route.total_km, Math.max(0, s.last_progress_km ?? 0));
    const start = pointAtKm(g.coordinates, route.total_km, fromKm, g.chainage_km);
    const ahead = [start, ...g.coordinates.filter((_, i) => marks[i] > fromKm)];
    if (ahead.length < 2) return null;
    const destination = ahead[ahead.length - 1];
    const vehicle = vehicleFor(s.gross_t);
    const [tt] = await calculateTruckRoutes(this.key, start, destination, s.gross_t, vehicle, ahead).catch((error) => {
      if (!(error instanceof RouteReconstructionError)) throw error;
      // The seed stores simplified geometry. Let TomTom join a few anchors along that corridor.
      const distance = route.total_km - fromKm;
      const waypoints = distance > 10
        ? [0.25, 0.5, 0.75].map((fraction) => pointAtKm(g.coordinates, route.total_km, fromKm + distance * fraction, marks))
        : [];
      return calculateTruckRoutes(this.key, start, destination, s.gross_t, vehicle, undefined, waypoints);
    });
    const affectedSpans = tt.sections.flatMap(({ coordinates }) => {
      const a = projectToKm(g.coordinates, route.total_km, coordinates[0], marks);
      const b = projectToKm(g.coordinates, route.total_km, coordinates[coordinates.length - 1], marks);
      return a.offKm <= 0.5 && b.offKm <= 0.5 && b.km >= a.km ? [{ fromKm: a.km, toKm: b.km }] : [];
    });
    return { routeId: route.id, grossTonnes: s.gross_t, fromKm, totalKm: route.total_km, route: tt, fetchedAt: Date.now(), affectedSpans };
  }

  async refresh(id: string) {
    const { db } = this.ctx;
    const s = getShipment(db, id);
    if (this.closed || !s || !this.covers(id) || !ACTIVE.has(s.status)) throw new ApiError(409, 'TRAFFIC_INACTIVE', 'Traffic is checked for planned and moving shipments only');
    const route = getRoute(db, s.active_route_id);
    if (!route?.geometry) throw new ApiError(409, 'TRAFFIC_NO_GEOMETRY', 'The active route has no map geometry');
    if (this.inflight.has(id)) throw new ApiError(409, 'TRAFFIC_BUSY', 'This shipment’s traffic is already being refreshed');
    const alternatives = s.status === 'IN_TRANSIT' ? getAlternatives(db, route.id)
      .filter((alt) => alt.exit_km >= (s.last_progress_km ?? 0))
      .map((alt) => getRoute(db, alt.alt_route_id)!)
      .filter((alt) => !alt.closed && (alt.max_gross_t === null || s.gross_t <= alt.max_gross_t)) : [];
    const run = this.generation;
    this.inflight.add(id);
    this.lastAttempt.set(id, Date.now());
    try {
      const replies = await Promise.allSettled([route, ...alternatives].map((r) => this.quote(s, r)));
      if (run !== this.generation) return;
      const current = getShipment(db, id);
      if (!current || !ACTIVE.has(current.status) || current.active_route_id !== route.id || current.gross_t !== s.gross_t) return;
      const fresh = replies.flatMap((reply) => reply.status === 'fulfilled' && reply.value ? [[reply.value.routeId, reply.value] as const] : []);
      this.quotes.set(id, new Map(fresh));
      const hints: PendingHint[] = [];
      db.transaction(() => {
        db.prepare('UPDATE shipments SET plan_version = plan_version + 1 WHERE id = ?').run(id);
        recomputeEta(this.ctx, id, shipmentNow(this.ctx, id), null, 'EVENT', hints);
      })();
      this.ctx.hub.publish(hints);
      if (replies[0].status === 'rejected') throw new ApiError(502, 'TRAFFIC_UNAVAILABLE', 'TomTom did not answer. The ETA uses normal road speeds until the next try');
    } finally {
      if (run === this.generation) this.inflight.delete(id);
    }
  }
}
