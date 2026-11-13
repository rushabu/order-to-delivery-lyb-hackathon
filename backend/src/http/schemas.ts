// Zod schemas for every request and response. These are the contract in DESIGN.md section 5;
// /openapi.json is generated from them. Change a field here only together with DESIGN.md.
import { z } from 'zod';

export const IsoTime = z.iso.datetime({ offset: false }).describe('ISO 8601 UTC with Z suffix');

export const Role = z.enum(['COORDINATOR', 'DRIVER', 'CUSTOMER']);
export const ShipmentStatus = z.enum(['PLANNED', 'DISPATCHED', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED', 'CANCELLED']);
export const DisruptionCategory = z.enum(['ACCIDENT', 'BREAKDOWN', 'WEATHER', 'ROAD_CLOSURE', 'LOADING_DELAY', 'OTHER']);
export const RiskLevel = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export const Confidence = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export const ApplyStatus = z.enum(['APPLIED', 'STORED_NOT_APPLIED', 'DUPLICATE']);
export const OptionType = z.enum(['REROUTE', 'SPLIT_SHIPMENT', 'CONTINUE', 'RESCHEDULE']);
export const AlertStatus = z.enum(['OPEN', 'DECIDED', 'RESOLVED']);
export const NotificationKind = z.enum([
  'RISK_MEDIUM',
  'RISK_HIGH',
  'DECISION_APPLIED',
  'BACK_ON_SCHEDULE',
  'TRACKING_LOST',
  'DELIVERED',
  'DELIVERY_PHOTO',
  'DELIVERY_VERIFIED',
  'CHECKIN_REQUEST',
  'CHECKIN_REPLY',
  'DRIVER_STOP',
  'INVOICE_READY',
  'ORDER_CONFIRMED',
  'NEW_TRIP',
  'ORDER_PLACED',
]);

export const ErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()) }),
});

// ---- Auth ----
export const User = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: Role,
  customer_id: z.string().nullable(),
  transporter_id: z.string().nullable(),
});
export const LoginRequest = z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(200) });
export const LoginResponse = z.object({ token: z.string(), user: User });

// ---- Events (5.7.1) ----
export const PositionPayload = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  speed_kmph: z.number().min(0).max(200).optional(),
});
export const MilestonePayload = z.object({ to_status: ShipmentStatus });
export const DisruptionReportedPayload = z.object({
  disruption_id: z.uuid(),
  category: DisruptionCategory,
  expected_delay_min: z.number().int().min(1).max(24 * 60).optional(),
  at_km: z.number().min(0).max(5000).optional(),
  note: z.string().max(500).optional(),
});
export const DisruptionClearedPayload = z.object({ disruption_id: z.uuid() });

const eventBase = { event_id: z.uuid(), occurred_at: IsoTime.optional() };
export const EventRequest = z.discriminatedUnion('type', [
  z.object({ ...eventBase, type: z.literal('POSITION'), payload: PositionPayload }),
  z.object({ ...eventBase, type: z.literal('MILESTONE'), payload: MilestonePayload }),
  z.object({ ...eventBase, type: z.literal('DISRUPTION_REPORTED'), payload: DisruptionReportedPayload }),
  z.object({ ...eventBase, type: z.literal('DISRUPTION_CLEARED'), payload: DisruptionClearedPayload }),
]);
export type EventRequest = z.infer<typeof EventRequest>;

export const EventResponse = z.object({
  event_id: z.string(),
  apply_status: ApplyStatus,
  shipment_id: z.string(),
  shipment_version: z.number().int(),
  occurred_at: IsoTime,
  eta_snapshot_id: z.string().nullable(),
});

export const StoredEvent = z.object({
  event_id: z.string(),
  shipment_id: z.string(),
  type: z.string(),
  occurred_at: IsoTime,
  received_at: IsoTime,
  source: z.string(),
  actor_user_id: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  apply_status: ApplyStatus,
});

// ---- ETA snapshot (5.7.2) ----
export const Factor = z.object({ code: z.string(), label: z.string(), minutes: z.number().int() });
export const EtaSnapshot = z.object({
  id: z.string(),
  shipment_id: z.string(),
  computed_at: IsoTime,
  trigger_event_id: z.string().nullable(),
  route_id: z.string(),
  progress_km: z.number().nullable(),
  remaining_km: z.number().nullable(),
  eta: IsoTime,
  eta_window: z.object({ earliest: IsoTime, latest: IsoTime }),
  promised_by: IsoTime,
  slack_min: z.number().int(),
  margin_min: z.number().int(),
  risk_score: z.number().int().min(0).max(100),
  risk_level: RiskLevel,
  confidence: Confidence,
  position_age_min: z.number().int().nullable(),
  factors: z.array(Factor),
  headline: z.string(),
});

