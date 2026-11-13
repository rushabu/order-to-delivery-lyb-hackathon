// Schema and consistency checks for database/seed/*.json.
//
// Usage (from database/): npm run seed:validate      Exit code 0 when every check passes.
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';
import {
  FIXTURE_FILES, SCHEMAS, SEED_DIR, header, istParts, loadAll, minutesBetween, readJson, waypointsFromProfiles,
  type FixtureFile,
} from './seed-lib';

type Data = Record<FixtureFile, any>;
type Rule = (d: Data) => string[];

const Ajv2020 = ((Ajv2020Module as any).default ?? Ajv2020Module) as typeof Ajv2020Module;

/** Invented company names, each searched on the web on 2026-11-12 with no business of that exact name found. */
export const CHECKED_COMPANY_NAMES = new Set([
  'Deccan Mouldings Pvt Ltd', 'Godavari Flexipack Pvt Ltd', 'Sahyadri Bulk Carriers', 'Konkan Roadlines',
]);
const DEMO_CUSTOMER_NAMES = new Set([
  'Plant X Demo Customer · Vikhroli', 'Plant X Demo Customer · Powai', 'Plant X Demo Customer · Chakan',
]);
const TARE_RANGE_T: [number, number] = [7, 12];

export function schemaErrors(d: Data): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  for (const f of readdirSync(SCHEMAS)) ajv.addSchema(readJson(join(SCHEMAS, f)));
  const errors: string[] = [];
  for (const name of FIXTURE_FILES) {
    const validate = ajv.getSchema(name.replace('.json', '.schema.json'))!;
    if (!validate(d[name])) for (const e of validate.errors ?? []) errors.push(`${name}: ${e.instancePath} ${e.message}`);
  }
  return errors;
}

function index(d: Data) {
  const users = new Map<string, any>(d['users.json'].users.map((u: any) => [u.id, u]));
  const customers = new Map<string, any>(d['customers.json'].customers.map((c: any) => [c.id, c]));
  const transporters = new Map<string, any>(d['transporters.json'].transporters.map((t: any) => [t.id, t]));
  const vehicles = new Map<string, { transporter: string; v: any }>();
  for (const t of transporters.values()) for (const v of t.vehicles) vehicles.set(v.id, { transporter: t.id, v });
  const routes = new Map<string, any>(d['routes.json'].routes.map((r: any) => [r.id, r]));
  const sc = d['scenario-main.json'];
  const orders = new Map<string, any>(sc.orders.map((o: any) => [o.id, o]));
  const live = new Map<string, any>(sc.shipments.map((s: any) => [s.id, s]));
  return { users, customers, transporters, vehicles, routes, orders, live, sc };
}

const headers: Rule = (d) => {
  const h = header() as Record<string, unknown>;
  return FIXTURE_FILES.filter((f) => Object.keys(h).some((k) => d[f][k] !== h[k])).map((f) => `${f}: header fields differ`);
};

