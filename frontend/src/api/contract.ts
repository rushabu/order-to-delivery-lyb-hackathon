/*
  API contract as the web app consumes it (DESIGN.md section 5).

  Source of each type:
  - SAMPLE   : copied from a sample payload in DESIGN.md 5.7 (authoritative).
  - ENTITY   : built from the entity fields listed in DESIGN.md 5.2; no sample payload exists.
  - PROPOSED : the screen needs this and DESIGN.md does not define it. Listed in CONTRACT_GAPS.md
               for the API owner to confirm. Do not rely on it elsewhere without checking that file.

  When the API serves /openapi.json, `npm run sync:api` writes src/api/types.gen.ts.
  This file should then re-export from the generated types instead of declaring them.
*/

export type Role = "COORDINATOR" | "DRIVER" | "CUSTOMER";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type ShipmentStatus = "PLANNED" | "DISPATCHED" | "IN_TRANSIT" | "ARRIVED" | "DELIVERED" | "CANCELLED";
export type DisruptionCategory = "ACCIDENT" | "BREAKDOWN" | "WEATHER" | "ROAD_CLOSURE" | "LOADING_DELAY" | "OTHER";
export type FactorCode = "BASE_TRAVEL" | "DWELL" | "CONGESTION" | DisruptionCategory | string;
export type OptionType = "REROUTE" | "CONTINUE" | "RESCHEDULE" | "SPLIT_SHIPMENT";
export type AlertStatus = "OPEN" | "DECIDED" | "RESOLVED";
export type ApplyStatus = "APPLIED" | "DUPLICATE" | "STORED_NOT_APPLIED";

/** ENTITY (5.2 users) — response of POST /auth/login and GET /me */
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  customer_id?: string | null;
  transporter_id?: string | null;
}

export interface LoginResponse {
  token: string;
  user: User;
}

/** SAMPLE 5.7.2 */
export interface EtaFactor {
  code: FactorCode;
  label: string;
  minutes: number;
}

/** SAMPLE 5.7.2 */
export interface EtaSnapshot {
  id: string;
  shipment_id: string;
  computed_at: string;
  trigger_event_id?: string | null;
  route_id: string;
  progress_km: number;
  remaining_km: number;
  eta: string;
  eta_window: { earliest: string; latest: string };
  promised_by: string;
  slack_min: number;
  margin_min: number;
  risk_score: number;
  risk_level: RiskLevel;
  confidence: Confidence;
  position_age_min: number;
  factors: EtaFactor[];
  headline: string;
}

/** ENTITY (5.2 shipments.last_position) */
export interface Position {
  lat: number;
  lng: number;
  progress_km: number;
  occurred_at: string;
}

/** ENTITY (5.2 alerts) */
export interface Alert {
  id: string;
  shipment_id: string;
  level: RiskLevel;
  status: AlertStatus;
  opened_at: string;
  first_snapshot_id: string;
  resolved_at?: string | null;
}

/** ENTITY (5.2 disruptions) */
export interface Disruption {
  id: string;
  shipment_id: string;
  category: DisruptionCategory;
  at_km?: number | null;
  expected_delay_min: number;
  estimate_source: "DRIVER" | "DEFAULT";
  reported_at: string;
  cleared_at?: string | null;
}

/** PROPOSED: "milestones" in GET /shipments/:id (5.5) has no field list */
export interface Milestone {
  status: ShipmentStatus;
  at: string | null;
}

/** ENTITY (5.2 orders) */
export interface Order {
  id: string;
  customer_id: string;
  product: string;
  quantity_t: number;
  original_promised_by: string;
  agreed_delivery_by: string;
}

/**
  GET /shipments/:id — 5.5 lists: order, route id, milestones, last position, current ETA snapshot,
  open alert, active disruptions. Field names below follow 5.2 where possible.
  PROPOSED: customer_name, destination_name, transporter_name, driver_name (coordinator and own
  driver only, 5.4), planned_route_id.
*/
export interface ShipmentDetail {
  id: string;
  order: Order;
  customer_name: string; // PROPOSED
  destination_name: string; // PROPOSED
  transporter_id: string;
  transporter_name: string; // PROPOSED
  driver_name?: string | null; // PROPOSED; must be absent for customers (5.4)
  vehicle_reg: string;
  quantity_t: number;
  gross_t: number;
  status: ShipmentStatus;
  active_route_id: string;
  planned_route_id: string; // PROPOSED: needed to fade the old route after a reroute
  planned_departure: string;
  last_position: Position | null;
  milestones: Milestone[];
  current_eta: EtaSnapshot | null;
  open_alert: Alert | null;
  active_disruptions: Disruption[];
  version: number;
  live_traffic?: LiveTraffic;
  /** Coordinators and the customer only (absent for drivers); null until one is uploaded. */
  invoice?: InvoiceMeta | null;
  /** Orders added to this truck at dispatch; quantity_t already includes them. */
  extra_orders?: { id: string; product: string; quantity_t: number; promised_by: string }[];
}

