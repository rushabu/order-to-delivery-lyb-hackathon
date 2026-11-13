// Deterministic generator for every seed file in database/seed/.
//
// Hand-authored values (config, routes, the live scenario) are written out below.
// Values that should vary (the 40-shipment history, passwords, UUIDs) come from a seeded
// SplitMix64 generator. Same seed, same bytes. No wall clock, no network.
// The output matches the shapes read by backend/src/sim/fixtures.ts; extra fields are
// documented in database/README.md.
//
// Usage (from database/): npm run seed:generate   or   npx tsx scripts/generate-seed.ts --out DIR
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SEED_DIR, SOURCES, Rng, SEED, addMin, haversineKm, header, ist, minutesBetween, readJson, round, waypointsFromProfiles,
  writeJson, type Branch, type LngLat,
} from './seed-lib';

const DAY = '2026-11-16'; // scenario day, a Monday
const NEXT_DAY = '2026-11-17';
const t = (hhmm: string, day = DAY) => ist(day, hhmm);

// ------------------------------------------------------------------ config

function buildConfig() {
  return {
    ...header(),
    note: 'Thresholds and defaults from DESIGN.md sections 6.3 to 6.7. Rupee figures are fictional assumptions.',
    fictional_assumptions: ['options.cost_per_km_inr', 'options.standby_vehicle_cost_inr', 'impact.cost_per_late_hour_inr'],
    eta: {
      pace_window_min: 15,
      pace_min_positions: 3,
      pace_horizon_km: 50,
      slowdown_min: 0.8,
      slowdown_max: 2.0,
      pace_min_factor_min: 3,
      disruption_floor_min: 15,
      margin_floor_min: 20,
      margin_pct: 10,
      stale_after_min: 10,
      stale_margin_max_add_min: 60,
      tracking_lost_after_min: 30,
      risk_medium_from: 35,
      risk_high_from: 70,
    },
    category_default_delay_min: { ACCIDENT: 60, BREAKDOWN: 120, WEATHER: 45, ROAD_CLOSURE: 90, LOADING_DELAY: 30, OTHER: 30 },
    alerts: { resolve_after_low_min: 10 },
    options: {
      valid_for_min: 10,
      improvement_threshold_min: 10,
      cost_per_km_inr: 45,
      standby_vehicle_cost_inr: 4000,
      split_min_quantity_t: 2,
    },
    impact: { cost_per_late_hour_inr: 1500 },
    demo: { speed: 60, position_interval_min: 5, stale_tick_min: 5 },
    // The driver's three-tap report has no location: road problems are placed this far ahead of the truck.
    disruptions: { report_ahead_km: 15 },
    // Generated invoices. Every figure is invented for the demo (database/README.md). The first rule whose
    // text appears in the product name wins, so the more specific names come first.
    invoice: {
      gst_pct: 18,
      default_rate_per_t_inr: 105000,
      rates: [
        { match: 'copolymer', rate_per_t_inr: 112000, hsn: '3902' },
        { match: 'polypropylene', rate_per_t_inr: 104000, hsn: '3902' },
        { match: 'PP', rate_per_t_inr: 104000, hsn: '3902' },
        { match: 'LLDPE', rate_per_t_inr: 110000, hsn: '3901' },
        { match: 'HDPE', rate_per_t_inr: 108000, hsn: '3901' },
        { match: 'LDPE', rate_per_t_inr: 116000, hsn: '3901' },
      ],
    },
    // Live route weather (Open-Meteo). Thresholds are the team's starting values, stated in database/README.md.
    weather: {
      sample_every_km: 40,
      forecast_hours: 3,
      refresh_min: 15,
      moderate: { precipitation_mm: 1, visibility_m: 5000, wind_kmph: 35, delay_min: 10 },
      severe: { precipitation_mm: 4, visibility_m: 1000, wind_kmph: 50, delay_min: 30 },
    },
  };
}

// ------------------------------------------------------------------ parties

