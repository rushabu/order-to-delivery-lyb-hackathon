/*
  Mock fixtures. FICTIONAL DATA: every person, company, vehicle and number here is invented for the
  hackathon. Plant X is a fictional company.

  The SHP-1001 numbers are DESIGN.md 6.6 exactly. SHP-1002 and SHP-1003 follow the shape given in
  DESIGN.md 10.1; their numbers are our own fiction until the API team publishes scenario-main.json.
  The mock never calculates an ETA: it only returns the precomputed snapshots below.
*/
import type { EtaFactor, EtaSnapshot, RiskLevel, RouteDetail, User } from "../api/contract";

export const FICTIONAL = true;

/** IST clock time on the scenario day (16 Nov 2026) as an ISO UTC string. "09:15" -> 2026-11-16T03:45:00Z */
export function ist(hhmm: string, day = 16): string {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 10, day, h, m) - 330 * 60_000).toISOString().replace(".000Z", "Z");
}
export const minutes = (iso: string) => Date.parse(iso) / 60_000;
export const addMin = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString().replace(".000Z", "Z");

/* ---------------- People and companies ---------------- */

export interface MockUser extends User {
  phone?: string;
}

export const USERS: MockUser[] = [
  { id: "USR-COORD-01", name: "Meera Kulkarni", email: "meera.kulkarni@plantx.example", role: "COORDINATOR" },
  { id: "USR-COORD-02", name: "Farhan Qureshi", email: "farhan.qureshi@plantx.example", role: "COORDINATOR" },
  { id: "USR-DRV-01", name: "Ravi Shinde", email: "ravi.shinde@sahyadri.example", role: "DRIVER", transporter_id: "TRN-01", phone: "+91 90000 00101" },
  { id: "USR-DRV-02", name: "Gurpreet Sandhu", email: "gurpreet.sandhu@konkan.example", role: "DRIVER", transporter_id: "TRN-02", phone: "+91 90000 00102" },
  { id: "USR-DRV-03", name: "Sunil Pawar", email: "sunil.pawar@sahyadri.example", role: "DRIVER", transporter_id: "TRN-01", phone: "+91 90000 00103" },
  { id: "USR-CUST-01", name: "Anil Deshpande", email: "anil.deshpande@deccanmouldings.example", role: "CUSTOMER", customer_id: "CUS-01" },
  { id: "USR-CUST-02", name: "Kavita Joshi", email: "kavita.joshi@deccanmouldings.example", role: "CUSTOMER", customer_id: "CUS-01" },
  { id: "USR-CUST-03", name: "Nikhil Bhosale", email: "nikhil.bhosale@godavariflexi.example", role: "CUSTOMER", customer_id: "CUS-02" },
];

export const CUSTOMERS = {
  "CUS-01": { name: "Deccan Mouldings Pvt Ltd", destination: "Deccan Mouldings, Chakan, Pune" },
  "CUS-02": { name: "Godavari Flexipack Pvt Ltd", destination: "Godavari Flexipack, Ambad, Nashik" },
} as const;

export const TRANSPORTERS = {
  "TRN-01": "Sahyadri Bulk Carriers",
  "TRN-02": "Konkan Roadlines",
} as const;

/* ---------------- Routes (hand-drawn fictional geometry, [lng, lat]) ---------------- */

type LngLat = [number, number];

const RTE01_LINE: LngLat[] = [
  [73.12, 18.99], [73.16, 18.96], [73.2, 18.92], [73.245, 18.88], [73.28, 18.835], [73.335, 18.79],
  [73.4, 18.755], [73.48, 18.76], [73.55, 18.765], [73.64, 18.74], [73.7, 18.72], [73.76, 18.68],
  [73.8, 18.62], [73.84, 18.56], [73.86, 18.52],
];
const RTE02_LINE: LngLat[] = [
  [73.12, 18.99], [73.1, 19.08], [73.06, 19.2], [73.06, 19.3], [73.18, 19.38], [73.33, 19.45],
  [73.42, 19.56], [73.48, 19.64], [73.56, 19.7], [73.65, 19.8], [73.72, 19.92], [73.79, 20.0],
];

function segLen(a: LngLat, b: LngLat) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Point at a fraction (0-1) along a polyline. Used only to place the mock truck. */
export function pointAt(line: LngLat[], fraction: number): LngLat {
  const f = Math.min(1, Math.max(0, fraction));
  const total = line.slice(1).reduce((s, p, i) => s + segLen(line[i], p), 0);
  let target = total * f;
  for (let i = 1; i < line.length; i++) {
    const l = segLen(line[i - 1], line[i]);
    if (target <= l) {
      const t = l === 0 ? 0 : target / l;
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
    }
    target -= l;
  }
  return line[line.length - 1];
}