export interface InvoiceMeta {
  filename: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by_name: string;
}

export interface LiveTraffic {
  source: "TomTom";
  status: "LIVE" | "STALE" | "UNAVAILABLE";
  fetched_at: string | null;
  drive_minutes: number | null;
  traffic_delay_min: number | null;
  sections: { category: string; coordinates: [number, number][] }[];
}

export interface RoadConditions {
  route_id: string;
  fetched_at: string;
  horizon_km: number;
  flow_status: "LIVE" | "PARTIAL" | "UNAVAILABLE";
  incidents_status: "LIVE" | "UNAVAILABLE";
  flow: {
    coordinates: [number, number][];
    at_km: number;
    to_km: number;
    current_kph: number;
    free_flow_kph: number;
    condition: "FLOWING" | "SLOW" | "HEAVY" | "CLOSED";
  }[];
  incidents: {
    id: string;
    category: string;
    description: string | null;
    roads: string[];
    delay_min: number | null;
    at_km: number;
    location: [number, number];
  }[];
}

export interface LiveRouteState {
  configured: boolean;
  presets: LiveShipmentDraft[];
  available_drivers: number;
  shipments: LiveRouteTrip[];
}

export type LiveDemoArea = "mumbai" | "regional";
export type LiveRouteSource = { preset_id: string } | { seed: number; area: LiveDemoArea };

export interface EvPreview {
  distance_km: number;
  travel_min: number;
  charging_min: number;
  consumption_kwh: number;
  arrival_charge_pct: number;
  reserve_pct: number;
  battery_kwh: number;
  stops: { name: string | null; charging_min: number }[];
}

export interface LiveShipmentDraft {
  preset_id: string | null;
  seed: number | null;
  area: LiveDemoArea;
  lane: string;
  customer_name: string;
  product: string;
  quantity_t: number;
  gross_t: number;
  stop_min: number;
  promise_buffer_min: number;
  vehicle: { label: string; tare_t: number; max_gross_t: number; height_m: number; width_m: number; length_m: number };
}

export interface LiveRouteTrip {
  shipment_id: string;
  driver_name: string;
  status: ShipmentStatus;
  draft: LiveShipmentDraft;
}

/** GET /shipments — PROPOSED list item ("list with current ETA summary", 5.5) */
export interface ShipmentSummary {
  id: string;
  order_id: string;
  customer_name: string;
  destination_name: string;
  transporter_name: string;
  status: ShipmentStatus;
  active_route_id: string;
  last_position: Position | null;
  current_eta: EtaSnapshot | null;
  open_alert: Alert | null;
  /** Orders added to this truck after it was planned. */
  extra_order_ids?: string[];
  version: number;
  live_demo?: boolean;
  /** When the truck arrived (finished shipments), and the promise that on-time is judged against. */
  arrived_at?: string | null;
  original_promised_by?: string;
}

/** GET /routes/:id — ENTITY (5.2 routes, route_segments, route_alternatives) */
export interface RouteDetail {
  id: string;
  name: string;
  origin: string;
  destination: string;
  total_km: number;
  geometry: { type: "LineString"; coordinates: [number, number][] }; // GeoJSON is [lng, lat]
  restrictions: { max_gross_t?: number | null; closed?: boolean | null };
  segments: { seq: number; start_km: number; end_km: number; baseline_speed_kmph: number; dwell_after_min: number }[];
  alternatives: { alt_route_id: string; exit_km: number }[]; // PROPOSED: needed to draw the dashed alternative
}

/** SAMPLE 5.7.1 */
export interface ShipmentEventRequest {
  event_id: string;
  type: "POSITION" | "MILESTONE" | "DISRUPTION_REPORTED" | "DISRUPTION_CLEARED";
  occurred_at?: string;
  payload: Record<string, unknown>;
}

/** SAMPLE 5.7.1 */
export interface ShipmentEventResponse {
  event_id: string;
  apply_status: ApplyStatus;
  shipment_id: string;
  shipment_version: number;
  occurred_at: string;
  eta_snapshot_id: string | null;
}

/** SAMPLE 5.7.3 */
export interface DecisionOption {
  id: string;
  type: OptionType;
  feasible: boolean;
  label: string;
  infeasible_reason?: string;
  projected_eta?: string;
  projected_late_min?: number;
  projected_risk_level?: RiskLevel;
  improvement_min?: number;
  added_km?: number;
  added_cost_inr?: number;
  params?: Record<string, unknown>;
}

/** SAMPLE 5.7.3 */
export interface OptionSet {
  id: string;
  alert_id: string;
  shipment_id: string;
  generated_at: string;
  based_on_snapshot_id: string;
  valid_until: string;
  recommended_option_id: string;
  options: DecisionOption[];
}

/** SAMPLE 5.7.3 */
export interface DecisionRequest {
  decision_id: string;
  option_set_id: string;
  option_id: string;
  note?: string;
}