function buildCustomers(routes: Record<string, any>) {
  const end = (id: string) => routes[id].geometry.coordinates.at(-1) as LngLat;
  const window = (opens: string, closes: string) => ({ days: 'MON-SAT', opens_local: opens, closes_local: closes, timezone: 'Asia/Kolkata' });
  return {
    ...header(),
    note: 'Fictional business customers and receiving sites for the regional and live-routing demos.',
    customers: [
      {
        id: 'CUS-01', name: 'Deccan Mouldings Pvt Ltd', delivery_lat: end('RTE-01')[1], delivery_lng: end('RTE-01')[0],
        city: 'Ranjangaon MIDC, Pune district', delivery_label: 'Receiving gate', receiving_window: window('08:00', '18:00'),
      },
      {
        id: 'CUS-02', name: 'Godavari Flexipack Pvt Ltd', delivery_lat: end('RTE-02')[1], delivery_lng: end('RTE-02')[0],
        city: 'Satpur MIDC, Nashik', delivery_label: 'Stores gate', receiving_window: window('07:00', '19:00'),
      },
      {
        id: 'CUS-03', name: 'Plant X Demo Customer · Vikhroli', delivery_lat: 19.11454, delivery_lng: 72.92572,
        city: 'Vikhroli West, Mumbai', delivery_label: 'Sample receiving bay', receiving_window: window('09:00', '17:00'),
      },
      {
        id: 'CUS-04', name: 'Plant X Demo Customer · Powai', delivery_lat: 19.11809, delivery_lng: 72.90601,
        city: 'Powai, Mumbai', delivery_label: 'Sample receiving bay', receiving_window: window('09:00', '17:00'),
      },
      {
        id: 'CUS-05', name: 'Plant X Demo Customer · Chakan', delivery_lat: 18.75, delivery_lng: 73.781,
        city: 'Chakan MIDC, Pune district', delivery_label: 'Bulk receiving gate', receiving_window: window('08:00', '18:00'),
      },
    ],
  };
}

const vehicle = (id: string, registration: string, body: string, payload: number, tare: number, standby = false) =>
  ({ id, registration, body, payload_capacity_t: payload, tare_t: tare, standby });

function buildTransporters() {
  return {
    ...header(),
    note: 'Fictional haulage companies. Registrations use the series MH 99, above any Maharashtra RTO code in use.',
    transporters: [
      {
        id: 'TRN-01', name: 'Sahyadri Bulk Carriers', base: 'Panvel area',
        vehicles: [
          vehicle('VEH-S1', 'MH 99 SB 4127', '12-wheeler', 25, 9.6),
          vehicle('VEH-S2', 'MH 99 SB 4385', '14-wheeler', 28, 10.8),
          vehicle('VEH-S3', 'MH 99 SB 5012', '12-wheeler', 25, 9.4, true),
          vehicle('VEH-S4', 'MH 99 SB 5260', '14-wheeler', 28, 10.6),
          vehicle('VEH-S5', 'MH 99 SB 6131', '10-wheeler', 20, 8.4),
          vehicle('VEH-S6', 'MH 99 SB 6140', 'Delivery van', 1.4, 2.1),
        ],
      },
      {
        id: 'TRN-02', name: 'Konkan Roadlines', base: 'Bhiwandi',
        vehicles: [
          vehicle('VEH-K1', 'MH 99 KR 2291', '12-wheeler', 25, 10.0),
          vehicle('VEH-K2', 'MH 99 KR 2617', '14-wheeler', 28, 10.9),
          vehicle('VEH-K3', 'MH 99 KR 3048', '10-wheeler', 20, 8.2),
          vehicle('VEH-K4', 'MH 99 KR 3315', '12-wheeler', 25, 9.8),
          vehicle('VEH-K5', 'MH 99 KR 3320', 'Delivery van', 1.4, 2.1),
        ],
      },
    ],
  };
}

const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXY3479';