const references: Rule = (d) => {
  const { users, customers, transporters, vehicles, routes, orders, live, sc } = index(d);
  const errs: string[] = [];
  for (const u of users.values()) {
    if (u.customer_id && !customers.has(u.customer_id)) errs.push(`${u.id}: unknown customer`);
    if (u.transporter_id && !transporters.has(u.transporter_id)) errs.push(`${u.id}: unknown transporter`);
  }
  for (const r of routes.values()) if (!customers.has(r.destination_customer_id)) errs.push(`${r.id}: unknown customer`);
  for (const a of d['routes.json'].alternatives) {
    if (!routes.has(a.route_id) || !routes.has(a.alt_route_id)) errs.push(`alternative ${a.route_id}->${a.alt_route_id}: unknown route`);
  }
  const trip = (id: string, customer: string, route: string, transporter: string, driver: string | null, vehicleId: string, reg: string) => {
    if (!customers.has(customer)) errs.push(`${id}: unknown customer ${customer}`);
    if (!routes.has(route)) errs.push(`${id}: unknown route ${route}`);
    else if (routes.get(route).destination_customer_id !== customer) errs.push(`${id}: ${route} does not end at ${customer}`);
    const u = driver ? users.get(driver) : null;
    if (!u || u.role !== 'DRIVER') errs.push(`${id}: ${driver} is not a driver`);
    else if (u.transporter_id !== transporter) errs.push(`${id}: driver ${driver} does not work for ${transporter}`);
    const v = vehicles.get(vehicleId);
    if (!v) errs.push(`${id}: unknown vehicle ${vehicleId}`);
    else {
      if (v.transporter !== transporter) errs.push(`${id}: ${vehicleId} does not belong to ${transporter}`);
      if (v.v.registration !== reg) errs.push(`${id}: vehicle_reg does not match ${vehicleId}`);
    }
  };
  for (const h of d['history.json'].shipments) trip(h.shipment_id, h.customer_id, h.route_id, h.transporter_id, h.driver_user_id, h.vehicle_id, h.vehicle_reg);
  for (const s of live.values()) {
    const o = orders.get(s.order_id);
    if (!o) errs.push(`${s.id}: unknown order`);
    else trip(s.id, o.customer_id, s.route_id, s.transporter_id, s.driver_user_id, s.vehicle_id, s.vehicle_reg);
    for (const dis of s.disruptions) if (dis.reported_by !== s.driver_user_id) errs.push(`${s.id}: disruption reporter is not its driver`);
  }
  for (const sv of sc.standby_vehicles) {
    const v = vehicles.get(sv.vehicle_id);
    if (!v || !v.v.standby || v.v.registration !== sv.vehicle_reg || v.transporter !== sv.transporter_id) errs.push(`standby ${sv.vehicle_reg}: not a standby vehicle of ${sv.transporter_id}`);
  }
  for (const e of [...sc.scripted_events, ...sc.reference_human_events]) {
    const s = live.get(e.shipment_id);
    if (!s) errs.push(`event for unknown shipment ${e.shipment_id}`);
    else if (s.driver_user_id !== e.actor_user_id) errs.push(`event for ${e.shipment_id}: actor is not its driver`);
  }
  const inTransit = [...live.values()].filter((s) => s.status === 'IN_TRANSIT').map((s) => s.id).sort();
  const withTruth = Object.keys(sc.ground_truth).sort();
  if (JSON.stringify(inTransit) !== JSON.stringify(withTruth)) errs.push(`ground truth must exist for exactly the IN_TRANSIT shipments (${inTransit})`);
  for (const [id, gt] of Object.entries<any>(sc.ground_truth)) {
    for (const r of Object.keys(gt.branches)) if (!routes.has(r)) errs.push(`${id}: branch for unknown route ${r}`);
    if (!(live.get(id)?.route_id in gt.branches)) errs.push(`${id}: no branch for its planned route`);
  }
  return errs;
};

const routeGeometry: Rule = (d) => {
  const { customers, routes } = index(d);
  const errs: string[] = [];
  for (const r of routes.values()) {
    const segs = [...r.segments].sort((a: any, b: any) => a.seq - b.seq);
    if (segs[0].start_km !== 0) errs.push(`${r.id}: first segment does not start at 0`);
    segs.slice(1).forEach((s: any, i: number) => { if (s.start_km !== segs[i].end_km) errs.push(`${r.id}: gap before segment ${s.seq}`); });
    if (segs.at(-1).end_km !== r.total_km) errs.push(`${r.id}: segments do not end at total_km`);
    if (segs.reduce((a: number, s: any) => a + s.end_km - s.start_km, 0) !== r.total_km) errs.push(`${r.id}: segment lengths do not sum to total_km`);
    const marks: number[] = r.geometry.chainage_km;
    if (marks.length !== r.geometry.coordinates.length) errs.push(`${r.id}: chainage and coordinates differ in length`);
    if (marks[0] !== 0 || marks.at(-1) !== r.total_km) errs.push(`${r.id}: chainage must run from 0 to total_km`);
    if (marks.some((m, i) => i > 0 && m <= marks[i - 1])) errs.push(`${r.id}: chainage not increasing`);
    if (r.landmarks.some((l: any) => l.km < 0 || l.km > r.total_km)) errs.push(`${r.id}: landmark outside the route`);
    const c = customers.get(r.destination_customer_id);
    const end = r.geometry.coordinates.at(-1);
    if (c.delivery_lng !== end[0] || c.delivery_lat !== end[1]) errs.push(`${r.id}: does not end at the customer's delivery point`);
  }
  for (const a of d['routes.json'].alternatives) {
    for (const id of [a.route_id, a.alt_route_id]) {
      const r = routes.get(id);
      if (r && !(a.exit_km > 0 && a.exit_km < r.total_km)) errs.push(`${a.route_id}->${a.alt_route_id}: exit_km outside ${id}`);
    }
  }
  if (new Set([...routes.values()].map((r) => JSON.stringify(r.geometry.coordinates[0]) + r.origin)).size !== 1) errs.push('routes do not share one Plant X origin');
  return errs;
};