/** SAMPLE 6.8 */
export interface DecisionOutcome {
  actual_arrival: string;
  on_time_against_original_promise: boolean;
  eta_error_min: number;
  counterfactual_no_action_arrival: string | null;
  delay_avoided_min: number | null;
  counterfactual_kind: "SIMULATED" | "ESTIMATED";
}

/** SAMPLE 5.7.3 response; ledger fields from 5.2 decisions and 7.2 ("options considered") */
export interface Decision {
  id: string;
  decision_id: string;
  shipment_id: string;
  option_type: OptionType;
  decided_by: string;
  decided_at: string;
  shipment_version: number;
  eta_snapshot_id: string;
  notifications_created: number;
  predicted: { chosen_eta: string; no_action_eta: string };
  outcome: DecisionOutcome | null;
  note?: string | null; // ENTITY
  option_set?: OptionSet; // PROPOSED: ledger shows "options considered" (7.2)
  option_id?: string; // ENTITY
}

/** ENTITY (5.2 notifications) */
export interface Notification {
  id: string;
  user_id: string;
  shipment_id: string | null;
  kind: "RISK_MEDIUM" | "RISK_HIGH" | "DECISION_APPLIED" | "BACK_ON_SCHEDULE" | "TRACKING_LOST" | "DELIVERED" | "DELIVERY_PHOTO" | "DELIVERY_VERIFIED" | "CHECKIN_REQUEST" | "CHECKIN_REPLY" | "DRIVER_STOP" | "INVOICE_READY" | "ORDER_CONFIRMED" | "NEW_TRIP" | "ORDER_PLACED" | "DEPARTED";
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

/** PROPOSED: dashboard shapes are agreed at agreement point 5 (PHASES.md 4) */
export interface OnTimeRow {
  group_id: string;
  group_name: string;
  delivered: number;
  on_time: number;
  on_time_pct: number;
}
export interface DelayCauseRow {
  group_id: string;
  group_name: string;
  minutes_by_cause: Partial<Record<FactorCode, number>>;
}
export interface ImpactMetrics {
  warning_lead_time_median_min: number | null;
  eta_error_mean_min: number | null;
  alert_precision: number | null;
  alert_recall: number | null;
  delay_avoided_total_min: number | null;
  on_time_pct_with_decisions: number | null;
  on_time_pct_without_decisions: number | null;
  cost_of_lateness_avoided_inr: number | null;
  assumptions: string[];
}

/** PROPOSED: 5.5 says "clock time, speed, scenario status" */
export interface DemoState {
  mode?: "REAL" | "SIMULATED";
  clock: string;
  speed: number;
  paused: boolean;
  scenario_id: string | null;
  scenario_status: "IDLE" | "RUNNING" | "PAUSED" | "WAITING_FOR_PRESENTER" | "FINISHED";
  waiting_for?: string | null;
}

/** 5.8 stream hint */
export interface StreamHint {
  entity: "shipment" | "notification" | "dashboard" | "demo";
  id?: string;
  version?: number;
  kinds?: string[];
}

/** 5.1 error body */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** GET /weather/routes: live forecast along each route (Open-Meteo), graded by the seed thresholds */
export type WeatherLevel = "CLEAR" | "MODERATE" | "SEVERE";
export interface RouteWeather {
  route_id: string;
  route_name: string;
  level: WeatherLevel;
  suggested_delay_min: number;
  worst: { km: number; reasons: string[] } | null;
  points: { km: number; lat: number; lng: number; level: WeatherLevel; reasons: string[]; precipitation_mm: number; visibility_m: number; wind_kmph: number; weather_code: number }[];
}
export interface RouteWeatherResponse {
  mode: "ADVISORY" | "LIVE";
  source: string;
  status: "OK" | "UNAVAILABLE";
  fetched_at: string | null;
  error: string | null;
  routes: RouteWeather[];
}

/* ---- Order-tracking assistant (GET /assistant, POST /assistant/ask) ---- */
export interface AssistantStatus {
  configured: boolean;
  provider: "Groq";
  model: string;
}
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}
export interface AssistantAnswer {
  answer: string;
  provider: "Groq";
  model: string;
}

/* ---- New orders and truck choice (GET /orders/new, POST /orders/plan, POST /orders) ---- */
export interface NewOrderForm {
  now: string;
  customers: { id: string; name: string; deliver_to: string | null }[];
  products: string[];
  routes?: { id: string; customer_id: string; name: string; max_gross_t: number | null }[];
}
export interface OrderDraft {
  customer_id: string;
  route_id?: string;
  product: string;
  quantity_t: number;
  promised_by: string;
}
export interface TruckOption {
  id: string;
  type: "ADD_TO_TRUCK" | "NEW_TRUCK";
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
  /** Minutes between the ETA and the order's promise; negative means late. */
  margin_min: number | null;
  km_saved: number | null;
  cost_saved_inr: number | null;
  driver_name: string | null;
  note: string | null;
}
export interface OrderPlan {
  options: TruckOption[];
  recommended_option_id: string | null;
}
export interface OrderCreated {
  order_id: string;
  shipment_id: string;
  option: TruckOption;
}
