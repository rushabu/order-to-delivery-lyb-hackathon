// Types for the ETA engine. The engine is a pure function: no database, no clock (DESIGN.md 6.3).

export interface Segment {
  seq: number;
  start_km: number;
  end_km: number;
  baseline_speed_kmph: number;
  dwell_after_min: number;
}

export interface EtaRoute {
  id: string;
  total_km: number;
  segments: Segment[]; // ordered by start_km, contiguous from 0 to total_km
}

export interface EtaDisruption {
  id: string;
  route_id: string; // route on which at_km is measured
  category: string;
  at_km: number | null; // null means "at the truck" (for example a breakdown or a loading delay)
  expected_delay_min: number;
  estimate_source: 'DRIVER' | 'DEFAULT';
  reported_at: string;
}

export interface Factor {
  code: string;
  label: string;
  minutes: number;
}

/** The parts of an earlier snapshot the engine needs to hold an ETA during a position gap. */
export interface PreviousSnapshot {
  computed_at: string;
  eta: string;
  route_id: string;
  factors: Factor[];
}

export interface EtaConfig {
  pace_window_min: number; // 15
  pace_min_positions: number; // 3
  pace_horizon_km: number; // 50
  slowdown_min: number; // 0.8
  slowdown_max: number; // 2.0
  pace_min_factor_min: number; // 3
  disruption_floor_min: number; // 15
  margin_floor_min: number; // 20
  margin_pct: number; // 10
  stale_after_min: number; // 10
  stale_margin_max_add_min: number; // 60
  tracking_lost_after_min: number; // 30
  risk_medium_from: number; // 35
  risk_high_from: number; // 70
}

export type ShipmentStatusName = 'PLANNED' | 'DISPATCHED' | 'IN_TRANSIT' | 'ARRIVED' | 'DELIVERED' | 'CANCELLED';

export interface LiveDrive {
  minutes: number;
  trafficMinutes: number;
  affectedSpans: { fromKm: number; toKm: number }[];
}

export interface EtaState {
  shipment_id: string;
  status: ShipmentStatusName;
  planned_departure: string;
  departed_at: string | null;
  promised_by: string; // orders.agreed_delivery_by (the current promise)
  route: EtaRoute;
  /**
   * Set after a reroute: the truck left `route_id` (the road its pace was observed on) at `at_km`.
   * The first `at_km` km of the active route are the same road as `route_id`.
   */
  diverted_from: { route_id: string; at_km: number } | null;
  /** Progress along the active route from the last applied position; null if none or not projectable. */
  progress_km: number | null;
  position_at: string | null;
  /** Applied positions, oldest first (the engine reads only the trailing window). */
  positions: { at: string; km: number }[];
  /** Active (not cleared) disruptions. */
  disruptions: EtaDisruption[];
  liveRouting?: { drive: LiveDrive | null };
  /**
   * Live mode only: forecast weather ahead on the active route (Open-Meteo). Absent in demo mode,
   * so the scripted demo stays repeatable.
   */
  forecast?: { minutes: number; at_km: number; reasons: string[] } | null;
  /** Latest snapshot, used only to hold the ETA on a clock tick during a position gap. */
  previous: PreviousSnapshot | null;
}

export interface EtaResult {
  computed_at: string;
  route_id: string;
  progress_km: number | null;
  remaining_km: number | null;
  eta: string;
  eta_window: { earliest: string; latest: string };
  promised_by: string;
  slack_min: number;
  margin_min: number;
  risk_score: number;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  position_age_min: number | null;
  factors: Factor[];
  headline: string;
  /** True when the ETA was held because no position arrived for more than stale_after_min. */
  stale: boolean;
  tracking_lost: boolean;
  /** Observed slowdown (1.0 = normal), or null when there were too few positions. Used by options. */
  slowdown: number | null;
}

/** Why the engine is being run: a clock tick may hold the ETA during a gap; an event recomputes. */
export type EtaTrigger = 'EVENT' | 'TICK';