/** The part of a polyline from a fraction to the end (for alternatives that leave mid-route). */
function lineFrom(line: LngLat[], fraction: number): LngLat[] {
  const start = pointAt(line, fraction);
  const total = line.slice(1).reduce((s, p, i) => s + segLen(line[i], p), 0);
  let acc = 0;
  const out: LngLat[] = [start];
  for (let i = 1; i < line.length; i++) {
    acc += segLen(line[i - 1], line[i]);
    if (acc / total > fraction) out.push(line[i]);
  }
  return out;
}

const RTE01B_EXIT = pointAt(RTE01_LINE, 66 / 150);
const RTE01B_LINE: LngLat[] = [
  RTE01B_EXIT, [73.43, 18.7], [73.49, 18.645], [73.57, 18.6], [73.66, 18.575], [73.75, 18.55], [73.82, 18.53], [73.86, 18.52],
];
const RTE02B_EXIT = pointAt(RTE02_LINE, 110 / 180);
const RTE02B_LINE: LngLat[] = [RTE02B_EXIT, [73.38, 19.72], [73.45, 19.83], [73.58, 19.92], [73.7, 19.98], [73.79, 20.0]];

export const ROUTES: Record<string, RouteDetail> = {
  "RTE-01": {
    id: "RTE-01", name: "Panvel – Pune expressway corridor", origin: "Plant X, Panvel", destination: "Pune",
    total_km: 150, geometry: { type: "LineString", coordinates: RTE01_LINE }, restrictions: {},
    segments: [
      { seq: 1, start_km: 0, end_km: 40, baseline_speed_kmph: 40, dwell_after_min: 0 },
      { seq: 2, start_km: 40, end_km: 100, baseline_speed_kmph: 60, dwell_after_min: 15 },
      { seq: 3, start_km: 100, end_km: 150, baseline_speed_kmph: 50, dwell_after_min: 0 },
    ],
    alternatives: [{ alt_route_id: "RTE-01B", exit_km: 66 }],
  },
  "RTE-01B": {
    id: "RTE-01B", name: "Khalapur bypass", origin: "RTE-01 km 66", destination: "Pune",
    total_km: 100, geometry: { type: "LineString", coordinates: RTE01B_LINE }, restrictions: {},
    segments: [{ seq: 1, start_km: 0, end_km: 100, baseline_speed_kmph: 50, dwell_after_min: 0 }],
    alternatives: [],
  },
  "RTE-02": {
    id: "RTE-02", name: "Panvel – Nashik highway corridor", origin: "Plant X, Panvel", destination: "Nashik",
    total_km: 180, geometry: { type: "LineString", coordinates: RTE02_LINE }, restrictions: {},
    segments: [
      { seq: 1, start_km: 0, end_km: 140, baseline_speed_kmph: 60, dwell_after_min: 10 },
      { seq: 2, start_km: 140, end_km: 180, baseline_speed_kmph: 60, dwell_after_min: 0 },
    ],
    alternatives: [{ alt_route_id: "RTE-02B", exit_km: 110 }],
  },
  "RTE-02B": {
    id: "RTE-02B", name: "Igatpuri bypass", origin: "RTE-02 km 110", destination: "Nashik",
    total_km: 85, geometry: { type: "LineString", coordinates: RTE02B_LINE }, restrictions: { max_gross_t: 20 },
    segments: [{ seq: 1, start_km: 0, end_km: 85, baseline_speed_kmph: 50, dwell_after_min: 0 }],
    alternatives: [],
  },
};

export function lineFor(routeId: string): LngLat[] {
  return ROUTES[routeId].geometry.coordinates as LngLat[];
}
export { lineFrom };

/* ---------------- ETA snapshots (precomputed; never calculated in the browser) ---------------- */

function snap(p: {
  id: string; shipment_id: string; at: string; route_id: string; progress_km: number; remaining_km: number;
  factors: EtaFactor[]; promised_by: string; margin_min: number; risk_score: number; risk_level: RiskLevel;
  confidence?: EtaSnapshot["confidence"]; headline: string; trigger_event_id?: string | null;
}): EtaSnapshot {
  const total = p.factors.reduce((s, f) => s + f.minutes, 0);
  const eta = addMin(p.at, total);
  return {
    id: p.id, shipment_id: p.shipment_id, computed_at: p.at, trigger_event_id: p.trigger_event_id ?? null,
    route_id: p.route_id, progress_km: p.progress_km, remaining_km: p.remaining_km, eta,
    eta_window: { earliest: addMin(eta, -p.margin_min), latest: addMin(eta, p.margin_min) },
    promised_by: p.promised_by, slack_min: Math.round(minutes(p.promised_by) - minutes(eta)), margin_min: p.margin_min,
    risk_score: p.risk_score, risk_level: p.risk_level, confidence: p.confidence ?? "HIGH", position_age_min: 0,
    factors: p.factors, headline: p.headline,
  };
}

