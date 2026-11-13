// Truck choice for a new order (load consolidation at dispatch). Deterministic rules, no model.
//
// A new order can ride on a truck that is already planned, when all of these hold:
//   1. the truck has not left the plant (status PLANNED);
//   2. it is going to the same customer, so the route and delivery point are the same;
//   3. the vehicle has enough spare payload;
//   4. the new order is not promised earlier than the truck's own promise (the truck stays tracked against that one);
//   5. the truck's current ETA is at or before the new order's promise.
// Otherwise the order gets its own truck. Each idle driver in the user list (no trip planned or under way)
// is offered with the smallest free vehicle of their transporter that can carry it. The driver is assigned
// when the order is approved, and is notified.
// The coordinator sees every candidate with its reason and approves one. A customer places their own order
// by choosing one of the idle drivers; sharing a planned truck stays the coordinator's call.
import { audit } from '../audit';
import type { AuthUser } from '../auth/policy';
import type { Ctx } from '../ctx';
import { nextSeq, type Db } from '../db/db';
import { ApiError, validationFailed } from '../http/errors';
import { LIVE_SHIPMENT_PREFIX } from '../liveRouting/scenarios';
import { customerUserIds } from '../notify/notifier';
import { recomputeEta } from '../shipments/recompute';
import { getShipment, getSnapshot, type ShipmentRow } from '../shipments/repo';
import type { PendingHint } from '../stream/hub';
import { addMinutes, istClock, minutesBetween, MIN_MS, parseIso, toIso } from '../time';

/** A new truck leaves no sooner than this after the order is placed (loading and paperwork). */
export const LOADING_LEAD_MIN = 60;
/** A new truck is planned to arrive this long before the promise. */
export const ARRIVAL_BUFFER_MIN = 60;
const NOT_FINISHED = ['PLANNED', 'DISPATCHED', 'IN_TRANSIT', 'ARRIVED'];

export interface OrderInput {
  customer_id: string;
  route_id?: string;
  product: string;
  quantity_t: number;
  promised_by: string;
}

export interface TruckOption {
  id: string;
  type: 'ADD_TO_TRUCK' | 'NEW_TRUCK';
  label: string;
  feasible: boolean;
  infeasible_reason: string | null;
  recommended: boolean;
  shipment_id: string | null;
  vehicle_reg: string | null;
  transporter_name: string | null;
  capacity_t: number | null;
  load_after_t: number | null;
  spare_after_t: number | null;
  planned_departure: string | null;
  eta: string | null;
  /** Minutes between the ETA and this order's promise; negative means late. */
  margin_min: number | null;
  /** ADD_TO_TRUCK only: the separate trip that is not needed, and its cost at config.options.cost_per_km_inr. */
  km_saved: number | null;
  cost_saved_inr: number | null;
  /** NEW_TRUCK: who drives it. ADD_TO_TRUCK: the truck's driver, if one is assigned. */
  driver_name: string | null;
  /** Extra context for the coordinator, e.g. the driver is on another trip first. */
  note: string | null;
}

export interface DriverPlan {
  vehicle: Vehicle;
  route_id: string;
  driver_user_id: string;
}