function trips(d: Data) {
  const { orders, live, sc } = index(d);
  const out = d['history.json'].shipments.map((h: any) => ({ driver: h.driver_user_id, vehicle: h.vehicle_id, start: h.planned_departure, end: h.actual_arrival, id: h.shipment_id }));
  for (const s of live.values()) {
    const gt = sc.ground_truth[s.id];
    const end = gt ? (Object.values<any>(gt.branches).map((w) => w.at(-1).at).sort().at(-1) as string) : orders.get(s.order_id).original_promised_by;
    out.push({ driver: s.driver_user_id, vehicle: s.vehicle_id, start: s.planned_departure, end, id: s.id });
  }
  return out as { driver: string; vehicle: string; start: string; end: string; id: string }[];
}

const noOverlappingTrips: Rule = (d) => {
  const errs: string[] = [];
  for (const key of ['driver', 'vehicle'] as const) {
    const groups = new Map<string, ReturnType<typeof trips>>();
    for (const t of trips(d)) groups.set(t[key], [...(groups.get(t[key]) ?? []), t]);
    for (const [k, list] of groups) {
      list.sort((a, b) => (a.start < b.start ? -1 : 1));
      list.slice(1).forEach((b, i) => { if (b.start < list[i].end) errs.push(`${key} ${k}: ${list[i].id} and ${b.id} overlap`); });
      if (key === 'driver' && new Set(list.map((t) => istParts(t.start).date)).size !== list.length) errs.push(`driver ${k}: more than one trip on a day`);
    }
  }
  return errs;
};

const weights: Rule = (d) => {
  const { vehicles, orders, live } = index(d);
  const errs: string[] = [];
  const rows = [
    ...d['history.json'].shipments.map((h: any) => [h.shipment_id, h.vehicle_id, h.quantity_t, h.gross_t]),
    ...[...live.values()].map((s) => [s.id, s.vehicle_id, s.quantity_t, s.gross_t]),
  ];
  for (const [id, vid, q, g] of rows) {
    const v = vehicles.get(vid)!.v;
    if (v.tare_t < TARE_RANGE_T[0] || v.tare_t > TARE_RANGE_T[1]) errs.push(`${vid}: implausible tare`);
    if (Math.round((g - q) * 10) / 10 !== v.tare_t) errs.push(`${id}: gross minus load is not the tare of ${vid}`);
    if (q > v.payload_capacity_t) errs.push(`${id}: load exceeds ${vid} capacity`);
  }
  for (const s of live.values()) {
    if (s.quantity_t !== orders.get(s.order_id).quantity_t) errs.push(`${s.id}: quantity differs from its order`);
    if (s.loaded_t !== undefined && !(s.loaded_t >= 0 && s.loaded_t < s.quantity_t)) errs.push(`${s.id}: loaded_t out of range`);
  }
  return errs;
};

function inWindow(iso: string, w: any) {
  const p = istParts(iso);
  return p.weekday !== 0 && w.opens_local <= p.hhmm && p.hhmm <= w.closes_local;
}

const promiseWindows: Rule = (d) => {
  const { customers, orders } = index(d);
  const errs: string[] = [];
  for (const h of d['history.json'].shipments) {
    if (!inWindow(h.original_promised_by, customers.get(h.customer_id).receiving_window)) errs.push(`${h.shipment_id}: promise outside the receiving window`);
  }
  for (const o of orders.values()) {
    for (const f of ['original_promised_by', 'agreed_delivery_by']) {
      if (!inWindow(o[f], customers.get(o.customer_id).receiving_window)) errs.push(`${o.id}: ${f} outside the receiving window`);
    }
  }
  return errs;
};

