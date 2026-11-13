import { randomInt } from 'node:crypto';
import type { LngLat } from '../shipments/geometry';
import type { Fixtures } from '../sim/fixtures';

export const LIVE_SHIPMENT_PREFIX = 'SHP-LIVE';
export type DemoArea = 'mumbai' | 'regional';

const VEHICLES = {
  light: { label: 'Light rigid', tare_t: 7, max_gross_t: 18, height_m: 3.4, width_m: 2.45, length_m: 8 },
  standard: { label: 'Rigid truck', tare_t: 10, max_gross_t: 34, height_m: 4, width_m: 2.5, length_m: 12 },
  heavy: { label: 'Tractor-trailer', tare_t: 12, max_gross_t: 42, height_m: 4, width_m: 2.55, length_m: 16 },
};
const CITY_VAN = { label: 'Delivery van', tare_t: 2.1, max_gross_t: 3.5, height_m: 2.45, width_m: 2.05, length_m: 5.4 };

/** Smallest listed vehicle that carries this gross weight. TomTom truck routing needs its size. */
export function vehicleFor(grossT: number): ShipmentDraft['vehicle'] {
  return [CITY_VAN, VEHICLES.light, VEHICLES.standard, VEHICLES.heavy].find((v) => grossT <= v.max_gross_t) ?? VEHICLES.heavy;
}

const PRODUCTS = ['PP pellets', 'HDPE pellets', 'LDPE resin'] as const;
const CITY_PRODUCTS = ['PP sample cartons', 'HDPE sample cartons'] as const;
export const PRESETS = [
  { id: 'kandivali-vikhroli', lane: 'kandivali-vikhroli', product: CITY_PRODUCTS[0], load: 0.6, vehicle: 'van', stop: 7, slack: 10 },
  { id: 'goregaon-powai', lane: 'goregaon-powai', product: CITY_PRODUCTS[1], load: 0.8, vehicle: 'van', stop: 5, slack: 10 },
  { id: 'ranjangaon-standard', lane: 'ranjangaon', product: PRODUCTS[0], load: 24, vehicle: 'standard', stop: 15, slack: 5 },
  { id: 'satpur-heavy', lane: 'satpur', product: PRODUCTS[1], load: 28, vehicle: 'heavy', stop: 20, slack: 15 },
  { id: 'chakan-light', lane: 'chakan', product: PRODUCTS[2], load: 8, vehicle: 'light', stop: 10, slack: 25 },
] as const;

export interface DemoLane {
  id: (typeof PRESETS)[number]['lane'];
  area: DemoArea;
  label: string;
  origin_name: string;
  destination_name: string;
  customer_id: string;
  origin: LngLat;
  destination: LngLat;
}

export interface ShipmentDraft {
  preset_id: string | null;
  seed: number | null;
  area: DemoArea;
  lane: string;
  customer_name: string;
  product: string;
  quantity_t: number;
  gross_t: number;
  vehicle: (typeof VEHICLES)[keyof typeof VEHICLES];
  stop_min: number;
  promise_buffer_min: number;
}

interface DraftPlan { draft: ShipmentDraft; lane: DemoLane }

export function demoLanes(fixtures: Fixtures): DemoLane[] {
  const pune = fixtures.routes.find((route) => route.id === 'RTE-01');
  const nashik = fixtures.routes.find((route) => route.id === 'RTE-02');
  if (!pune?.geometry || !nashik?.geometry || pune.total_km <= 100) return [];
  const origin = pune.geometry.coordinates[0];
  const origin_name = pune.origin;
  const lanes: Omit<DemoLane, 'destination' | 'destination_name'>[] = [
    // Public map locations anchor the demo. The dispatch and receiving points are fictional.
    { id: 'kandivali-vikhroli', area: 'mumbai', label: 'Kandivali → Vikhroli', origin_name: 'Kandivali East · Akurli Road',
      origin: [72.86619, 19.20127], customer_id: 'CUS-03' },
    { id: 'goregaon-powai', area: 'mumbai', label: 'Goregaon → Powai', origin_name: 'Goregaon East · Western Express Highway',
      origin: [72.85652, 19.15272], customer_id: 'CUS-04' },
    { id: 'ranjangaon', area: 'regional', label: 'Panvel → Ranjangaon', origin, origin_name, customer_id: 'CUS-01' },
    { id: 'satpur', area: 'regional', label: 'Panvel → Satpur, Nashik', origin, origin_name, customer_id: 'CUS-02' },
    { id: 'chakan', area: 'regional', label: 'Panvel → Chakan', origin, origin_name, customer_id: 'CUS-05' },
  ];
  return lanes.flatMap((lane) => {
    const customer = fixtures.customers.find((entry) => entry.id === lane.customer_id);
    if (!customer) return [];
    return [{ ...lane, destination: [customer.delivery_lng, customer.delivery_lat],
      destination_name: [customer.city ?? customer.name, customer.delivery_label].filter(Boolean).join(' · ') }];
  });
}

function plan(fixtures: Fixtures, lane: DemoLane, product: string, quantity: number, vehicle: ShipmentDraft['vehicle'], stop: number, slack: number, source: Pick<ShipmentDraft, 'preset_id' | 'seed'>): DraftPlan {
  return { lane, draft: {
    ...source, area: lane.area, lane: lane.label, customer_name: fixtures.customers.find((customer) => customer.id === lane.customer_id)!.name,
    product, quantity_t: quantity, gross_t: Math.round((quantity + vehicle.tare_t) * 10) / 10, vehicle, stop_min: stop, promise_buffer_min: slack,
  } };
}

export function presetPlans(fixtures: Fixtures): DraftPlan[] {
  const lanes = demoLanes(fixtures);
  if (!lanes.length) return [];
  return PRESETS.flatMap((preset) => {
    const lane = lanes.find((item) => item.id === preset.lane);
    return lane ? [plan(fixtures, lane, preset.product, preset.load,
      preset.vehicle === 'van' ? CITY_VAN : VEHICLES[preset.vehicle], preset.stop, preset.slack, { preset_id: preset.id, seed: null })] : [];
  });
}

export function generatedPlan(fixtures: Fixtures, seed = randomInt(0, 0x100000000), area: DemoArea = 'regional'): DraftPlan | undefined {
  const lanes = demoLanes(fixtures).filter((lane) => lane.area === area);
  if (!lanes.length) return undefined;
  let state = seed;
  // Mix consecutive seeds before selecting from the small set of lanes and load profiles.
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000;
  };
  const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)];
  const lane = pick(lanes);
  if (area === 'mumbai') {
    const quantity = pick([0.3, 0.6, 0.8, 1.0, 1.2]);
    return plan(fixtures, lane, pick(CITY_PRODUCTS), quantity, CITY_VAN, pick([5, 7, 10]), pick([5, 10, 15]), { preset_id: null, seed });
  }
  const vehicle = pick(Object.values(VEHICLES));
  const quantity = 6 + Math.floor(next() * (vehicle.max_gross_t - vehicle.tare_t - 5));
  return plan(fixtures, lane, pick(PRODUCTS), quantity, vehicle, pick([10, 15, 20, 25]), pick([5, 15, 25, 35]), { preset_id: null, seed });
}