// ---- Alerts, options, decisions (5.7.3) ----
export const Alert = z.object({
  id: z.string(),
  shipment_id: z.string(),
  level: z.enum(['MEDIUM', 'HIGH']),
  status: AlertStatus,
  title: z.string(),
  opened_at: IsoTime,
  first_snapshot_id: z.string(),
  resolved_at: IsoTime.nullable(),
});

export const Option = z.object({
  id: z.string(),
  type: OptionType,
  feasible: z.boolean(),
  label: z.string(),
  infeasible_reason: z.string().optional(),
  projected_eta: IsoTime.optional(),
  projected_late_min: z.number().int().optional(),
  projected_risk_level: RiskLevel.optional(),
  improvement_min: z.number().int().optional(),
  added_km: z.number().optional(),
  added_cost_inr: z.number().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type Option = z.infer<typeof Option>;

export const OptionSet = z.object({
  id: z.string(),
  alert_id: z.string(),
  shipment_id: z.string(),
  generated_at: IsoTime,
  based_on_snapshot_id: z.string(),
  valid_until: IsoTime,
  recommended_option_id: z.string(),
  recommendation_reason: z.string(),
  options: z.array(Option),
});

export const DecisionRequest = z.object({
  decision_id: z.uuid(),
  option_set_id: z.string().min(1).max(40),
  option_id: z.string().min(1).max(80),
  note: z.string().max(500).optional(),
});

export const Outcome = z.object({
  actual_arrival: IsoTime,
  on_time_against_original_promise: z.boolean(),
  eta_error_min: z.number().int(),
  counterfactual_no_action_arrival: IsoTime,
  delay_avoided_min: z.number().int(),
  counterfactual_kind: z.enum(['SIMULATED', 'ESTIMATED']),
});

export const DecisionResponse = z.object({
  id: z.string(),
  decision_id: z.string(),
  shipment_id: z.string(),
  option_type: OptionType,
  decided_by: z.string(),
  decided_at: IsoTime,
  shipment_version: z.number().int(),
  eta_snapshot_id: z.string().nullable(),
  notifications_created: z.number().int(),
  predicted: z.object({ chosen_eta: IsoTime, no_action_eta: IsoTime }),
  outcome: Outcome.nullable(),
});

/** Ledger entry: the decision plus the options that were on the table. */
export const LedgerEntry = DecisionResponse.extend({
  option_set_id: z.string(),
  option_id: z.string(),
  note: z.string().nullable(),
  options: z.array(Option),
  option_set: OptionSet,
});

// ---- Shipments ----
export const Position = z.object({
  lat: z.number(),
  lng: z.number(),
  progress_km: z.number().nullable(),
  occurred_at: IsoTime,
});

export const Disruption = z.object({
  id: z.string(),
  category: DisruptionCategory,
  at_km: z.number().nullable(),
  route_id: z.string(),
  expected_delay_min: z.number().int(),
  estimate_source: z.enum(['DRIVER', 'DEFAULT']),
  note: z.string().nullable(),
  reported_at: IsoTime,
  cleared_at: IsoTime.nullable(),
});

export const EtaSummary = z.object({
  id: z.string(),
  eta: IsoTime,
  risk_score: z.number().int(),
  risk_level: RiskLevel,
  confidence: Confidence,
  slack_min: z.number().int(),
  headline: z.string(),
});

export const ShipmentSummary = z.object({
  id: z.string(),
  order_id: z.string(),
  customer_id: z.string(),
  customer_name: z.string(),
  transporter_name: z.string(),
  destination_name: z.string(),
  vehicle_reg: z.string(),
  status: ShipmentStatus,
  active_route_id: z.string(),
  promised_by: IsoTime,
  // For finished shipments, which have no live ETA: when the truck arrived, and the promise on-time is judged against.
  original_promised_by: IsoTime,
  arrived_at: IsoTime.nullable(),
  last_position: Position.nullable(),
  current_eta: EtaSnapshot.nullable(),
  open_alert: Alert.nullable(),
  open_alert_id: z.string().nullable(),
  // Orders added to this truck after it was planned (order_id stays the truck's first order).
  extra_order_ids: z.array(z.string()),
  version: z.number().int(),
  live_demo: z.boolean().optional(),
});

const LiveTraffic = z.object({
  source: z.literal('TomTom'),
  status: z.enum(['LIVE', 'STALE', 'UNAVAILABLE']),
  fetched_at: IsoTime.nullable(),
  drive_minutes: z.number().int().nullable(),
  traffic_delay_min: z.number().int().nullable(),
  sections: z.array(z.object({ category: z.string(), coordinates: z.array(z.tuple([z.number(), z.number()])) })),
});

export const RoadConditionsResponse = z.object({
  route_id: z.string(), fetched_at: IsoTime, horizon_km: z.number(),
  flow_status: z.enum(['LIVE', 'PARTIAL', 'UNAVAILABLE']), incidents_status: z.enum(['LIVE', 'UNAVAILABLE']),
  flow: z.array(z.object({
    coordinates: z.array(z.tuple([z.number(), z.number()])), at_km: z.number(), to_km: z.number(),
    current_kph: z.number(), free_flow_kph: z.number(), condition: z.enum(['FLOWING', 'SLOW', 'HEAVY', 'CLOSED']),
  })),
  incidents: z.array(z.object({
    id: z.string(), category: z.string(), description: z.string().nullable(), roads: z.array(z.string()),
    delay_min: z.number().int().nullable(), at_km: z.number(), location: z.tuple([z.number(), z.number()]),
  })),
});

export const InvoiceMeta = z.object({
  filename: z.string(),
  size_bytes: z.number().int().positive(),
  uploaded_at: IsoTime,
  uploaded_by_name: z.string(),
});

export const ShipmentDetail = z.object({
  id: z.string(),
  status: ShipmentStatus,
  version: z.number().int(),
  order: z.object({
    id: z.string(),
    customer_id: z.string(),
    customer_name: z.string(),
    product: z.string(),
    quantity_t: z.number(),
    original_promised_by: IsoTime,
    agreed_delivery_by: IsoTime,
  }),
  customer_name: z.string(),
  destination_name: z.string(),
  transporter: z.object({ id: z.string(), name: z.string() }),
  transporter_id: z.string(),
  transporter_name: z.string(),
  vehicle_reg: z.string(),
  /** Omitted (null) for customers: they never receive driver names or phone numbers. */
  driver: z.object({ id: z.string(), name: z.string(), phone: z.string().nullable() }).nullable(),
  driver_name: z.string().optional(),
  quantity_t: z.number(),
  gross_t: z.number(),
  planned_route_id: z.string(),
  active_route_id: z.string(),
  alternative_route_ids: z.array(z.string()),
  planned_departure: IsoTime,
  milestones: z.array(z.object({ status: ShipmentStatus, at: IsoTime })),
  last_position: Position.nullable(),
  current_eta: EtaSnapshot.nullable(),
  open_alert: Alert.nullable(),
  active_disruptions: z.array(Disruption),
  live_traffic: LiveTraffic.optional(),
  // Coordinators and the customer only; absent for drivers. null until a coordinator uploads one.
  invoice: InvoiceMeta.nullable().optional(),
  extra_orders: z.array(z.object({ id: z.string(), product: z.string(), quantity_t: z.number(), promised_by: IsoTime })),
});

export const RouteDetail = z.object({
  id: z.string(),
  name: z.string(),
  origin: z.string(),
  destination: z.string(),
  total_km: z.number(),
  geometry: z
    .object({ type: z.literal('LineString'), coordinates: z.array(z.array(z.number()).length(2)) })
    .nullable(),
  restrictions: z.object({ max_gross_t: z.number().nullable(), closed: z.boolean() }),
  segments: z.array(
    z.object({
      seq: z.number().int(),
      start_km: z.number(),
      end_km: z.number(),
      baseline_speed_kmph: z.number(),
      dwell_after_min: z.number().int(),
    }),
  ),
  alternatives: z.array(z.object({ alt_route_id: z.string(), exit_km: z.number() })),
});

// ---- Notifications ----
export const Notification = z.object({
  id: z.string(),
  user_id: z.string(),
  shipment_id: z.string().nullable(),
  kind: NotificationKind,
  title: z.string(),
  body: z.string(),
  created_at: IsoTime,
  read_at: IsoTime.nullable(),
});

// ---- Demo ----
export const DemoClockRequest = z.object({
  speed: z.number().min(0).max(3600).optional(),
  paused: z.boolean().optional(),
});
export const DemoState = z.object({
  clock: IsoTime,
  speed: z.number(),
  paused: z.boolean(),
  mode: z.enum(['REAL', 'SIMULATED']),
  scenario_id: z.string().nullable(),
  scenario_status: z.enum(['IDLE', 'RUNNING', 'PAUSED', 'WAITING_FOR_PRESENTER', 'FINISHED']),
  waiting_for: z.string().nullable(),
  next_pause_at: IsoTime.nullable(),
});
const LiveSeed = z.number().int().min(0).max(0xffffffff);
const LiveDemoArea = z.enum(['mumbai', 'regional']);
export const LiveRouteGenerate = z.object({ seed: z.coerce.number().pipe(LiveSeed).optional(), area: LiveDemoArea.optional() });
const LiveRouteSource = z.object({
  preset_id: z.string().min(1).max(40).optional(),
  seed: LiveSeed.optional(),
  area: LiveDemoArea.optional(),
}).refine((input) => (input.preset_id !== undefined) !== (input.seed !== undefined), { message: 'Choose a preset or a generated seed' });
export const LiveRouteStart = LiveRouteSource.safeExtend({ request_id: z.uuid() });
export type LiveRouteStart = z.infer<typeof LiveRouteStart>;
export const EvPreviewInput = LiveRouteSource.safeExtend({ start_charge_pct: z.number().int().min(5).max(100) });
export type EvPreviewInput = z.infer<typeof EvPreviewInput>;
export const EvPreview = z.object({
  distance_km: z.number().positive(),
  travel_min: z.number().int().nonnegative(),
  charging_min: z.number().int().nonnegative(),
  consumption_kwh: z.number(),
  arrival_charge_pct: z.number().min(0).max(100),
  reserve_pct: z.number().min(0).max(100),
  battery_kwh: z.number().positive(),
  stops: z.array(z.object({ name: z.string().nullable(), charging_min: z.number().int().nonnegative() })),
});
export const LiveShipmentDraft = z.object({
  preset_id: z.string().nullable(), seed: LiveSeed.nullable(), area: LiveDemoArea, lane: z.string(), customer_name: z.string(), product: z.string(),
  quantity_t: z.number(), gross_t: z.number(), stop_min: z.number().int(), promise_buffer_min: z.number().int(),
  vehicle: z.object({ label: z.string(), tare_t: z.number(), max_gross_t: z.number(), height_m: z.number(), width_m: z.number(), length_m: z.number() }),
});
export const LiveRouteTrip = z.object({ shipment_id: z.string(), driver_name: z.string(), status: ShipmentStatus, draft: LiveShipmentDraft });
export const LiveRouteState = z.object({
  configured: z.boolean(), presets: z.array(LiveShipmentDraft), available_drivers: z.number().int(), shipments: z.array(LiveRouteTrip),
});

// ---- Dashboard and metrics (10.3) ----
export const GroupBy = z.enum(['route', 'transporter']);
/** On time is measured against the original promise. */
export const OnTimeResponse = z.array(
  z.object({
    group_id: z.string(),
    group_name: z.string(),
    delivered: z.number().int(),
    on_time: z.number().int(),
    late: z.number().int(),
    on_time_pct: z.number().nullable(),
  }),
);
export const DelayCausesResponse = z.array(
  z.object({
    group_id: z.string(),
    group_name: z.string(),
    minutes_by_cause: z.record(z.string(), z.number().int()),
    total_min: z.number().int(),
  }),
);
export const ImpactResponse = z.object({
  fictional: z.literal(true),
  warning_lead_time_median_min: z.number().nullable(),
  eta_error_mean_min: z.number().nullable(),
  alert_precision: z.number().nullable(),
  alert_recall: z.number().nullable(),
  delay_avoided_total_min: z.number().nullable(),
  on_time_pct_with_decisions: z.number().nullable(),
  on_time_pct_without_decisions: z.number().nullable(),
  cost_of_lateness_avoided_inr: z.number().nullable(),
  warning_lead_time: z.object({
    kind: z.literal('OBSERVED_IN_REPLAY'),
    median_min: z.number().nullable(),
    per_shipment: z.array(
      z.object({ shipment_id: z.string(), first_alert_at: IsoTime, original_promised_by: IsoTime, lead_time_min: z.number().int() }),
    ),
  }),
  eta_error: z.object({ kind: z.literal('OBSERVED_IN_REPLAY'), mean_min: z.number().nullable(), n: z.number().int() }),
  alert_quality: z.object({
    kind: z.literal('REPLAY_PLUS_COUNTERFACTUAL'),
    precision: z.number().nullable(),
    recall: z.number().nullable(),
    high_alerted: z.number().int(),
    late_without_action: z.number().int(),
  }),
  delay_avoided: z.object({
    kind: z.literal('COUNTERFACTUAL_IN_REPLAY'),
    total_min: z.number().int(),
    per_decision: z.array(z.object({ decision_id: z.string(), shipment_id: z.string(), delay_avoided_min: z.number().int() })),
  }),
  on_time_delivery: z.object({
    arrived: z.number().int(),
    with_decisions_pct: z.number().nullable(),
    without_decisions_pct: z.number().nullable(),
  }),
  cost_of_lateness_avoided: z.object({
    kind: z.literal('MODELED_ESTIMATE'),
    inr: z.number(),
    cost_per_late_hour_inr: z.number(),
  }),
  assumptions: z.array(z.string()),
});

// ---- Weather (Open-Meteo) ----
const WeatherLevel = z.enum(['CLEAR', 'MODERATE', 'SEVERE']);
const WeatherThreshold = z.object({ precipitation_mm: z.number(), visibility_m: z.number(), wind_kmph: z.number(), delay_min: z.number() });
export const RouteWeatherResponse = z.object({
  mode: z.enum(['ADVISORY', 'LIVE']),
  source: z.string(),
  status: z.enum(['OK', 'UNAVAILABLE']),
  fetched_at: z.string().nullable(),
  error: z.string().nullable(),
  thresholds: z.object({
    sample_every_km: z.number(),
    forecast_hours: z.number(),
    refresh_min: z.number(),
    moderate: WeatherThreshold,
    severe: WeatherThreshold,
  }),
  routes: z.array(
    z.object({
      route_id: z.string(),
      route_name: z.string(),
      level: WeatherLevel,
      suggested_delay_min: z.number(),
      worst: z.object({ km: z.number(), reasons: z.array(z.string()) }).nullable(),
      points: z.array(
        z.object({
          km: z.number(),
          lat: z.number(),
          lng: z.number(),
          level: WeatherLevel,
          reasons: z.array(z.string()),
          precipitation_mm: z.number(),
          visibility_m: z.number(),
          wind_kmph: z.number(),
          weather_code: z.number(),
        }),
      ),
    }),
  ),
});

export const Health = z.object({ status: z.literal('ok'), demo_mode: z.boolean(), now: IsoTime });

// ---- Order-tracking assistant (Groq) ----
export const AssistantStatus = z.object({ configured: z.boolean(), provider: z.literal('Groq'), model: z.string() });
export const AssistantAsk = z.object({
  question: z.string().trim().min(1).max(500),
  // Earlier turns of this conversation, kept by the browser. Capped so a request stays small.
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(2000) })).max(10).default([]),
});
export type AssistantAsk = z.infer<typeof AssistantAsk>;
export const AssistantAnswer = z.object({ answer: z.string(), provider: z.literal('Groq'), model: z.string() });