function buildUsers(rng: Rng) {
  // Same people and emails as the web app's demo accounts (frontend/src/mocks/fixtures.ts, Login.tsx).
  // Emails use the reserved .example top-level domain.
  const people: [string, string, string, string, string | null, string | null][] = [
    ['USR-COORD-01', 'Meera Kulkarni', 'plantx', 'COORDINATOR', null, null],
    ['USR-COORD-02', 'Farhan Qureshi', 'plantx', 'COORDINATOR', null, null],
    ['USR-DRV-01', 'Ravi Shinde', 'sahyadri', 'DRIVER', null, 'TRN-01'],
    ['USR-DRV-02', 'Gurpreet Sandhu', 'konkan', 'DRIVER', null, 'TRN-02'],
    ['USR-DRV-03', 'Sunil Pawar', 'sahyadri', 'DRIVER', null, 'TRN-01'],
    ['USR-CUST-01', 'Anil Deshpande', 'deccanmouldings', 'CUSTOMER', 'CUS-01', null],
    ['USR-CUST-02', 'Kavita Joshi', 'deccanmouldings', 'CUSTOMER', 'CUS-01', null],
    ['USR-CUST-03', 'Nikhil Bhosale', 'godavariflexi', 'CUSTOMER', 'CUS-02', null],
    // Drivers with no trip in the scenario: free to take a new order. Added last, with their own random
    // stream below, so every earlier password and the history stay exactly as they were.
    ['USR-DRV-04', 'Prakash Jadhav', 'sahyadri', 'DRIVER', null, 'TRN-01'],
    ['USR-DRV-05', 'Imran Shaikh', 'konkan', 'DRIVER', null, 'TRN-02'],
    ['USR-DRV-06', 'Deepak More', 'konkan', 'DRIVER', null, 'TRN-02'],
    ['USR-CUST-04', 'Asha Rao', 'vikhrolidemo', 'CUSTOMER', 'CUS-03', null],
    ['USR-CUST-05', 'Rohan Shah', 'powaidemo', 'CUSTOMER', 'CUS-04', null],
    ['USR-CUST-06', 'Neha Patil', 'chakandemo', 'CUSTOMER', 'CUS-05', null],
  ];
  const extra = new Rng(SEED + 1);
  const users = people.map(([id, name, domain, role, customerId, transporterId], n) => {
    const [first, last] = name.toLowerCase().split(' ');
    const source = n < 8 ? rng : extra;
    const password = Array.from({ length: 14 }, () => source.choice(PASSWORD_ALPHABET.split(''))).join('');
    return {
      id, name, email: `${first}.${last}@${domain}.example`, password, role,
      ...(customerId ? { customer_id: customerId } : {}),
      ...(transporterId ? { transporter_id: transporterId } : {}),
      phone: `+91 00000 ${String(n + 1).padStart(5, '0')}`,
    };
  });
  return {
    ...header(),
    note: 'Fictional people. Passwords are demo values for seeding only; the API hashes them at startup. Phone numbers are not valid Indian numbers.',
    users,
  };
}

// ------------------------------------------------------------------ routes

const PLANT_X = 'Plant X (fictional site, Panvel area)';

interface RouteSpec {
  /** Short road name: the backend writes messages such as "rerouted via {name}". */
  name: string; destination: string; destination_customer_id: string; total_km: number; split_km: number;
  segments: [number, number, number, number][]; max_gross_t: number | null; restriction_note: string | null;
  landmarks: [number, string][];
}

export const ROUTE_SPECS: Record<string, RouteSpec> = {
  'RTE-01': {
    name: 'Talegaon-Chakan road', destination: 'Deccan Mouldings, Ranjangaon MIDC',
    destination_customer_id: 'CUS-01', total_km: 150, split_km: 66,
    segments: [[0, 40, 40, 0], [40, 100, 60, 15], [100, 150, 50, 0]], max_gross_t: null, restriction_note: null,
    landmarks: [
      [40, 'Top of the ghat, Tungarli (Lonavala)'],
      [66, 'Wadgaon (Mawal) junction, NH48 and the Talegaon road (exit to RTE-01B)'],
      [75, 'Induri, Talegaon-Chakan road'],
      [100, 'Checkpoint (fictional stop), Bhose near Chakan'],
    ],
  },
  'RTE-01B': {
    name: 'Pune-Shikrapur road', destination: 'Deccan Mouldings, Ranjangaon MIDC',
    destination_customer_id: 'CUS-01', total_km: 166, split_km: 66,
    segments: [[0, 40, 40, 0], [40, 66, 60, 0], [66, 166, 50, 0]], max_gross_t: null, restriction_note: null,
    landmarks: [[66, 'Wadgaon (Mawal) junction'], [128, 'Wagholi'], [145, 'Shikrapur']],
  },
  'RTE-02': {
    name: 'Kasara ghat road', destination: 'Godavari Flexipack, Satpur MIDC',
    destination_customer_id: 'CUS-02', total_km: 178, split_km: 46,
    segments: [[0, 46, 40, 0], [46, 115, 60, 0], [115, 131, 30, 0], [131, 140, 45, 10], [140, 178, 57, 0]],
    max_gross_t: null, restriction_note: null,
    landmarks: [
      [46, 'Temghar, Bhiwandi bypass junction (exit to RTE-02B)'], [115, 'Foot of Kasara ghat'], [131, 'Igatpuri'],
      [140, 'Toll plaza (fictional stop), Khambale near Igatpuri'],
    ],
  },
  'RTE-02B': {
    name: 'Wada-Trimbakeshwar road', destination: 'Godavari Flexipack, Satpur MIDC',
    destination_customer_id: 'CUS-02', total_km: 209, split_km: 46,
    segments: [[0, 46, 40, 0], [46, 110, 45, 0], [110, 150, 35, 0], [150, 209, 45, 0]],
    max_gross_t: 20, restriction_note: 'Weight-restricted bridge, 20 t gross (fictional restriction)',
    landmarks: [[46, 'Temghar, Bhiwandi bypass junction']],
  },
};

