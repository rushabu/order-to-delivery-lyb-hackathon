// TomTom drive time and traffic for every shipment that is not a live-demo trip (those keep their own
// quotes in liveRouting/demo.ts). Each quote covers the road still ahead on the shipment's active route.
// Between requests the quote is scaled to the distance still remaining, the same rule the live demo uses.
// Without a fresh quote the ETA engine falls back to baseline speeds and observed pace.
import type { Ctx } from '../ctx';
import { shipmentNow } from '../ctx';
import type { LiveDrive } from '../eta/types';
import { ApiError } from '../http/errors';
import { LIVE_SHIPMENT_PREFIX, vehicleFor } from '../liveRouting/scenarios';
import { calculateTruckRoutes, type TruckRoute } from '../liveRouting/tomtom';
import type { PendingHint } from '../stream/hub';
import { toIso } from '../time';
import { kmMarks, pointAtKm, projectToKm, type LngLat } from './geometry';
import { recomputeEta } from './recompute';
import { getRoute, getShipment, type ShipmentRow } from './repo';

// ponytail: one TomTom request per active shipment every 5 min (~290 a day each). The free tier allows
// 2,500 a day, so this suits a demo-sized fleet; batch or lengthen the interval for a larger one.
export const TRAFFIC_REFRESH_MS = 5 * 60_000;
const FRESH_MS = 12 * 60_000;
const RETRY_MS = 60_000;
const ACTIVE = new Set(['PLANNED', 'DISPATCHED', 'IN_TRANSIT']);

interface Quote {
  routeId: string;
  fromKm: number;
  totalKm: number;
  route: TruckRoute;
  fetchedAt: number;
  affectedSpans: LiveDrive['affectedSpans'];
}

export class RouteTraffic {
  private quotes = new Map<string, Quote>();
  private inflight = new Set<string>();
  private lastAttempt = new Map<string, number>();
  private generation = 0;

  /** `auto` false (tests): TomTom is called only on an explicit refresh. */
  constructor(private readonly ctx: Ctx, private readonly key: string, private readonly auto: boolean) {}

  covers(shipmentId: string) { return !shipmentId.startsWith(`${LIVE_SHIPMENT_PREFIX}-`); }

  clear() {
    this.generation++;
    this.quotes.clear();
    this.inflight.clear();
    this.lastAttempt.clear();
  }

  private fresh(s: ShipmentRow): Quote | null {
    const q = this.quotes.get(s.id);
    return q && q.routeId === s.active_route_id && Date.now() - q.fetchedAt <= FRESH_MS ? q : null;
  }

  /** Remaining drive for the ETA engine, or null (and a background request) when there is no fresh quote. */
  drive(s: ShipmentRow): LiveDrive | null {
    const q = this.fresh(s);
    if (!q) {
      this.requestSoon(s.id);
      return null;
    }
    const progress = s.last_progress_km ?? 0;
    if (progress >= q.totalKm) return { minutes: 0, trafficMinutes: 0, affectedSpans: [] };
    const share = Math.max(0, Math.min(1, (q.totalKm - progress) / (q.totalKm - q.fromKm)));
    return { minutes: q.route.driveMinutes * share, trafficMinutes: q.route.trafficMinutes * share, affectedSpans: q.affectedSpans };
  }

  /** The `live_traffic` block of the shipment detail. */
  traffic(s: ShipmentRow) {
    const q = this.quotes.get(s.id);
    const drive = this.fresh(s) && this.drive(s);
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
    if (!this.auto || this.inflight.has(id) || Date.now() - (this.lastAttempt.get(id) ?? 0) < RETRY_MS) return;
    this.lastAttempt.set(id, Date.now());
    void this.refresh(id).catch(() => undefined);
  }

  /** Every active shipment, one request at a time. */
  async refreshAll() {
    const rows = this.ctx.db.prepare(`SELECT id FROM shipments WHERE status IN ('PLANNED', 'DISPATCHED', 'IN_TRANSIT')`).all() as { id: string }[];
    for (const { id } of rows) if (this.covers(id)) await this.refresh(id).catch(() => undefined);
  }

  /** Ask TomTom for the road still ahead, store the quote and recalculate the ETA. */
  async refresh(id: string) {
    const { db } = this.ctx;
    const s = getShipment(db, id);
    if (!s || !this.covers(id) || !ACTIVE.has(s.status)) throw new ApiError(409, 'TRAFFIC_INACTIVE', 'Traffic is checked for planned and moving shipments only');
    const route = getRoute(db, s.active_route_id);
    if (!route?.geometry) throw new ApiError(409, 'TRAFFIC_NO_GEOMETRY', 'The active route has no map geometry');
    if (this.inflight.has(id)) throw new ApiError(409, 'TRAFFIC_BUSY', 'This shipment’s traffic is already being refreshed');
    const g = JSON.parse(route.geometry) as { coordinates: LngLat[]; chainage_km?: number[] };
    const marks = kmMarks(g.coordinates, route.total_km, g.chainage_km);
    const fromKm = Math.min(route.total_km, Math.max(0, s.last_progress_km ?? 0));
    const start = pointAtKm(g.coordinates, route.total_km, fromKm, g.chainage_km);
    const ahead = [start, ...g.coordinates.filter((_, i) => marks[i] > fromKm)];
    if (ahead.length < 2) return;

    const run = this.generation;
    this.inflight.add(id);
    this.lastAttempt.set(id, Date.now());
    try {
      let tt: TruckRoute;
      try {
        [tt] = await calculateTruckRoutes(this.key, start, ahead[ahead.length - 1], s.gross_t, vehicleFor(s.gross_t), ahead);
      } catch {
        throw new ApiError(502, 'TRAFFIC_UNAVAILABLE', 'TomTom did not answer. The ETA uses normal road speeds until the next try');
      }
      if (run !== this.generation) return;
      const affectedSpans = tt.sections.flatMap(({ coordinates }) => {
        const a = projectToKm(g.coordinates, route.total_km, coordinates[0], g.chainage_km);
        const b = projectToKm(g.coordinates, route.total_km, coordinates[coordinates.length - 1], g.chainage_km);
        return a.offKm <= 0.5 && b.offKm <= 0.5 && b.km >= a.km ? [{ fromKm: a.km, toKm: b.km }] : [];
      });
      this.quotes.set(id, { routeId: route.id, fromKm, totalKm: route.total_km, route: tt, fetchedAt: Date.now(), affectedSpans });
      const hints: PendingHint[] = [];
      db.transaction(() => recomputeEta(this.ctx, id, shipmentNow(this.ctx, id), null, 'EVENT', hints))();
      this.ctx.hub.publish(hints);
    } finally {
      if (run === this.generation) this.inflight.delete(id);
    }
  }
}