interface Vehicle {
  body?: string;
  registration: string;
  transporter_id: string;
  payload_capacity_t: number;
  tare_t: number;
  standby: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function vehicles(ctx: Ctx): Vehicle[] {
  return ctx.fixtures.transporters.flatMap((t) => (t.vehicles ?? []).map((v) => ({ ...v, transporter_id: t.id })));
}

const customerName = (db: Db, id: string) => (db.prepare('SELECT name FROM customers WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id;
const userName = (db: Db, id: string) => (db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id;
const transporterName = (db: Db, id: string) => (db.prepare('SELECT name FROM transporters WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id;

/** The customer's usual road: the route to that customer that is not another route's alternative. */
function baseRoute(ctx: Ctx, customerId: string) {
  const alternatives = new Set(ctx.fixtures.alternatives.map((a) => a.alt_route_id));
  return ctx.fixtures.routes.find((r) => r.destination_customer_id === customerId && !alternatives.has(r.id));
}

function orderRoute(ctx: Ctx, input: OrderInput) {
  return input.route_id ? ctx.fixtures.routes.find((r) =>
    r.id === input.route_id && r.destination_customer_id === input.customer_id && !r.restrictions.closed)
    : baseRoute(ctx, input.customer_id);
}

function tripMinutes(route: { segments: { start_km: number; end_km: number; baseline_speed_kmph: number; dwell_after_min: number }[] }): number {
  return route.segments.reduce((sum, s) => sum + ((s.end_km - s.start_km) / s.baseline_speed_kmph) * 60 + s.dwell_after_min, 0);
}

export function validateOrder(ctx: Ctx, input: OrderInput, now: string): void {
  if (!ctx.db.prepare('SELECT 1 FROM customers WHERE id = ?').get(input.customer_id)) throw validationFailed('Unknown customer');
  if (input.route_id && !orderRoute(ctx, input)) throw validationFailed('Choose an open route to this customer');
  if (parseIso(input.promised_by) <= parseIso(now)) throw validationFailed('The promised delivery time must be in the future');
}

function blank(id: string, type: TruckOption['type'], label: string): TruckOption {
  return {
    id, type, label, feasible: false, infeasible_reason: null, recommended: false, shipment_id: null, vehicle_reg: null, transporter_name: null,
    capacity_t: null, load_after_t: null, spare_after_t: null, planned_departure: null, eta: null, margin_min: null, km_saved: null, cost_saved_inr: null,
    driver_name: null, note: null,
  };
}

function addToTruck(ctx: Ctx, s: ShipmentRow, input: OrderInput, fleet: Vehicle[]): TruckOption {
  const { db } = ctx;
  const vehicle = fleet.find((v) => v.registration === s.vehicle_reg);
  const snap = getSnapshot(db, s.current_eta_snapshot_id);
  const route = db.prepare('SELECT total_km FROM routes WHERE id = ?').get(s.planned_route_id) as { total_km: number };
  const option: TruckOption = {
    ...blank(`ADD-${s.id}`, 'ADD_TO_TRUCK', `Add to ${s.id} (${s.vehicle_reg}), already going to this customer`),
    shipment_id: s.id,
    vehicle_reg: s.vehicle_reg,
    transporter_name: transporterName(db, s.transporter_id),
    driver_name: s.driver_user_id ? userName(db, s.driver_user_id) : null,
    capacity_t: vehicle?.payload_capacity_t ?? null,
    planned_departure: s.planned_departure,
    eta: snap?.eta ?? null,
    margin_min: snap ? Math.round(minutesBetween(snap.eta, input.promised_by)) : null,
  };
  const spare = vehicle ? round1(vehicle.payload_capacity_t - s.quantity_t) : null;
  let reason: string | null = null;
  if (s.status !== 'PLANNED') reason = 'This truck has already left the plant';
  else if (!vehicle || spare === null) reason = `The payload capacity of ${s.vehicle_reg} is not known`;
  else if (spare < input.quantity_t) reason = `Only ${spare} t spare: a ${vehicle.payload_capacity_t} t truck already carrying ${s.quantity_t} t`;
  else if ((orderRoute(ctx, input)?.restrictions.max_gross_t ?? Infinity) < round1(s.gross_t + input.quantity_t)) reason = 'The combined load exceeds the route gross weight limit';
  else if (parseIso(input.promised_by) < parseIso(s.agreed_delivery_by)) reason = `This order is promised before the truck's own promise of ${istClock(s.agreed_delivery_by)}`;
  else if (!snap) reason = 'The truck has no ETA yet';
  else if (parseIso(snap.eta) > parseIso(input.promised_by)) reason = `The truck is expected at ${istClock(snap.eta)}, after this order's promise`;
  if (reason) return { ...option, infeasible_reason: reason, spare_after_t: spare };
  return {
    ...option,
    feasible: true,
    load_after_t: round1(s.quantity_t + input.quantity_t),
    spare_after_t: round1(spare! - input.quantity_t),
    km_saved: route.total_km,
    cost_saved_inr: Math.round(route.total_km * ctx.fixtures.config.options.cost_per_km_inr),
  };
}

/** One "separate truck" option per idle driver in the user list, each with a free vehicle of the driver's transporter. */
function newTrucks(ctx: Ctx, input: OrderInput, fleet: Vehicle[], now: string): (TruckOption & { plan?: DriverPlan })[] {
  const { db } = ctx;
  // Idle: no trip of theirs is planned, dispatched, on the road or waiting to unload.
  const drivers = db
    .prepare(
      `SELECT id, name, transporter_id FROM users u WHERE role = 'DRIVER' AND transporter_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.driver_user_id = u.id AND s.status IN (${NOT_FINISHED.map(() => '?').join(',')}))
       ORDER BY name`,
    )
    .all(...NOT_FINISHED) as {
    id: string;
    name: string;
    transporter_id: string;
  }[];
  const busy = new Set(
    (db.prepare(`SELECT vehicle_reg FROM shipments WHERE status IN (${NOT_FINISHED.map(() => '?').join(',')})`).all(...NOT_FINISHED) as { vehicle_reg: string }[]).map((r) => r.vehicle_reg),
  );
  const route = orderRoute(ctx, input);
  const taken = new Set<string>(); // two drivers of one transporter are offered different trucks
  return drivers.map((d) => {
    const option = { ...blank(`NEW-${d.id}`, 'NEW_TRUCK', `Separate truck with ${d.name}`), driver_name: d.name, transporter_name: transporterName(db, d.transporter_id) };
    if (!route) return { ...option, infeasible_reason: 'No route to this customer is set up' };
    const available = fleet
      .filter((v) => v.transporter_id === d.transporter_id && !v.standby && !busy.has(v.registration) && !taken.has(v.registration)
        && v.payload_capacity_t >= input.quantity_t && (v.body !== 'Delivery van' || (route.restrictions.max_gross_t ?? Infinity) <= 3.5))
      .sort((a, b) => a.payload_capacity_t - b.payload_capacity_t || a.registration.localeCompare(b.registration));
    const vehicle = available.find((v) => round1(v.tare_t + input.quantity_t) <= (route.restrictions.max_gross_t ?? Infinity));
    if (!vehicle) return { ...option, infeasible_reason: available.length
      ? `Available trucks exceed the ${route.restrictions.max_gross_t} t gross limit on ${route.name}`
      : `No free ${option.transporter_name} truck can carry ${input.quantity_t} t` };
    taken.add(vehicle.registration);
    // Leave as late as still arrives an hour early, but not before loading is done. Rounded up to 5 minutes.
    const latest = parseIso(input.promised_by) - (tripMinutes(route) + ARRIVAL_BUFFER_MIN) * MIN_MS;
    const earliest = parseIso(now) + LOADING_LEAD_MIN * MIN_MS;
    const departure = toIso(Math.ceil(Math.max(latest, earliest) / (5 * MIN_MS)) * 5 * MIN_MS);
    return {
      ...option,
      feasible: true,
      label: `Separate truck ${vehicle.registration} with ${d.name}`,
      vehicle_reg: vehicle.registration,
      capacity_t: vehicle.payload_capacity_t,
      load_after_t: input.quantity_t,
      spare_after_t: round1(vehicle.payload_capacity_t - input.quantity_t),
      planned_departure: departure,
      plan: { vehicle, route_id: route.id, driver_user_id: d.id },
    };
  });
}

const ROLLBACK = Symbol('rollback');
/** Run fn inside a transaction that is always rolled back: the exact result of an action without doing it. */
function dryRun<T>(db: Db, fn: () => T): T {
  let out!: T;
  try {
    db.transaction(() => {
      out = fn();
      throw ROLLBACK;
    })();
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return out;
}

function insertOrder(db: Db, input: OrderInput): string {
  const id = `ORD-${6000 + nextSeq(db, 'NEW_ORDER')}`;
  db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)').run(id, input.customer_id, input.product, input.quantity_t, input.promised_by, input.promised_by);
  return id;
}

/** Creates the order on its own PLANNED shipment and computes its first ETA. Must run inside a transaction. */
function createShipment(ctx: Ctx, input: OrderInput, plan: DriverPlan, departure: string, now: string, hints: PendingHint[]) {
  const { db } = ctx;
  const orderId = insertOrder(db, input);
  const shipmentId = `SHP-${2000 + nextSeq(db, 'NEW_SHIPMENT')}`;
  db.prepare(
    `INSERT INTO shipments (id, order_id, transporter_id, driver_user_id, vehicle_reg, quantity_t, gross_t, status,
       planned_route_id, active_route_id, planned_departure, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'PLANNED', ?, ?, ?, ?)`,
  ).run(shipmentId, orderId, plan.vehicle.transporter_id, plan.driver_user_id, plan.vehicle.registration, input.quantity_t, round1(input.quantity_t + plan.vehicle.tare_t), plan.route_id, plan.route_id, departure, now);
  recomputeEta(ctx, shipmentId, now, null, 'EVENT', hints);
  return { orderId, shipmentId };
}

/** Every candidate truck for this order, feasible or not, and which one is recommended. */
export function planOrder(ctx: Ctx, input: OrderInput, now: string, audience: 'COORDINATOR' | 'CUSTOMER' = 'COORDINATOR'): { options: TruckOption[]; recommended_option_id: string | null; plans: Map<string, DriverPlan> } {
  const { db } = ctx;
  const fleet = vehicles(ctx);
  const sameCustomer = (db
    .prepare(
      `SELECT s.id FROM shipments s JOIN orders o ON o.id = s.order_id
       WHERE o.customer_id = ? AND s.status IN ('PLANNED', 'DISPATCHED', 'IN_TRANSIT') AND s.id NOT LIKE ? ORDER BY s.planned_departure, s.id`,
    )
    .all(input.customer_id, `${LIVE_SHIPMENT_PREFIX}%`) as { id: string }[]).map((r) => getShipment(db, r.id)!);
  const adds = audience === 'CUSTOMER' ? [] : sameCustomer
    .filter((s) => !input.route_id || s.planned_route_id === input.route_id)
    .map((s) => addToTruck(ctx, s, input, fleet));

  const plans = new Map<string, DriverPlan>();
  const fresh = newTrucks(ctx, input, fleet, now).map(({ plan, ...o }) => {
    if (!plan) return o;
    plans.set(o.id, plan);
    // The ETA of a truck that does not exist yet: create it, read the engine's answer, and roll back.
    const snap = dryRun(db, () => {
      const { shipmentId } = createShipment(ctx, input, plan, o.planned_departure!, now, []);
      return getSnapshot(db, getShipment(db, shipmentId)!.current_eta_snapshot_id);
    });
    return { ...o, eta: snap?.eta ?? null, margin_min: snap ? Math.round(minutesBetween(snap.eta, input.promised_by)) : null };
  });

  // Sharing a truck that is already going beats a second trip; among several, the one that arrives first, then the fuller one.
  // Otherwise the separate truck that arrives in time, earliest first.
  const onTime = (o: TruckOption) => Number((o.margin_min ?? -1) >= 0);
  const best =
    adds.filter((o) => o.feasible).sort((a, b) => parseIso(a.eta!) - parseIso(b.eta!) || a.spare_after_t! - b.spare_after_t!)[0] ??
    fresh.filter((o) => o.feasible && o.eta).sort((a, b) => onTime(b) - onTime(a) || parseIso(a.eta!) - parseIso(b.eta!))[0];
  const options = [...adds, ...fresh].map((o) => ({ ...o, recommended: o.id === best?.id }));
  return { options, recommended_option_id: best?.id ?? null, plans };
}

/** The coordinator approved one option: check it still holds, then apply it. */
export function createOrder(ctx: Ctx, user: AuthUser, input: OrderInput, optionId: string) {
  const { db } = ctx;
  const now = ctx.clock.nowIso();
  validateOrder(ctx, input, now);
  const hints: PendingHint[] = [];
  const result = db.transaction(() => {
    const { options, plans } = planOrder(ctx, input, now, user.role === 'CUSTOMER' ? 'CUSTOMER' : 'COORDINATOR');
    const option = options.find((o) => o.id === optionId);
    if (!option) throw validationFailed('Unknown option');
    if (!option.feasible) throw new ApiError(409, 'ORDER_PLAN_STALE', option.infeasible_reason ?? 'That truck is no longer available. Check the options again');
    let orderId: string;
    let shipmentId: string;
    if (option.type === 'ADD_TO_TRUCK') {
      shipmentId = option.shipment_id!;
      orderId = insertOrder(db, input);
      db.prepare('INSERT INTO shipment_orders (order_id, shipment_id, added_by, added_at) VALUES (?, ?, ?, ?)').run(orderId, shipmentId, user.id, now);
      // The heavier truck may no longer fit a weight-limited alternative, so option sets are invalidated too.
      db.prepare('UPDATE shipments SET quantity_t = ?, gross_t = ROUND(gross_t + ?, 1), version = version + 1, plan_version = plan_version + 1 WHERE id = ?').run(
        option.load_after_t, input.quantity_t, shipmentId,
      );
    } else {
      ({ orderId, shipmentId } = createShipment(ctx, input, plans.get(option.id)!, option.planned_departure!, now, hints));
    }
    const s = getShipment(db, shipmentId)!;
    audit(db, now, user.id, 'ORDER_CREATED', 'order', orderId, {
      option: option.type, shipment_id: shipmentId, vehicle_reg: s.vehicle_reg, quantity_t: input.quantity_t, km_saved: option.km_saved,
    });
    for (const userId of customerUserIds(db, input.customer_id)) {
      ctx.notifier.send(db, now, {
        user_id: userId,
        shipment_id: shipmentId,
        kind: 'ORDER_CONFIRMED',
        title: `Order ${orderId} confirmed`,
        body:
          option.type === 'ADD_TO_TRUCK'
            ? `${input.quantity_t} t ${input.product} will travel with order ${s.order_id} on ${s.vehicle_reg}${option.eta ? `, expected ${istClock(option.eta)}` : ''}.`
            : `${input.quantity_t} t ${input.product} is planned on ${s.vehicle_reg}${option.eta ? `, expected ${istClock(option.eta)}` : ''}.`,
      }, hints);
    }
    if (user.role === 'CUSTOMER') {
      const coordinators = db.prepare("SELECT id FROM users WHERE role = 'COORDINATOR'").all() as { id: string }[];
      for (const c of coordinators) {
        ctx.notifier.send(db, now, {
          user_id: c.id,
          shipment_id: shipmentId,
          kind: 'ORDER_PLACED',
          title: `${customerName(db, input.customer_id)} placed order ${orderId}`,
          body: `${input.quantity_t} t ${input.product} on ${shipmentId} with ${option.driver_name}, leaving ${istClock(s.planned_departure)}${option.eta ? `, expected ${istClock(option.eta)}` : ''}.`,
        }, hints);
      }
    }
    if (s.driver_user_id) {
      ctx.notifier.send(db, now, {
        user_id: s.driver_user_id,
        shipment_id: shipmentId,
        kind: 'NEW_TRIP',
        title: option.type === 'ADD_TO_TRUCK' ? `${shipmentId}: extra load added` : `New trip ${shipmentId}`,
        body:
          option.type === 'ADD_TO_TRUCK'
            ? `Load ${input.quantity_t} t more ${input.product} (order ${orderId}) before you leave. Total ${option.load_after_t} t.`
            : `${input.quantity_t} t ${input.product} to ${customerName(db, input.customer_id)} on ${s.vehicle_reg}. Leave Plant X at ${istClock(s.planned_departure)}. Open it for the route, alerts and safety checks.`,
      }, hints);
    }
    hints.push({ hint: { entity: 'shipment', id: shipmentId, version: s.version, kinds: ['order'] }, audience: { kind: 'shipment', customer_id: s.customer_id, driver_user_id: s.driver_user_id } });
    return { order_id: orderId, shipment_id: shipmentId, option: { ...option, recommended: option.recommended } };
  })();
  ctx.hub.publish(hints);
  return result;
}

/** Orders added to a truck after it was planned (the truck's own order is shipments.order_id). */
export function extraOrders(db: Db, shipmentId: string) {
  return db
    .prepare(
      `SELECT o.id, o.product, o.quantity_t, o.agreed_delivery_by AS promised_by FROM shipment_orders so JOIN orders o ON o.id = so.order_id
       WHERE so.shipment_id = ? ORDER BY so.added_at, o.id`,
    )
    .all(shipmentId) as { id: string; product: string; quantity_t: number; promised_by: string }[];
}