const ALTERNATIVES = [
  { route_id: 'RTE-01', alt_route_id: 'RTE-01B', exit_km: 66 },
  { route_id: 'RTE-02', alt_route_id: 'RTE-02B', exit_km: 46 },
];

/**
 * Per-vertex km markers: vertex 0 is km 0, the end of the shared prefix is split_km, the last
 * vertex is total_km; in between, km is proportional to distance along the line.
 */
export function calibrate(coords: LngLat[], splitIndex: number, splitKm: number, totalKm: number): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineKm(coords[i - 1], coords[i]));
  const prefix = cum[splitIndex];
  const total = cum.at(-1)!;
  const marks = cum.map((d, i) =>
    round(i <= splitIndex ? (splitKm * d) / prefix : splitKm + ((totalKm - splitKm) * (d - prefix)) / (total - prefix), 3));
  marks[splitIndex] = splitKm;
  marks[marks.length - 1] = totalKm;
  return marks;
}

function buildRoutes() {
  const source = readJson(join(SOURCES, 'route_geometry.json'));
  const routes: Record<string, any> = {};
  for (const [id, spec] of Object.entries(ROUTE_SPECS)) {
    const geo = source.routes[id];
    routes[id] = {
      id,
      name: spec.name,
      origin: PLANT_X,
      destination: spec.destination,
      destination_customer_id: spec.destination_customer_id,
      total_km: spec.total_km,
      // chainage_km sits inside the GeoJSON object (a foreign member) so it reaches the database's
      // geometry column with no migration; backend/src/shipments/geometry.ts reads it.
      geometry: {
        type: 'LineString',
        coordinates: geo.coordinates,
        chainage_km: calibrate(geo.coordinates, geo.split_index, spec.split_km, spec.total_km),
      },
      restrictions: { max_gross_t: spec.max_gross_t, closed: false, note: spec.restriction_note },
      segments: spec.segments.map(([a, b, v, d], i) => ({ seq: i + 1, start_km: a, end_km: b, baseline_speed_kmph: v, dwell_after_min: d })),
      landmarks: spec.landmarks.map(([km, label]) => ({ km, label })),
      geometry_source: 'OSRM export of 2026-11-12, simplified; see database/README.md',
    };
  }
  return routes;
}

// ------------------------------------------------------------------ history

const PLAN_MIN: Record<string, number> = { 'RTE-01': 195, 'RTE-02': 232 }; // baseline drive plus dwell
const CUSTOMER_OF: Record<string, string> = { 'RTE-01': 'CUS-01', 'RTE-02': 'CUS-02' };
const PRODUCTS = ['Polypropylene homopolymer, bagged', 'Polypropylene copolymer, bagged', 'HDPE pellets, bagged', 'LLDPE film grade, bagged'];

// [route, transporter, primary causes of the late shipments, shipments in the cell]
const HISTORY_CELLS: [string, string, string[], number][] = [
  ['RTE-01', 'TRN-01', ['CONGESTION', 'LOADING_DELAY'], 12],
  ['RTE-01', 'TRN-02', ['BREAKDOWN', 'CONGESTION', 'ACCIDENT'], 10],
  ['RTE-02', 'TRN-01', ['WEATHER', 'CONGESTION'], 9],
  ['RTE-02', 'TRN-02', ['BREAKDOWN', 'WEATHER', 'ACCIDENT', 'CONGESTION', 'ROAD_CLOSURE'], 9],
];
const CAUSE_RANGE: Record<string, [number, number]> = {
  CONGESTION: [15, 45], ACCIDENT: [55, 120], BREAKDOWN: [85, 130], WEATHER: [30, 75], LOADING_DELAY: [20, 40], ROAD_CLOSURE: [60, 100],
};
const SECONDARY_CONGESTION = new Set(['ACCIDENT', 'ROAD_CLOSURE']); // these also pick up queueing traffic
const FORCED_LATE: Record<string, number> = { 'RTE-01|TRN-01|CONGESTION': 12, 'RTE-02|TRN-02|BREAKDOWN': 140 };
const FORCED_EARLY: Record<string, number> = { 'RTE-01|TRN-01': 5, 'RTE-02|TRN-01': 50 };

