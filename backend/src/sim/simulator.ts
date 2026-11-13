// Replay simulator (DESIGN.md 10.4). Moves trucks along their ground-truth profiles on the simulated
// clock by calling ingestEvent, exactly like a driver's phone would. It never makes the human
// decisions (disruption reports, approvals): it pauses at the scenario's beats and waits.
import type { Ctx, CounterfactualProvider } from '../ctx';
import { ingestEvent } from '../events/ingest';
import { pointAtKm, type LngLat } from '../shipments/geometry';
import { getRoute, getShipment } from '../shipments/repo';
import { staleTick } from '../shipments/staleTick';
import { addMinutes, toIso } from '../time';
import type { SimulatedClock } from './clock';
import { groundTruthKm, seedDatabase, waypointsFor } from './seed';
import { stableUuid } from './ids';

export type ScenarioStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'FINISHED';

export class Simulator implements CounterfactualProvider {
  status: ScenarioStatus = 'IDLE';
  scenarioId: string | null = null;
  private pauses: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastRealMs = 0;

  constructor(
    private ctx: Ctx,
    private clock: SimulatedClock,
    private autoTick: boolean,
  ) {}

  /** Stop, restore the seed, set the clock to the scenario start, paused. */
  reset(actorUserId: string | null): void {
    this.stopTimer();
    const sc = this.ctx.fixtures.scenario;
    this.clock.set(Date.parse(sc.clock_start));
    this.clock.paused = true;
    this.clock.speed = this.ctx.fixtures.config.demo.speed;
    this.ctx.routeTraffic?.clear(); // before the seed, so its ETA run asks TomTom afresh
    seedDatabase(this.ctx, actorUserId);
    this.ctx.liveRouteDemo?.reset();
    this.status = 'IDLE';
    this.scenarioId = null;
    this.pauses = [...sc.pause_at].sort();
  }

  start(scenarioId: string): void {
    this.scenarioId = scenarioId;
    this.status = 'RUNNING';
    this.clock.paused = false;
    this.startTimer();
  }

  setClock(opts: { speed?: number; paused?: boolean }): void {
    if (opts.speed !== undefined) this.clock.speed = opts.speed;
    if (opts.paused !== undefined) {
      this.clock.paused = opts.paused;
      if (this.status === 'RUNNING' || this.status === 'PAUSED') this.status = opts.paused ? 'PAUSED' : 'RUNNING';
      if (!opts.paused && this.status !== 'FINISHED') this.startTimer();
    }
    this.lastRealMs = Date.now();
  }

  get nextPauseAt(): string | null {
    return this.pauses[0] ?? null;
  }

  /** Advance simulated time to `targetIso`, processing everything due on the way, stopping at a pause beat. */
  advanceTo(targetIso: string): void {
    let limit = targetIso;
    let pauseHit = false;
    while (this.pauses.length > 0 && this.pauses[0] <= this.clock.nowIso()) this.pauses.shift();
    if (this.pauses.length > 0 && this.pauses[0] <= limit) {
      limit = this.pauses[0];
      pauseHit = true;
    }
    for (;;) {
      const next = this.nextDue(this.clock.nowIso(), limit);
      if (next === null) break;
      this.clock.set(Date.parse(next));
      this.processAt(next);
    }
    this.clock.set(Date.parse(limit));
    if (pauseHit) {
      this.pauses.shift();
      this.clock.paused = true;
      this.status = 'PAUSED';
      this.ctx.hub.publish([{ hint: { entity: 'demo', id: this.scenarioId ?? 'main', kinds: ['paused'] }, audience: { kind: 'all' } }]);
    }
    if (this.allDone()) this.status = 'FINISHED';
  }

  /** CounterfactualProvider: arrival had the truck stayed on its planned route (ground truth). */
  noActionArrival(shipmentId: string, plannedRouteId: string): string | null {
    const gt = this.ctx.fixtures.scenario.ground_truth[shipmentId];
    if (!gt || !gt.branches[plannedRouteId]) return null;
    const pts = waypointsFor(gt, plannedRouteId);
    return pts[pts.length - 1].at;
  }

  // ---- internals ----

  private groundTruthShipments() {
    return Object.keys(this.ctx.fixtures.scenario.ground_truth);
  }