const historyArithmetic: Rule = (d) => {
  const errs: string[] = [];
  for (const h of d['history.json'].shipments) {
    const id = h.shipment_id;
    if (minutesBetween(h.original_promised_by, h.actual_arrival) !== h.lateness_min) errs.push(`${id}: lateness is not arrival minus promise`);
    if (h.on_time !== h.lateness_min <= 0) errs.push(`${id}: on_time disagrees with lateness`);
    const total = h.delay_causes.reduce((a: number, c: any) => a + c.minutes, 0);
    if (h.on_time) {
      if (h.delay_causes.length || h.primary_cause !== null) errs.push(`${id}: on-time shipment has causes`);
    } else {
      if (total !== h.lateness_min) errs.push(`${id}: cause minutes ${total} do not equal lateness ${h.lateness_min}`);
      const top = h.delay_causes.reduce((a: any, b: any) => (b.minutes > a.minutes ? b : a)).cause;
      if (h.primary_cause !== top) errs.push(`${id}: primary cause is not the largest`);
    }
    if (!(h.planned_departure < h.planned_arrival && h.planned_arrival < h.original_promised_by)) errs.push(`${id}: times out of order`);
    if (minutesBetween(h.planned_departure, h.actual_arrival) < minutesBetween(h.planned_departure, h.planned_arrival) - 20) errs.push(`${id}: arrived implausibly fast`);
    if (istParts(h.planned_departure).weekday === 0) errs.push(`${id}: departs on a Sunday`);
  }
  return errs;
};

const groundTruth: Rule = (d) => {
  const { routes } = index(d);
  const errs: string[] = [];
  for (const [id, gt] of Object.entries<any>(d['scenario-main.json'].ground_truth)) {
    const src = gt.derived_from;
    const again = waypointsFromProfiles(src.departure, src.branch_km, src.base_route_id, src.branches, gt.deliver_after_min);
    if (JSON.stringify(again.common) !== JSON.stringify(gt.common) || JSON.stringify(again.branches) !== JSON.stringify(gt.branches)) {
      errs.push(`${id}: waypoints do not match their speed profiles`);
    }
    if (gt.common.at(-1).km !== src.branch_km) errs.push(`${id}: common part does not end at km ${src.branch_km}`);
    const alt = d['routes.json'].alternatives.find((a: any) => a.route_id === src.base_route_id);
    if (!alt || alt.exit_km !== src.branch_km) errs.push(`${id}: branch km is not the exit km of ${src.base_route_id}`);
    for (const [r, w] of Object.entries<any[]>(gt.branches)) {
      const all = [...gt.common, ...w];
      if (all.some((p, i) => i > 0 && (p.at < all[i - 1].at || p.km < all[i - 1].km))) errs.push(`${id}/${r}: waypoints go backwards`);
      if (w.length && w.at(-1).km !== routes.get(r)?.total_km) errs.push(`${id}/${r}: does not end at the destination`);
    }
  }
  return errs;
};

const noRealIdentifiers: Rule = (d) => {
  const { customers, transporters } = index(d);
  const errs: string[] = [];
  for (const u of d['users.json'].users) {
    if (!/@[a-z]+\.example$/.test(u.email)) errs.push(`${u.id}: email is not on a reserved .example domain`);
    if (!u.phone.startsWith('+91 00000 ')) errs.push(`${u.id}: phone is not in the fake +91 00000 range`);
  }
  for (const name of [...customers.values(), ...transporters.values()].map((x) => x.name)) {
    if (!CHECKED_COMPANY_NAMES.has(name) && !DEMO_CUSTOMER_NAMES.has(name)) errs.push(`company name not checked: ${name}`);
  }
  const text = JSON.stringify(d);
  for (const marker of ['LyondellBasell', 'LYB', '@gmail', '@yahoo', '@outlook', '.com"']) {
    if (text.includes(marker)) errs.push(`seed mentions ${marker}`);
  }
  return errs;
};

export const RULES: Record<string, Rule> = {
  headers, references, route_geometry: routeGeometry, no_overlapping_trips: noOverlappingTrips, weights,
  promise_windows: promiseWindows, history_arithmetic: historyArithmetic, ground_truth: groundTruth,
  no_real_identifiers: noRealIdentifiers,
};

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const d = loadAll(SEED_DIR);
  let failures = 0;
  for (const [name, check] of Object.entries({ schemas: schemaErrors, ...RULES })) {
    const errs = check(d);
    failures += errs.length;
    console.log(`${errs.length ? 'FAIL' : 'PASS'}  ${name}`);
    for (const e of errs) console.log(`      ${e}`);
  }
  process.exit(failures ? 1 : 0);
}