interface Slot { route: string; late: boolean; causes?: [string, number][]; early?: number | null }

function historyOutcomes(rng: Rng): Record<string, Slot[]> {
  const slots: Record<string, Slot[]> = { 'TRN-01': [], 'TRN-02': [] };
  for (const [route, trn, lateCauses, n] of HISTORY_CELLS) {
    for (const cause of lateCauses) {
      const forced = FORCED_LATE[`${route}|${trn}|${cause}`];
      const causes: [string, number][] = forced ? [[cause, forced]] : [[cause, rng.randint(...CAUSE_RANGE[cause])]];
      if (!forced && SECONDARY_CONGESTION.has(cause)) causes.push(['CONGESTION', rng.randint(6, 15)]);
      slots[trn].push({ route, late: true, causes });
    }
    for (let k = 0; k < n - lateCauses.length; k++) {
      slots[trn].push({ route, late: false, early: k === 0 ? FORCED_EARLY[`${route}|${trn}`] ?? null : null });
    }
  }
  return slots;
}

function ceilQuarter(iso: string): string {
  const minute = Number(iso.slice(14, 16));
  return addMin(iso, (15 - (minute % 15)) % 15);
}

function buildHistory(rng: Rng, transporters: ReturnType<typeof buildTransporters>) {
  const vehicles = Object.fromEntries(transporters.transporters.flatMap((tr) => tr.vehicles.map((v) => [v.id, v])));
  const days: string[] = [];
  for (let d = Date.UTC(2026, 9, 17); d <= Date.UTC(2026, 10, 14); d += 86_400_000) {
    if (new Date(d).getUTCDay() !== 0) days.push(new Date(d).toISOString().slice(0, 10)); // 15 Nov is a Sunday
  }
  const slots = historyOutcomes(rng);
  // A driver does at most one trip a day. Sahyadri has two drivers, Konkan one.
  const byDay = (a: [string, string], b: [string, string]) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1);
  const trips: Record<string, [string, string][]> = {
    'TRN-01': [
      ...rng.sample(days, 11).map((d) => [d, 'USR-DRV-01'] as [string, string]),
      ...rng.sample(days, 10).map((d) => [d, 'USR-DRV-03'] as [string, string]),
    ].sort(byDay),
    'TRN-02': rng.sample(days, 19).map((d) => [d, 'USR-DRV-02'] as [string, string]).sort(byDay),
  };
  const kRotation = ['VEH-K1', 'VEH-K2', 'VEH-K3'];
  const records: any[] = [];
  for (const trn of ['TRN-01', 'TRN-02']) {
    const cellSlots = slots[trn];
    rng.shuffle(cellSlots);
    cellSlots.forEach((slot, n) => {
      const [day, driver] = trips[trn][n];
      const route = slot.route;
      const quantity = 16 + 0.5 * rng.randint(0, 24);
      let vid: string;
      if (driver === 'USR-DRV-01') vid = quantity <= 25 ? 'VEH-S1' : 'VEH-S2';
      else if (driver === 'USR-DRV-03') vid = 'VEH-S4';
      else {
        const fits = kRotation.filter((v) => vehicles[v].payload_capacity_t >= quantity);
        vid = fits[n % fits.length];
      }
      const hour = rng.randint(6, 10);
      const quarter = rng.randint(0, 3);
      const departure = ist(day, `${String(hour).padStart(2, '0')}:${String(quarter * 15).padStart(2, '0')}`);
      const plannedArrival = addMin(departure, PLAN_MIN[route]);
      const slack = rng.choice([30, 45, 60]);
      const promised = ceilQuarter(addMin(plannedArrival, slack));
      let lateness: number;
      let causes: { cause: string; minutes: number }[] = [];
      let primary: string | null = null;
      if (slot.late) {
        causes = slot.causes!.map(([cause, minutes]) => ({ cause, minutes }));
        lateness = causes.reduce((s, c) => s + c.minutes, 0);
        primary = causes.reduce((a, b) => (b.minutes > a.minutes ? b : a)).cause;
      } else {
        const effectiveSlack = minutesBetween(plannedArrival, promised);
        lateness = -(slot.early ?? rng.randint(5, Math.min(50, effectiveSlack + 20)));
      }
      records.push({
        customer_id: CUSTOMER_OF[route],
        transporter_id: trn,
        route_id: route,
        product: rng.choice(PRODUCTS),
        quantity_t: quantity,
        gross_t: round(quantity + vehicles[vid].tare_t, 1),
        vehicle_reg: vehicles[vid].registration,
        planned_departure: departure,
        original_promised_by: promised,
        actual_arrival: addMin(promised, lateness),
        delay_causes: causes,
        driver_user_id: driver,
        vehicle_id: vid,
        planned_arrival: plannedArrival,
        lateness_min: lateness,
        on_time: lateness <= 0,
        primary_cause: primary,
      });
    });
  }
  records.sort((a, b) => (a.planned_departure + a.driver_user_id < b.planned_departure + b.driver_user_id ? -1 : 1));
  return {
    ...header(),
    note: 'Fictional delivered shipments, 17 Oct to 14 Nov 2026 (none on Sundays). lateness_min = actual_arrival - original_promised_by; on time when <= 0. For late shipments delay_causes minutes sum to lateness_min.',
    shipments: records.map((r, i) => ({ shipment_id: `SHP-${String(901 + i).padStart(4, '0')}`, order_id: `ORD-${4901 + i}`, ...r })),
  };
}