  private arrivalAt(shipmentId: string): string | null {
    const s = getShipment(this.ctx.db, shipmentId);
    if (!s || s.status !== 'IN_TRANSIT') return null;
    const pts = waypointsFor(this.ctx.fixtures.scenario.ground_truth[shipmentId], s.active_route_id);
    return pts[pts.length - 1].at;
  }

  private deliveryAt(shipmentId: string): string | null {
    const s = getShipment(this.ctx.db, shipmentId);
    if (!s || s.status !== 'ARRIVED' || !s.arrived_at) return null;
    return addMinutes(s.arrived_at, this.ctx.fixtures.scenario.ground_truth[shipmentId].deliver_after_min);
  }

  /** Earliest time in (from, to] at which something is due: a 5-minute mark, an arrival or a delivery. */
  private nextDue(from: string, to: string): string | null {
    const interval = this.ctx.fixtures.config.demo.position_interval_min * 60_000;
    const fromMs = Date.parse(from);
    const candidates: string[] = [toIso(Math.floor(fromMs / interval) * interval + interval)];
    for (const id of this.groundTruthShipments()) {
      for (const t of [this.arrivalAt(id), this.deliveryAt(id)]) if (t && t > from) candidates.push(t);
    }
    for (const e of this.ctx.fixtures.scenario.scripted_events ?? []) if (e.at > from) candidates.push(e.at);
    const next = candidates.filter((t) => t <= to).sort()[0];
    return next ?? null;
  }

  private processAt(t: string): void {
    const ctx = this.ctx;
    const interval = ctx.fixtures.config.demo.position_interval_min;
    const onMark = Date.parse(t) % (interval * 60_000) === 0;
    for (const id of this.groundTruthShipments()) {
      if (this.arrivalAt(id) === t) this.post(id, t, 'MILESTONE', { to_status: 'ARRIVED' });
      if (this.deliveryAt(id) === t) this.post(id, t, 'MILESTONE', { to_status: 'DELIVERED' });
    }
    if (onMark) this.positionsAndTick(t);
    // Scripted background events come after positions at the same instant.
    for (const e of ctx.fixtures.scenario.scripted_events ?? []) {
      if (e.at === t) this.post(e.shipment_id, t, e.type as 'MILESTONE', e.payload);
    }
  }

  private positionsAndTick(t: string): void {
    const ctx = this.ctx;
    for (const id of this.groundTruthShipments()) {
      const s = getShipment(ctx.db, id);
      const arrival = this.arrivalAt(id);
      if (!s || s.status !== 'IN_TRANSIT' || !arrival || t >= arrival) continue;
      const route = getRoute(ctx.db, s.active_route_id)!;
      if (!route.geometry) continue;
      const km = groundTruthKm(ctx.fixtures.scenario.ground_truth[id], s.active_route_id, t);
      const g = JSON.parse(route.geometry);
      const [lng, lat] = pointAtKm(g.coordinates as LngLat[], route.total_km, km, g.chainage_km);
      this.post(id, t, 'POSITION', { lat, lng });
    }
    staleTick(ctx);
  }

  private post(shipmentId: string, at: string, type: string, payload: Record<string, unknown>) {
    ingestEvent(this.ctx, {
      shipment_id: shipmentId,
      event: { event_id: stableUuid(`sim:${shipmentId}:${type}:${at}`), type, occurred_at: at, payload } as never,
      source: 'SIMULATOR',
      actor: null,
    });
  }

  private allDone(): boolean {
    return this.groundTruthShipments().every((id) => getShipment(this.ctx.db, id)?.status === 'DELIVERED');
  }

  private startTimer() {
    if (!this.autoTick || this.timer) return;
    this.lastRealMs = Date.now();
    this.timer = setInterval(() => this.realTick(), 200);
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private realTick() {
    const real = Date.now();
    const elapsed = real - this.lastRealMs;
    this.lastRealMs = real;
    if (this.clock.paused || this.status !== 'RUNNING') return;
    try {
      this.advanceTo(toIso(this.clock.nowMs() + elapsed * this.clock.speed));
    } catch (err) {
      console.error('simulator tick failed', err);
    }
  }

  shutdown() {
    this.stopTimer();
  }
}