const BASE = (minutes: number, label = "Remaining drive at normal speed"): EtaFactor => ({ code: "BASE_TRAVEL", label, minutes });
const CHECKPOINT = { code: "DWELL", label: "Checkpoint stop at km 100", minutes: 15 } satisfies EtaFactor;

export const PROMISE_1001 = ist("11:45");
export const PROMISE_1002 = ist("11:10");

export const SNAP_1001 = {
  departed: snap({ id: "ETA-000290", shipment_id: "SHP-1001", at: ist("08:00"), route_id: "RTE-01", progress_km: 0, remaining_km: 150, factors: [BASE(180), CHECKPOINT], promised_by: PROMISE_1001, margin_min: 20, risk_score: 0, risk_level: "LOW", headline: "On schedule: expected 11:15, 30 min before the promised time" }),
  at0850: snap({ id: "ETA-000301", shipment_id: "SHP-1001", at: ist("08:50"), route_id: "RTE-01", progress_km: 33, remaining_km: 117, factors: [BASE(130), CHECKPOINT], promised_by: PROMISE_1001, margin_min: 20, risk_score: 0, risk_level: "LOW", headline: "On schedule: expected 11:15, 30 min before the promised time" }),
  at0900: snap({ id: "ETA-000306", shipment_id: "SHP-1001", at: ist("09:00"), route_id: "RTE-01", progress_km: 40, remaining_km: 110, factors: [BASE(120), CHECKPOINT], promised_by: PROMISE_1001, margin_min: 20, risk_score: 0, risk_level: "LOW", headline: "On schedule: expected 11:15, 30 min before the promised time" }),
  // DESIGN.md 6.6 step A
  stepA: snap({ id: "ETA-000312", shipment_id: "SHP-1001", at: ist("09:15"), route_id: "RTE-01", progress_km: 50, remaining_km: 100, factors: [BASE(110), CHECKPOINT, { code: "CONGESTION", label: "Slow traffic: 40 km/h against 60 km/h, next 50 km", minutes: 25 }], promised_by: PROMISE_1001, margin_min: 20, risk_score: 50, risk_level: "MEDIUM", confidence: "MEDIUM", headline: "At risk: slow traffic adds 25 min" }),
  // DESIGN.md 6.6 step B = sample 5.7.2
  stepB: (at: string, eventId: string) => snap({ id: "ETA-000318", shipment_id: "SHP-1001", at, trigger_event_id: eventId, route_id: "RTE-01", progress_km: 60, remaining_km: 90, factors: [BASE(100), CHECKPOINT, { code: "ACCIDENT", label: "Accident ahead at km 75 (driver estimate)", minutes: 60 }], promised_by: PROMISE_1001, margin_min: 20, risk_score: 100, risk_level: "HIGH", headline: "Expected 40 min late: accident ahead at km 75 adds 60 min" }),
  // After approving OPT-REROUTE-RTE-01B (6.6 step C projection)
  rerouted: (at: string) => snap({ id: "ETA-000319", shipment_id: "SHP-1001", at, route_id: "RTE-01B", progress_km: 60, remaining_km: 106, factors: [BASE(126, "Remaining drive at normal speed: 6 km to the bypass exit, then 100 km bypass"), { code: "CONGESTION", label: "Slow traffic to the bypass exit at km 66", minutes: 3 }], promised_by: PROMISE_1001, margin_min: 20, risk_score: 35, risk_level: "MEDIUM", headline: "Rerouted via Khalapur bypass: expected 11:39, 6 min before the promised time" }),
  bypass1040: snap({ id: "ETA-000331", shipment_id: "SHP-1001", at: ist("10:40"), route_id: "RTE-01B", progress_km: 49, remaining_km: 51, factors: [BASE(61)], promised_by: PROMISE_1001, margin_min: 20, risk_score: 40, risk_level: "MEDIUM", headline: "On the bypass: expected 11:41, 4 min before the promised time" }),
  bypass1120: snap({ id: "ETA-000337", shipment_id: "SHP-1001", at: ist("11:20"), route_id: "RTE-01B", progress_km: 81, remaining_km: 19, factors: [BASE(22)], promised_by: PROMISE_1001, margin_min: 20, risk_score: 43, risk_level: "MEDIUM", headline: "On the bypass: expected 11:42, 3 min before the promised time" }),
  rescheduled: (at: string) => snap({ id: "ETA-000319", shipment_id: "SHP-1001", at, route_id: "RTE-01", progress_km: 60, remaining_km: 90, factors: [BASE(100), CHECKPOINT, { code: "ACCIDENT", label: "Accident ahead at km 75 (driver estimate)", minutes: 60 }], promised_by: ist("12:45"), margin_min: 20, risk_score: 0, risk_level: "LOW", headline: "New delivery time agreed: 12:45. Expected 12:25" }),
};