// ------------------------------------------------------------------ live scenario

/** Ground-truth speed profiles: the source of the waypoints. See database/README.md, "Tuning". */
export const GROUND_TRUTH_SOURCE: Record<string, { departure: string; base_route_id: string; branch_km: number; branches: Record<string, Branch> }> = {
  'SHP-1001': {
    departure: t('08:00'),
    base_route_id: 'RTE-01',
    branch_km: 66,
    branches: {
      'RTE-01': {
        speed_profile: [
          { route_id: 'RTE-01', from_km: 0, to_km: 40, speed_kmph: 40 },
          { route_id: 'RTE-01', from_km: 40, to_km: 75, speed_kmph: 40, note: 'Slow traffic from km 40' },
          { route_id: 'RTE-01', from_km: 75, to_km: 100, speed_kmph: 60 },
          { route_id: 'RTE-01', from_km: 100, to_km: 150, speed_kmph: 50 },
        ],
        incidents: [{ route_id: 'RTE-01', km: 75, category: 'ACCIDENT', start: t('09:20'), clear: t('11:00') }],
        dwells: [{ route_id: 'RTE-01', km: 100, minutes: 15 }],
      },
      'RTE-01B': {
        speed_profile: [
          { route_id: 'RTE-01', from_km: 0, to_km: 40, speed_kmph: 40 },
          { route_id: 'RTE-01', from_km: 40, to_km: 66, speed_kmph: 40, note: 'Slow traffic from km 40' },
          { route_id: 'RTE-01B', from_km: 66, to_km: 126, speed_kmph: 50 },
          { route_id: 'RTE-01B', from_km: 126, to_km: 131, speed_kmph: 30, note: 'Town traffic through Wagholi' },
          { route_id: 'RTE-01B', from_km: 131, to_km: 166, speed_kmph: 50 },
        ],
        incidents: [],
        dwells: [],
      },
    },
  },
  'SHP-1002': {
    // 08:35, so the 15 minutes of positions the backend seeds before the 08:50 clock start are all after departure.
    departure: t('08:35'),
    base_route_id: 'RTE-02',
    branch_km: 46,
    branches: {
      'RTE-02': {
        speed_profile: [
          { route_id: 'RTE-02', from_km: 0, to_km: 46, speed_kmph: 40 },
          { route_id: 'RTE-02', from_km: 46, to_km: 115, speed_kmph: 60 },
          { route_id: 'RTE-02', from_km: 115, to_km: 131, speed_kmph: 24, note: 'Wet ghat road after the hold' },
          { route_id: 'RTE-02', from_km: 131, to_km: 140, speed_kmph: 45 },
          { route_id: 'RTE-02', from_km: 140, to_km: 178, speed_kmph: 57 },
        ],
        incidents: [{ route_id: 'RTE-02', km: 115, category: 'WEATHER', start: t('09:00'), clear: t('12:00') }],
        dwells: [{ route_id: 'RTE-02', km: 140, minutes: 10 }],
      },
    },
  },
};
const DELIVER_AFTER_MIN = 15;