// ---- New orders and truck choice (orders/plan.ts) ----
export const NewOrderForm = z.object({
  now: IsoTime,
  customers: z.array(z.object({ id: z.string(), name: z.string(), deliver_to: z.string().nullable() })),
  products: z.array(z.string()),
});
export const OrderDraft = z.object({
  customer_id: z.string().min(1).max(40),
  product: z.string().trim().min(1).max(80),
  quantity_t: z.number().positive().max(40),
  promised_by: IsoTime,
});
export type OrderDraft = z.infer<typeof OrderDraft>;
export const OrderCreate = OrderDraft.extend({ option_id: z.string().min(1).max(60) });
export type OrderCreate = z.infer<typeof OrderCreate>;
export const TruckOption = z.object({
  id: z.string(),
  type: z.enum(['ADD_TO_TRUCK', 'NEW_TRUCK']),
  label: z.string(),
  feasible: z.boolean(),
  infeasible_reason: z.string().nullable(),
  recommended: z.boolean(),
  shipment_id: z.string().nullable(),
  vehicle_reg: z.string().nullable(),
  transporter_name: z.string().nullable(),
  capacity_t: z.number().nullable(),
  load_after_t: z.number().nullable(),
  spare_after_t: z.number().nullable(),
  planned_departure: IsoTime.nullable(),
  eta: IsoTime.nullable(),
  margin_min: z.number().nullable(),
  km_saved: z.number().nullable(),
  cost_saved_inr: z.number().nullable(),
  driver_name: z.string().nullable(),
  note: z.string().nullable(),
});
export const OrderPlan = z.object({ options: z.array(TruckOption), recommended_option_id: z.string().nullable() });
export const OrderCreated = z.object({ order_id: z.string(), shipment_id: z.string(), option: TruckOption });
