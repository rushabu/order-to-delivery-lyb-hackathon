// Loads the fictional fixture files (DESIGN.md 10.1). The real files live in /fixtures (owned by the
// data agent); until they land on main, the API falls back to the stand-ins in /test/fixtures-stub.
import type { InvoiceRates } from '../invoices/invoicePdf';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EtaConfig } from '../eta/types';
import type { WeatherConfig } from '../weather/weather';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Seed data lives in the repository's database/seed folder.
export const REAL_FIXTURES_DIR = join(ROOT, '..', 'database', 'seed');
export const STUB_FIXTURES_DIR = join(ROOT, 'test', 'fixtures-stub');

export interface FixtureConfig {
  eta: EtaConfig;
  category_default_delay_min: Record<string, number>;
  alerts: { resolve_after_low_min: number };
  options: {
    valid_for_min: number;
    improvement_threshold_min: number;
    cost_per_km_inr: number;
    standby_vehicle_cost_inr: number;
    split_min_quantity_t: number;
  };
  impact: { cost_per_late_hour_inr: number };
  demo: { speed: number; position_interval_min: number; stale_tick_min: number };
  /** Where a driver's report without a location is placed; defaults to 15 km ahead (events/ingest.ts). */
  disruptions?: { report_ahead_km: number };
  /** Open-Meteo sampling and grading; defaults in weather/weather.ts when absent. */
  weather?: WeatherConfig;
  /** Fictional rates and GST for generated invoices; defaults in invoices/invoicePdf.ts when absent. */
  invoice?: InvoiceRates;
}

export interface FixtureUser {
  id: string;
  name: string;
  email: string;
  password: string;
  role: 'COORDINATOR' | 'DRIVER' | 'CUSTOMER';
  customer_id?: string;
  transporter_id?: string;
  phone?: string;
}

export interface FixtureRoute {
  /** The customer this road leads to; used to pick the route for a new order. Absent in the test stand-ins. */
  destination_customer_id?: string;
  id: string;
  name: string;
  origin: string;
  destination: string;
  total_km: number;
  /** chainage_km (optional): km of each vertex; see backend/src/shipments/geometry.ts. */
  geometry: { type: 'LineString'; coordinates: [number, number][]; chainage_km?: number[] } | null;
  restrictions: { max_gross_t: number | null; closed: boolean };
  segments: { seq: number; start_km: number; end_km: number; baseline_speed_kmph: number; dwell_after_min: number }[];
}

export interface Waypoint {
  at: string;
  km: number;
}

export interface GroundTruth {
  deliver_after_min: number;
  common: Waypoint[];
  /** Keyed by the route the truck is on after the common part. */
  branches: Record<string, Waypoint[]>;
}

export interface Scenario {
  scenario_id: string;
  clock_start: string;
  pause_at: string[];
  /** Optional label per pause time, shown while the replay waits for the presenter. */
  pause_labels?: Record<string, string>;
  standby_vehicles: { vehicle_reg: string; transporter_id: string; available: boolean }[];
  orders: {
    id: string;
    customer_id: string;
    product: string;
    quantity_t: number;
    original_promised_by: string;
    agreed_delivery_by: string;
  }[];
  shipments: {
    id: string;
    order_id: string;
    transporter_id: string;
    driver_user_id: string | null;
    vehicle_reg: string;
    quantity_t: number;
    gross_t: number;
    status: 'PLANNED' | 'DISPATCHED' | 'IN_TRANSIT';
    route_id: string;
    planned_departure: string;
    created_at: string;
    milestones: { status: string; at: string }[];
    disruptions: {
      id: string;
      category: string;
      at_km: number | null;
      expected_delay_min?: number;
      note?: string;
      reported_at: string;
    }[];
  }[];
  ground_truth: Record<string, GroundTruth>;
  /** Background events posted by the simulator at fixed times (never the presented human beats). */
  scripted_events?: { at: string; shipment_id: string; type: string; payload: Record<string, unknown> }[];
}

export interface HistoryShipment {
  shipment_id: string;
  order_id: string;
  customer_id: string;
  transporter_id: string;
  route_id: string;
  product: string;
  quantity_t: number;
  gross_t: number;
  vehicle_reg: string;
  planned_departure: string;
  original_promised_by: string;
  actual_arrival: string;
  delay_causes: { cause: string; minutes: number }[];
}

export interface Fixtures {
  dir: string;
  config: FixtureConfig;
  users: FixtureUser[];
  customers: { id: string; name: string; delivery_lat: number; delivery_lng: number }[];
  transporters: {
    id: string;
    name: string;
    /** The fleet, used to choose a truck for a new order (orders/plan.ts). Absent in the test stand-ins. */
    vehicles?: { registration: string; payload_capacity_t: number; tare_t: number; standby: boolean }[];
  }[];
  routes: FixtureRoute[];
  alternatives: { route_id: string; alt_route_id: string; exit_km: number }[];
  history: HistoryShipment[];
  scenario: Scenario;
}

function read<T>(dir: string, file: string): T & { fictional?: boolean } {
  const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  if (data.fictional !== true) throw new Error(`${file} must declare "fictional": true`);
  return data;
}

export function defaultFixturesDir(): string {
  return existsSync(join(REAL_FIXTURES_DIR, 'scenario-main.json')) ? REAL_FIXTURES_DIR : STUB_FIXTURES_DIR;
}

export function loadFixtures(dir: string = defaultFixturesDir()): Fixtures {
  const routes = read<{ routes: FixtureRoute[]; alternatives: Fixtures['alternatives'] }>(dir, 'routes.json');
  return {
    dir,
    config: read<FixtureConfig>(dir, 'config.json'),
    users: read<{ users: FixtureUser[] }>(dir, 'users.json').users,
    customers: read<{ customers: Fixtures['customers'] }>(dir, 'customers.json').customers,
    transporters: read<{ transporters: Fixtures['transporters'] }>(dir, 'transporters.json').transporters,
    routes: routes.routes,
    alternatives: routes.alternatives,
    history: read<{ shipments: HistoryShipment[] }>(dir, 'history.json').shipments,
    scenario: read<Scenario>(dir, 'scenario-main.json'),
  };
}