export const SNAP_1002 = {
  departed: snap({ id: "ETA-000280", shipment_id: "SHP-1002", at: ist("07:00"), route_id: "RTE-02", progress_km: 0, remaining_km: 180, factors: [BASE(180), { code: "DWELL", label: "Toll plaza at km 140", minutes: 10 }], promised_by: PROMISE_1002, margin_min: 20, risk_score: 0, risk_level: "LOW", headline: "On schedule: expected 10:10, 60 min before the promised time" }),
  weather: snap({ id: "ETA-000296", shipment_id: "SHP-1002", at: ist("08:40"), route_id: "RTE-02", progress_km: 70, remaining_km: 110, factors: [BASE(110), { code: "DWELL", label: "Toll plaza at km 140", minutes: 10 }, { code: "WEATHER", label: "Heavy rain at Kasara ghat, km 120 (default estimate)", minutes: 45 }], promised_by: PROMISE_1002, margin_min: 20, risk_score: 88, risk_level: "HIGH", confidence: "MEDIUM", headline: "Expected 15 min late: heavy rain at Kasara ghat adds 45 min" }),
  rescheduled: (at: string) => snap({ id: "ETA-000320", shipment_id: "SHP-1002", at, route_id: "RTE-02", progress_km: 70, remaining_km: 110, factors: [BASE(110), { code: "DWELL", label: "Toll plaza at km 140", minutes: 10 }, { code: "WEATHER", label: "Heavy rain at Kasara ghat, km 120 (default estimate)", minutes: 45 }], promised_by: ist("11:45"), margin_min: 20, risk_score: 0, risk_level: "LOW", confidence: "MEDIUM", headline: "New delivery time agreed: 11:45. Expected 11:25" }),
};

export const SNAP_1003 = snap({ id: "ETA-000270", shipment_id: "SHP-1003", at: ist("13:00"), route_id: "RTE-01", progress_km: 0, remaining_km: 150, factors: [BASE(180), CHECKPOINT], promised_by: ist("17:00"), margin_min: 20, risk_score: 0, risk_level: "LOW", headline: "On schedule: expected 16:15, 45 min before the promised time" });

/* ---------------- Dashboard history (fictional, 40 delivered shipments) ---------------- */

export const HISTORY = {
  onTime: {
    route: [
      { group_id: "RTE-01", group_name: "Panvel – Pune", delivered: 22, on_time: 17 },
      { group_id: "RTE-02", group_name: "Panvel – Nashik", delivered: 18, on_time: 12 },
    ],
    transporter: [
      { group_id: "TRN-01", group_name: "Sahyadri Bulk Carriers", delivered: 21, on_time: 17 },
      { group_id: "TRN-02", group_name: "Konkan Roadlines", delivered: 19, on_time: 12 },
    ],
  },
  delayCauses: {
    route: [
      { group_id: "RTE-01", group_name: "Panvel – Pune", minutes_by_cause: { CONGESTION: 310, ACCIDENT: 120, BREAKDOWN: 240, WEATHER: 45, LOADING_DELAY: 90, ROAD_CLOSURE: 0 } },
      { group_id: "RTE-02", group_name: "Panvel – Nashik", minutes_by_cause: { CONGESTION: 150, ACCIDENT: 0, BREAKDOWN: 120, WEATHER: 380, LOADING_DELAY: 0, ROAD_CLOSURE: 90 } },
    ],
    transporter: [
      { group_id: "TRN-01", group_name: "Sahyadri Bulk Carriers", minutes_by_cause: { CONGESTION: 280, ACCIDENT: 120, BREAKDOWN: 120, WEATHER: 160, LOADING_DELAY: 60, ROAD_CLOSURE: 0 } },
      { group_id: "TRN-02", group_name: "Konkan Roadlines", minutes_by_cause: { CONGESTION: 180, ACCIDENT: 0, BREAKDOWN: 240, WEATHER: 265, LOADING_DELAY: 30, ROAD_CLOSURE: 90 } },
    ],
  },
};