function buildScenario(rng: Rng, transporters: ReturnType<typeof buildTransporters>) {
  const reg = (id: string) => transporters.transporters.flatMap((tr) => tr.vehicles).find((v) => v.id === id)!.registration;
  const groundTruth = Object.fromEntries(
    Object.entries(GROUND_TRUTH_SOURCE).map(([id, g]) => [
      id,
      { ...waypointsFromProfiles(g.departure, g.branch_km, g.base_route_id, g.branches, DELIVER_AFTER_MIN), derived_from: g },
    ]),
  );
  const shipment = (o: Record<string, unknown>) => ({ ...o, vehicle_reg: reg(o.vehicle_id as string) });
  return {
    ...header(),
    note: 'Live demo for 16 Nov 2026. Times are UTC; IST is UTC+5:30. ground_truth waypoints {at, km} are linear between points and are derived from derived_from (speed profiles, incidents, dwells) by the generator.',
    scenario_id: 'main',
    day: DAY,
    clock_start: t('08:50'),
    pause_at: [t('09:15'), t('09:30')],
    pause_labels: {
      [t('09:15')]: 'SHP-1001 risk turns MEDIUM; open the factor list',
      [t('09:30')]: 'Driver of SHP-1001 reports the accident live; stay paused until the coordinator decides',
    },
    standby_vehicles: [{ vehicle_reg: reg('VEH-S3'), transporter_id: 'TRN-01', available: true, vehicle_id: 'VEH-S3' }],
    orders: [
      { id: 'ORD-5001', customer_id: 'CUS-01', product: 'Polypropylene homopolymer, bagged', quantity_t: 24, original_promised_by: t('11:45'), agreed_delivery_by: t('11:45') },
      { id: 'ORD-5002', customer_id: 'CUS-02', product: 'HDPE pellets, bagged', quantity_t: 24, original_promised_by: t('13:00'), agreed_delivery_by: t('13:00') },
      { id: 'ORD-5003', customer_id: 'CUS-02', product: 'LLDPE film grade, bagged', quantity_t: 26, original_promised_by: t('14:45'), agreed_delivery_by: t('14:45') },
      { id: 'ORD-5004', customer_id: 'CUS-01', product: 'Polypropylene copolymer, bagged', quantity_t: 20, original_promised_by: t('13:00', NEXT_DAY), agreed_delivery_by: t('13:00', NEXT_DAY) },
      { id: 'ORD-5005', customer_id: 'CUS-02', product: 'HDPE pellets, bagged', quantity_t: 22, original_promised_by: t('12:45', NEXT_DAY), agreed_delivery_by: t('12:45', NEXT_DAY) },
    ],
    shipments: [
      shipment({
        id: 'SHP-1001', order_id: 'ORD-5001', transporter_id: 'TRN-01', driver_user_id: 'USR-DRV-01', vehicle_id: 'VEH-S1',
        quantity_t: 24, gross_t: 33.6, status: 'IN_TRANSIT', route_id: 'RTE-01', planned_departure: t('08:00'),
        created_at: t('18:00', '2026-11-15'),
        milestones: [{ status: 'DISPATCHED', at: t('07:40') }, { status: 'IN_TRANSIT', at: t('08:00') }],
        disruptions: [], role_in_demo: 'Main story: predicted delay, then reroute',
      }),
      shipment({
        id: 'SHP-1002', order_id: 'ORD-5002', transporter_id: 'TRN-02', driver_user_id: 'USR-DRV-02', vehicle_id: 'VEH-K1',
        quantity_t: 24, gross_t: 34.0, status: 'IN_TRANSIT', route_id: 'RTE-02', planned_departure: t('08:35'),
        created_at: t('18:30', '2026-11-15'),
        milestones: [{ status: 'DISPATCHED', at: t('08:15') }, { status: 'IN_TRANSIT', at: t('08:35') }],
        disruptions: [], role_in_demo: 'Alternative route unavailable; agree a new time',
      }),
      shipment({
        id: 'SHP-1003', order_id: 'ORD-5003', transporter_id: 'TRN-01', driver_user_id: 'USR-DRV-03', vehicle_id: 'VEH-S4',
        quantity_t: 26, gross_t: 36.6, loaded_t: 14, status: 'PLANNED', route_id: 'RTE-02', planned_departure: t('10:30'),
        created_at: t('19:00', '2026-11-15'), milestones: [],
        disruptions: [{
          id: rng.uuid4(), category: 'LOADING_DELAY', at_km: null, expected_delay_min: 60, reported_at: t('08:20'),
          reported_by: 'USR-DRV-03', note: 'Bagging line fault at the loading bay; loading paused, about an hour',
        }],
        role_in_demo: 'Split-shipment case; used by tests, not shown in the four-minute demo',
      }),
      shipment({
        id: 'SHP-1004', order_id: 'ORD-5004', transporter_id: 'TRN-01', driver_user_id: 'USR-DRV-01', vehicle_id: 'VEH-S2',
        quantity_t: 20, gross_t: 30.8, status: 'PLANNED', route_id: 'RTE-01', planned_departure: t('08:30', NEXT_DAY),
        created_at: t('08:15'), milestones: [], disruptions: [], role_in_demo: 'Quiet: Deccan Mouldings, tomorrow',
      }),
      shipment({
        id: 'SHP-1005', order_id: 'ORD-5005', transporter_id: 'TRN-02', driver_user_id: 'USR-DRV-02', vehicle_id: 'VEH-K2',
        quantity_t: 22, gross_t: 32.9, status: 'PLANNED', route_id: 'RTE-02', planned_departure: t('07:30', NEXT_DAY),
        created_at: t('08:20'), milestones: [], disruptions: [], role_in_demo: 'Quiet: Godavari Flexipack, tomorrow',
      }),
    ],
    ground_truth: groundTruth,
    scripted_events: [{
      at: t('09:20'), shipment_id: 'SHP-1002', type: 'DISRUPTION_REPORTED',
      payload: {
        disruption_id: rng.uuid4(), category: 'WEATHER', expected_delay_min: 60, at_km: 115,
        note: 'Heavy rain; traffic being held at Kasara ghat, about an hour',
      },
      actor_user_id: 'USR-DRV-02',
      note: 'Nobody drives SHP-1002 in the demo, so its driver report is played by the simulator: the one exception to "the simulator supplies positions only" (DESIGN.md section 10.4).',
    }],
    reference_human_events: [{
      expected_around: t('09:30'), shipment_id: 'SHP-1001', actor_user_id: 'USR-DRV-01',
      note: 'Made live by the presenter on the driver screen. Reference only; the simulator never sends it.',
      type: 'DISRUPTION_REPORTED',
      event_id: '5f0c2c1e-8a4b-4f6d-9a57-2f3f1f0b7a11',
      payload: { disruption_id: '9b1d6c70-3c55-4f0e-8d0a-6f1f5a2c4e22', category: 'ACCIDENT', expected_delay_min: 60, at_km: 75, note: 'Accident ahead, one lane closed' },
    }],
  };
}

// ------------------------------------------------------------------ main

export function generate(outDir: string = SEED_DIR): string[] {
  mkdirSync(outDir, { recursive: true });
  const rng = new Rng(SEED);
  const routes = buildRoutes();
  const customers = buildCustomers(routes);
  const orderRoutes = Object.values(readJson(join(SOURCES, 'order_route_geometry.json'))) as (typeof routes)[string][];
  for (const route of orderRoutes) {
    const site = customers.customers.find((customer) => customer.id === route.destination_customer_id)!;
    route.geometry.coordinates[route.geometry.coordinates.length - 1] = [site.delivery_lng, site.delivery_lat];
    if (route.restrictions.max_gross_t !== 3.5) route.geometry.coordinates[0] = routes['RTE-01'].geometry.coordinates[0];
  }
  const transporters = buildTransporters();
  const files: Record<string, unknown> = {
    'config.json': buildConfig(),
    'customers.json': customers,
    'transporters.json': transporters,
    'users.json': buildUsers(rng),
    'routes.json': { ...header(), note: 'Fictional routes on real roads. geometry.chainage_km gives the km of each vertex (database/README.md).', routes: [...Object.values(routes), ...orderRoutes], alternatives: ALTERNATIVES },
    'history.json': buildHistory(rng, transporters),
    'scenario-main.json': buildScenario(rng, transporters),
  };
  for (const [name, obj] of Object.entries(files)) writeJson(join(outDir, name), obj);
  return Object.keys(files).sort();
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? resolve(process.argv[i + 1]) : SEED_DIR;
  for (const name of generate(out)) console.log('wrote', join(out, name));
}
