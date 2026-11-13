/*
  Mock replay of scenario-main (DESIGN.md 10.4, 10.5), used only while VITE_USE_MOCKS is on.

  Design: the only stored state is the clock settings plus what people did (driver reports, decisions,
  milestones, read notifications). Everything else (positions, snapshots, alerts, notifications) is
  derived from those inputs and the simulated time, so every open tab computes the same picture.
  Inputs live in localStorage and changes are announced on a BroadcastChannel, which is how the
  coordinator, driver and customer tabs stay in step without a server.
*/
import type {
  Alert, Decision, DecisionOption, DemoState, Disruption, EtaSnapshot, Milestone, Notification, OptionSet,
  Position, ShipmentDetail, ShipmentStatus,
} from "../api/contract";
import {
  CUSTOMERS, TRANSPORTERS, USERS, SNAP_1001, SNAP_1002, SNAP_1003, PROMISE_1001, PROMISE_1002,
  ist, minutes, addMin, pointAt, lineFor,
} from "./fixtures";

const STORE_KEY = "ct.mock.inputs.v1";
const CHANNEL = "ct.mock";

export interface Report {
  event_id: string;
  at: string;
  category: Disruption["category"];
  expected_delay_min: number | null;
  at_km: number | null;
  note?: string;
}

export interface StoredDecision {
  response: Decision;
  option_set: OptionSet;
  option: DecisionOption;
  note: string | null;
}

export interface Inputs {
  clockBase: string; // simulated time when the clock was last set
  realStart: number | null; // wall-clock ms when it started running; null = paused
  speed: number;
  started: boolean;
  ackBeats: string[];
  reports: Record<string, Report>; // by shipment id (first report only drives the snapshots)
  decisions: Record<string, StoredDecision>; // by shipment id
  milestones: Record<string, Milestone[]>; // driver-posted milestones, by shipment id
  events: Record<string, unknown>; // stored responses by event_id (idempotency)
  read: Record<string, string>; // notification id -> read_at
  gpsPausedAt: string | null; // mock-only failure case (DESIGN.md 10.6)
  failDriverUpdates: boolean; // mock-only: driver POSTs fail with a network error
  dropStream: boolean; // mock-only: stream connections fail
}

export function initialInputs(): Inputs {
  return {
    clockBase: ist("08:50"), realStart: null, speed: 60, started: false, ackBeats: [],
    reports: {}, decisions: {}, milestones: {}, events: {}, read: {},
    gpsPausedAt: null, failDriverUpdates: false, dropStream: false,
  };
}

/* ---------------- Storage and cross-tab sync ---------------- */

let channel: BroadcastChannel | null = null;
const localListeners = new Set<() => void>();

function getChannel() {
  if (!channel && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => localListeners.forEach((l) => l());
  }
  return channel;
}

export function loadInputs(): Inputs {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...initialInputs(), ...(JSON.parse(raw) as Inputs) };
  } catch {
    /* fall through to a fresh scenario */
  }
  return initialInputs();
}

export function saveInputs(next: Inputs) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* storage full or blocked: the change still applies in this tab */
  }
  getChannel()?.postMessage("changed");
  localListeners.forEach((l) => l());
}

export function onInputsChanged(cb: () => void): () => void {
  getChannel();
  localListeners.add(cb);
  return () => localListeners.delete(cb);
}

/* ---------------- Clock with presenter beats ---------------- */

const BEATS = [
  { id: "prediction", at: ist("09:15"), waitingFor: "Prediction beat: open the factor list, then resume" },
  { id: "report", at: ist("09:30"), waitingFor: "Driver report and coordinator decision, then resume" },
];
const END = ist("12:50");

export function simNow(inputs: Inputs, wallMs = Date.now()): { now: string; waitingFor: string | null } {
  let raw = Date.parse(inputs.clockBase);
  if (inputs.realStart !== null) raw += (wallMs - inputs.realStart) * inputs.speed;
  for (const beat of BEATS) {
    if (!inputs.ackBeats.includes(beat.id) && raw >= Date.parse(beat.at) && Date.parse(inputs.clockBase) <= Date.parse(beat.at)) {
      return { now: beat.at, waitingFor: beat.waitingFor };
    }
  }
  raw = Math.min(raw, Date.parse(END));
  return { now: new Date(Math.floor(raw / 60_000) * 60_000).toISOString().replace(".000Z", "Z"), waitingFor: null };
}

export function demoState(inputs: Inputs): DemoState {
  const { now, waitingFor } = simNow(inputs);
  let status: DemoState["scenario_status"] = "IDLE";
  if (inputs.started) status = waitingFor ? "WAITING_FOR_PRESENTER" : inputs.realStart === null ? "PAUSED" : "RUNNING";
  if (now === END) status = "FINISHED";
  return { clock: now, speed: inputs.speed, paused: inputs.realStart === null || !!waitingFor, scenario_id: inputs.started ? "main" : null, scenario_status: status, waiting_for: waitingFor };
}

/** Freeze the clock at its current simulated time, acknowledging any beat we are waiting at. */
export function rebase(inputs: Inputs, running: boolean, speed = inputs.speed): Inputs {
  const { now, waitingFor } = simNow(inputs);
  const ack = [...inputs.ackBeats];
  if (waitingFor && running) {
    const beat = BEATS.find((b) => b.at === now);
    if (beat) ack.push(beat.id);
  }
  return { ...inputs, clockBase: now, realStart: running ? Date.now() : null, speed, ackBeats: ack };
}

/* ---------------- Movement (ground truth of the replay) ---------------- */

interface Track {
  routeId: string;
  km: number;
  arrivedAt: string | null;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

/** SHP-1001 continuing on RTE-01 through the accident (ground truth: clears after 75 min, arrives 12:40). */
function continueKm1001(m: number): number {
  const t = (hhmm: string) => minutes(ist(hhmm));
  if (m <= t("09:00")) return lerp(0, 40, (m - t("08:00")) / 60);
  if (m <= t("09:30")) return lerp(40, 60, (m - t("09:00")) / 30);
  if (m <= t("09:52")) return lerp(60, 75, (m - t("09:30")) / 22);
  if (m <= t("10:45")) return 75;
  return lerp(75, 150, (m - t("10:45")) / (t("12:40") - t("10:45")));
}

function track1001(inputs: Inputs, now: string): Track {
  const m = minutes(now);
  const decision = inputs.decisions["SHP-1001"];
  const rerouted = decision?.option.type === "REROUTE";
  if (!rerouted) {
    const km = continueKm1001(m);
    return { routeId: "RTE-01", km, arrivedAt: km >= 150 ? ist("12:40") : null };
  }
  const d = minutes(decision.response.decided_at);
  const kmAtDecision = continueKm1001(d);
  const exitAt = d + Math.max(0, (66 - kmAtDecision) * 1.5); // 40 km/h in slow traffic to the exit
  if (m <= d) return { routeId: "RTE-01", km: continueKm1001(m), arrivedAt: null };
  if (m <= exitAt) return { routeId: "RTE-01", km: lerp(kmAtDecision, 66, (m - d) / (exitAt - d || 1)), arrivedAt: null };
  const bypassEnd = exitAt + 124; // ground truth: the bypass takes 124 min (prediction said 120)
  const km = lerp(0, 100, (m - exitAt) / 124);
  return { routeId: "RTE-01B", km, arrivedAt: m >= bypassEnd ? new Date(bypassEnd * 60_000).toISOString().replace(".000Z", "Z") : null };
}

function track1002(now: string): Track {
  const m = minutes(now);
  const t = (hhmm: string) => minutes(ist(hhmm));
  const km = m <= t("08:40") ? lerp(0, 70, (m - t("07:00")) / 100) : lerp(70, 180, (m - t("08:40")) / (t("11:30") - t("08:40")));
  return { routeId: "RTE-02", km, arrivedAt: km >= 180 ? ist("11:30") : null };
}

function positionFor(track: Track, at: string): Position {
  const route = lineFor(track.routeId);
  const total = track.routeId === "RTE-01" ? 150 : track.routeId === "RTE-01B" ? 100 : 180;
  const [lng, lat] = pointAt(route, track.km / total);
  return { lat, lng, progress_km: Math.round(track.km), occurred_at: at };
}

/* ---------------- Derived world ---------------- */

export interface World {
  now: string;
  shipments: ShipmentDetail[];
  history: Record<string, EtaSnapshot[]>; // newest first
  alerts: Alert[];
  notifications: Notification[];
  decisions: Decision[];
}

const DRIVER_OF: Record<string, string> = { "SHP-1001": "USR-DRV-01", "SHP-1002": "USR-DRV-02", "SHP-1003": "USR-DRV-03" };
export const driverOf = (shipmentId: string) => DRIVER_OF[shipmentId];

function userName(id: string) {
  return USERS.find((u) => u.id === id)?.name ?? id;
}

function lastMilestoneStatus(list: Milestone[]): ShipmentStatus {
  return list.filter((m) => m.at).at(-1)?.status ?? "PLANNED";
}

export function deriveWorld(inputs: Inputs): World {
  const { now } = simNow(inputs);
  const nowM = minutes(now);
  const before = (iso: string) => minutes(iso) <= nowM;

  /* ---- SHP-1001 ---- */
  const t1 = track1001(inputs, now);
  const report1 = inputs.reports["SHP-1001"];
  const dec1 = inputs.decisions["SHP-1001"];
  const snaps1: EtaSnapshot[] = [SNAP_1001.departed, SNAP_1001.at0850, SNAP_1001.at0900];
  if (before(ist("09:15"))) snaps1.push(SNAP_1001.stepA);
  if (report1) snaps1.push(SNAP_1001.stepB(report1.at, report1.event_id));
  if (dec1?.option.type === "REROUTE") {
    snaps1.push(SNAP_1001.rerouted(dec1.response.decided_at));
    if (before(ist("10:40"))) snaps1.push(SNAP_1001.bypass1040);
    if (before(ist("11:20"))) snaps1.push(SNAP_1001.bypass1120);
  } else if (dec1?.option.type === "RESCHEDULE") {
    snaps1.push(SNAP_1001.rescheduled(dec1.response.decided_at));
  }
  const visible1 = snaps1.filter((s) => before(s.computed_at)).sort((a, b) => minutes(a.computed_at) - minutes(b.computed_at));

  // Mock-only stale GPS (DESIGN.md 6.5, 10.6): position freezes, confidence drops, margin widens.
  let pos1 = positionFor(t1, now);
  let current1 = visible1.at(-1) ?? null;
  if (inputs.gpsPausedAt && !t1.arrivedAt && before(inputs.gpsPausedAt)) {
    const frozen = positionFor(track1001(inputs, inputs.gpsPausedAt), inputs.gpsPausedAt);
    pos1 = frozen;
    const age = Math.round(nowM - minutes(inputs.gpsPausedAt));
    if (current1 && age > 10) {
      const extra = Math.min(age - 10, 60);
      const margin = current1.margin_min + extra;
      current1 = {
        ...current1,
        id: `${current1.id}-S${age}`,
        // ETA is held (DESIGN.md 6.5), so computed_at stays with the factors that produced it.
        confidence: "LOW",
        position_age_min: age,
        margin_min: margin,
        eta_window: { earliest: addMin(current1.eta, -margin), latest: addMin(current1.eta, margin) },
        risk_level: age > 30 && current1.risk_level === "LOW" ? "MEDIUM" : current1.risk_level,
        factors: [...current1.factors, { code: "STALE_POSITION", label: `No position for ${age} min`, minutes: 0 }],
      };
    }
  }

  const ms1 = baseMilestones1001(inputs);
  if (t1.arrivedAt && !ms1.some((m) => m.status === "ARRIVED")) ms1.push({ status: "ARRIVED", at: t1.arrivedAt });
  const status1 = lastMilestoneStatus(ms1);
  const firstAlert1 = before(ist("09:15"));
  const alert1: Alert | null = firstAlert1
    ? {
        id: "ALT-0001", shipment_id: "SHP-1001", level: report1 ? "HIGH" : "MEDIUM",
        status: dec1 ? "DECIDED" : "OPEN", opened_at: ist("09:15"), first_snapshot_id: "ETA-000312", resolved_at: null,
      }
    : null;
  const disruptions1: Disruption[] = report1 && dec1?.option.type !== "REROUTE"
    ? [{ id: "DSR-0001", shipment_id: "SHP-1001", category: report1.category, at_km: report1.at_km, expected_delay_min: report1.expected_delay_min ?? 60, estimate_source: report1.expected_delay_min ? "DRIVER" : "DEFAULT", reported_at: report1.at, cleared_at: null }]
    : [];

  /* ---- SHP-1002 ---- */
  const t2 = track1002(now);
  const dec2 = inputs.decisions["SHP-1002"];
  const snaps2 = [SNAP_1002.departed, SNAP_1002.weather];
  if (dec2?.option.type === "RESCHEDULE") snaps2.push(SNAP_1002.rescheduled(dec2.response.decided_at));
  const visible2 = snaps2.filter((s) => before(s.computed_at));
  const ms2: Milestone[] = [
    { status: "PLANNED", at: ist("06:00") }, { status: "DISPATCHED", at: ist("06:40") }, { status: "IN_TRANSIT", at: ist("07:00") },
    ...(inputs.milestones["SHP-1002"] ?? []),
  ];
  if (t2.arrivedAt && !ms2.some((m) => m.status === "ARRIVED")) ms2.push({ status: "ARRIVED", at: t2.arrivedAt });
  const alert2: Alert = { id: "ALT-0002", shipment_id: "SHP-1002", level: "HIGH", status: dec2 ? "DECIDED" : "OPEN", opened_at: ist("08:40"), first_snapshot_id: "ETA-000296", resolved_at: null };

  /* ---- SHP-1003 (planned) ---- */
  const ms3: Milestone[] = [{ status: "PLANNED", at: ist("07:30") }, ...(inputs.milestones["SHP-1003"] ?? [])];

  const shipments: ShipmentDetail[] = [
    {
      id: "SHP-1001",
      order: { id: "ORD-5001", customer_id: "CUS-01", product: "Polypropylene homopolymer granules", quantity_t: 24, original_promised_by: PROMISE_1001, agreed_delivery_by: dec1?.option.type === "RESCHEDULE" ? ist("12:45") : PROMISE_1001 },
      customer_name: CUSTOMERS["CUS-01"].name, destination_name: CUSTOMERS["CUS-01"].destination,
      transporter_id: "TRN-01", transporter_name: TRANSPORTERS["TRN-01"], driver_name: userName("USR-DRV-01"),
      vehicle_reg: "MH 46 BX 4127", quantity_t: 24, gross_t: 33,
      status: status1, active_route_id: dec1?.option.type === "REROUTE" ? "RTE-01B" : "RTE-01", planned_route_id: "RTE-01",
      planned_departure: ist("08:00"), last_position: status1 === "IN_TRANSIT" || status1 === "ARRIVED" || status1 === "DELIVERED" ? pos1 : null,
      milestones: fillMilestones(ms1), current_eta: current1,
      open_alert: alert1?.status === "OPEN" ? alert1 : null, active_disruptions: disruptions1,
      version: 40 + visible1.length + ms1.length + (dec1 ? 1 : 0),
    },
    {
      id: "SHP-1002",
      order: { id: "ORD-5002", customer_id: "CUS-02", product: "HDPE film grade granules", quantity_t: 25, original_promised_by: PROMISE_1002, agreed_delivery_by: dec2?.option.type === "RESCHEDULE" ? ist("11:45") : PROMISE_1002 },
      customer_name: CUSTOMERS["CUS-02"].name, destination_name: CUSTOMERS["CUS-02"].destination,
      transporter_id: "TRN-02", transporter_name: TRANSPORTERS["TRN-02"], driver_name: userName("USR-DRV-02"),
      vehicle_reg: "MH 04 KT 8813", quantity_t: 25, gross_t: 34,
      status: lastMilestoneStatus(ms2), active_route_id: "RTE-02", planned_route_id: "RTE-02",
      planned_departure: ist("07:00"), last_position: positionFor(t2, now),
      milestones: fillMilestones(ms2), current_eta: visible2.at(-1) ?? null,
      open_alert: alert2.status === "OPEN" ? alert2 : null,
      active_disruptions: [{ id: "DSR-0000", shipment_id: "SHP-1002", category: "WEATHER", at_km: 120, expected_delay_min: 45, estimate_source: "DEFAULT", reported_at: ist("08:40"), cleared_at: null }],
      version: 30 + visible2.length + ms2.length,
    },
    {
      id: "SHP-1003",
      order: { id: "ORD-5003", customer_id: "CUS-01", product: "Polypropylene copolymer granules", quantity_t: 18, original_promised_by: ist("17:00"), agreed_delivery_by: ist("17:00") },
      customer_name: CUSTOMERS["CUS-01"].name, destination_name: CUSTOMERS["CUS-01"].destination,
      transporter_id: "TRN-01", transporter_name: TRANSPORTERS["TRN-01"], driver_name: userName("USR-DRV-03"),
      vehicle_reg: "MH 46 CF 2290", quantity_t: 18, gross_t: 26,
      status: lastMilestoneStatus(ms3), active_route_id: "RTE-01", planned_route_id: "RTE-01",
      planned_departure: ist("13:00"), last_position: null,
      milestones: fillMilestones(ms3), current_eta: SNAP_1003, open_alert: null, active_disruptions: [],
      version: 10 + ms3.length,
    },
  ];

  const alerts = [alert1, alert2].filter((a): a is Alert => !!a);
  const decisions = Object.values(inputs.decisions).map((d) => withOutcome(d, shipments));
  return {
    now,
    shipments,
    history: { "SHP-1001": [...visible1].reverse(), "SHP-1002": [...visible2].reverse(), "SHP-1003": [SNAP_1003] },
    alerts,
    notifications: deriveNotifications(inputs, now, shipments),
    decisions,
  };
}

function baseMilestones1001(inputs: Inputs): Milestone[] {
  return [
    { status: "PLANNED", at: ist("06:30") }, { status: "DISPATCHED", at: ist("07:40") }, { status: "IN_TRANSIT", at: ist("08:00") },
    ...(inputs.milestones["SHP-1001"] ?? []),
  ];
}

/** Every stage in order, with null for stages not reached, so the timeline can show what is next. */
function fillMilestones(reached: Milestone[]): Milestone[] {
  const order: ShipmentStatus[] = ["PLANNED", "DISPATCHED", "IN_TRANSIT", "ARRIVED", "DELIVERED"];
  return order.map((status) => reached.find((m) => m.status === status) ?? { status, at: null });
}

/** DESIGN.md 6.8: the outcome is filled when the shipment reaches ARRIVED. */
function withOutcome(d: StoredDecision, shipments: ShipmentDetail[]): Decision {
  const s = shipments.find((x) => x.id === d.response.shipment_id)!;
  const arrived = s.milestones.find((m) => m.status === "ARRIVED")?.at;
  if (!arrived) return { ...d.response, option_set: d.option_set, option_id: d.option.id, note: d.note };
  const original = s.order.original_promised_by;
  const noAction = s.id === "SHP-1001" ? ist("12:40") : arrived;
  const predicted = d.response.predicted.chosen_eta;
  return {
    ...d.response,
    option_set: d.option_set,
    option_id: d.option.id,
    note: d.note,
    outcome: {
      actual_arrival: arrived,
      on_time_against_original_promise: minutes(arrived) <= minutes(original),
      eta_error_min: Math.abs(Math.round(minutes(arrived) - minutes(predicted))),
      counterfactual_no_action_arrival: noAction,
      delay_avoided_min: Math.max(0, Math.round(minutes(noAction) - minutes(arrived))),
      counterfactual_kind: "SIMULATED",
    },
  };
}

/* ---------------- Options (DESIGN.md 5.7.3, 6.6 step C) ---------------- */

/** Option sets expire after 10 minutes; a new id is issued for each 10-minute window after the trigger. */
export function currentOptionSet(inputs: Inputs, alertId: string): OptionSet | null {
  const { now } = simNow(inputs);
  const nowM = minutes(now);
  if (alertId === "ALT-0001") {
    if (inputs.decisions["SHP-1001"]) return inputs.decisions["SHP-1001"].option_set;
    const report = inputs.reports["SHP-1001"];
    if (report) {
      const k = Math.floor((nowM - minutes(report.at)) / 10);
      const gen = addMin(report.at, k * 10);
      return { ...SET_AFTER_REPORT(gen), id: k === 0 ? "OPS-0001" : `OPS-0001-R${k}` };
    }
    if (nowM < minutes(ist("09:15"))) return null;
    const k = Math.floor((nowM - minutes(ist("09:15"))) / 10);
    return { ...SET_AT_0915(addMin(ist("09:15"), k * 10)), id: k === 0 ? "OPS-0000" : `OPS-0000-R${k}` };
  }
  if (alertId === "ALT-0002") {
    if (inputs.decisions["SHP-1002"]) return inputs.decisions["SHP-1002"].option_set;
    const k = Math.max(0, Math.floor((nowM - minutes(ist("08:50"))) / 10));
    return { ...SET_1002(addMin(ist("08:50"), k * 10)), id: k === 0 ? "OPS-0002" : `OPS-0002-R${k}` };
  }
  return null;
}

const SPLIT_INFEASIBLE: DecisionOption = { id: "OPT-SPLIT", type: "SPLIT_SHIPMENT", feasible: false, infeasible_reason: "Load is already in transit on one vehicle", label: "Split shipment" };

function SET_AFTER_REPORT(gen: string): OptionSet {
  return {
    id: "OPS-0001", alert_id: "ALT-0001", shipment_id: "SHP-1001", generated_at: gen, based_on_snapshot_id: "ETA-000318",
    valid_until: addMin(gen, 10), recommended_option_id: "OPT-REROUTE-RTE-01B",
    options: [
      { id: "OPT-REROUTE-RTE-01B", type: "REROUTE", feasible: true, label: "Reroute via Khalapur bypass (RTE-01B)", projected_eta: ist("11:39"), projected_late_min: 0, projected_risk_level: "MEDIUM", improvement_min: 46, added_km: 16, added_cost_inr: 720, params: { alt_route_id: "RTE-01B" } },
      { id: "OPT-CONTINUE", type: "CONTINUE", feasible: true, label: "Continue on current route and monitor", projected_eta: ist("12:25"), projected_late_min: 40, projected_risk_level: "HIGH", improvement_min: 0, added_km: 0, added_cost_inr: 0, params: {} },
      { id: "OPT-RESCHEDULE", type: "RESCHEDULE", feasible: true, label: "Accept delay and agree a new delivery time with the customer", projected_eta: ist("12:25"), projected_late_min: 40, projected_risk_level: "LOW", improvement_min: 0, added_km: 0, added_cost_inr: 0, params: { new_agreed_delivery_by: ist("12:45") } },
      SPLIT_INFEASIBLE,
    ],
  };
}

function SET_AT_0915(gen: string): OptionSet {
  return {
    id: "OPS-0000", alert_id: "ALT-0001", shipment_id: "SHP-1001", generated_at: gen, based_on_snapshot_id: "ETA-000312",
    valid_until: addMin(gen, 10), recommended_option_id: "OPT-RESCHEDULE",
    options: [
      { id: "OPT-CONTINUE", type: "CONTINUE", feasible: true, label: "Continue on current route and monitor", projected_eta: ist("11:45"), projected_late_min: 0, projected_risk_level: "MEDIUM", improvement_min: 0, added_km: 0, added_cost_inr: 0, params: {} },
      { id: "OPT-RESCHEDULE", type: "RESCHEDULE", feasible: true, label: "Accept delay and agree a new delivery time with the customer", projected_eta: ist("11:45"), projected_late_min: 0, projected_risk_level: "LOW", improvement_min: 0, added_km: 0, added_cost_inr: 0, params: { new_agreed_delivery_by: ist("12:05") } },
      { id: "OPT-REROUTE-RTE-01B", type: "REROUTE", feasible: true, label: "Reroute via Khalapur bypass (RTE-01B)", projected_eta: ist("11:39"), projected_late_min: 0, projected_risk_level: "MEDIUM", improvement_min: 6, added_km: 16, added_cost_inr: 720, params: { alt_route_id: "RTE-01B" } },
      SPLIT_INFEASIBLE,
    ],
  };
}

function SET_1002(gen: string): OptionSet {
  return {
    id: "OPS-0002", alert_id: "ALT-0002", shipment_id: "SHP-1002", generated_at: gen, based_on_snapshot_id: "ETA-000296",
    valid_until: addMin(gen, 10), recommended_option_id: "OPT-RESCHEDULE",
    options: [
      { id: "OPT-CONTINUE", type: "CONTINUE", feasible: true, label: "Continue on current route and monitor", projected_eta: ist("11:25"), projected_late_min: 15, projected_risk_level: "HIGH", improvement_min: 0, added_km: 0, added_cost_inr: 0, params: {} },
      { id: "OPT-RESCHEDULE", type: "RESCHEDULE", feasible: true, label: "Accept delay and agree a new delivery time with the customer", projected_eta: ist("11:25"), projected_late_min: 15, projected_risk_level: "LOW", improvement_min: 0, added_km: 0, added_cost_inr: 0, params: { new_agreed_delivery_by: ist("11:45") } },
      { id: "OPT-REROUTE-RTE-02B", type: "REROUTE", feasible: false, label: "Reroute via Igatpuri bypass (RTE-02B)", infeasible_reason: "Gross weight 34 t is over the 20 t limit on RTE-02B" },
      SPLIT_INFEASIBLE,
    ],
  };
}

/* ---------------- Notifications (DESIGN.md 8 templates) ---------------- */

function deriveNotifications(inputs: Inputs, now: string, shipments: ShipmentDetail[]): Notification[] {
  const nowM = minutes(now);
  const out: Omit<Notification, "id" | "read_at">[] = [];
  const coords = USERS.filter((u) => u.role === "COORDINATOR").map((u) => u.id);
  const custOf = (cid: string) => USERS.filter((u) => u.customer_id === cid).map((u) => u.id);
  const hhmm = (iso: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(iso)) + " IST";
  const push = (users: string[], n: Omit<Notification, "id" | "read_at" | "user_id">) => users.forEach((user_id) => out.push({ ...n, user_id }));

  // SHP-1002 weather, seeded before the replay starts
  push([...coords, ...custOf("CUS-02")], { shipment_id: "SHP-1002", kind: "RISK_HIGH", title: "ORD-5002 may arrive late", body: `ORD-5002 may arrive late. Current estimate ${hhmm(ist("11:25"))}. Reason: Expected 15 min late: heavy rain at Kasara ghat adds 45 min. Plant X is reviewing options.`, created_at: ist("08:40") });
  if (nowM >= minutes(ist("09:15"))) {
    push(coords, { shipment_id: "SHP-1001", kind: "RISK_MEDIUM", title: "SHP-1001 at risk", body: "SHP-1001 at risk: slow traffic adds 25 min", created_at: ist("09:15") });
  }
  const r1 = inputs.reports["SHP-1001"];
  if (r1) {
    push([...coords, ...custOf("CUS-01")], { shipment_id: "SHP-1001", kind: "RISK_HIGH", title: "ORD-5001 may arrive late", body: `ORD-5001 may arrive late. Current estimate ${hhmm(ist("12:25"))}. Reason: Expected 40 min late: accident ahead at km 75 adds 60 min. Plant X is reviewing options.`, created_at: r1.at });
  }
  for (const [sid, d] of Object.entries(inputs.decisions)) {
    const s = shipments.find((x) => x.id === sid)!;
    const at = d.response.decided_at;
    const eta = hhmm(d.response.predicted.chosen_eta);
    const plain =
      d.option.type === "REROUTE" ? "the truck is taking the Khalapur bypass to avoid the accident"
      : d.option.type === "RESCHEDULE" ? `the delivery time is moved to ${hhmm(String(d.option.params?.new_agreed_delivery_by))}`
      : "the truck continues on its route and Plant X is monitoring it";
    push(custOf(s.order.customer_id), { shipment_id: sid, kind: "DECISION_APPLIED", title: `Update on ${s.order.id}`, body: `Update on ${s.order.id}: ${plain}. New estimate ${eta}.`, created_at: at });
    const instruction =
      d.option.type === "REROUTE" ? "take the Khalapur bypass (RTE-01B). Leave the current route at km 66."
      : d.option.type === "RESCHEDULE" ? `continue on your route. New delivery time ${hhmm(String(d.option.params?.new_agreed_delivery_by))}.`
      : "continue on your route.";
    push([driverOf(sid)], { shipment_id: sid, kind: "DECISION_APPLIED", title: "New instruction", body: `New instruction: ${instruction}`, created_at: at });
  }
  if (inputs.gpsPausedAt && nowM - minutes(inputs.gpsPausedAt) > 30) {
    const n = Math.round(nowM - minutes(inputs.gpsPausedAt));
    push(coords, { shipment_id: "SHP-1001", kind: "TRACKING_LOST", title: "Tracking lost: SHP-1001", body: `No position from SHP-1001 for ${n} min.`, created_at: addMin(inputs.gpsPausedAt, 31) });
  }
  for (const s of shipments) {
    const delivered = s.milestones.find((m) => m.status === "DELIVERED")?.at;
    if (delivered) push([...coords, ...custOf(s.order.customer_id)], { shipment_id: s.id, kind: "DELIVERED", title: `${s.order.id} delivered`, body: `${s.order.id} delivered at ${hhmm(delivered)}.`, created_at: delivered });
  }
  return out
    .filter((n) => minutes(n.created_at) <= nowM)
    .map((n) => {
      const id = `NTF-${n.kind}-${n.shipment_id}-${n.user_id}`;
      return { ...n, id, read_at: inputs.read[id] ?? null };
    })
    .sort((a, b) => minutes(b.created_at) - minutes(a.created_at));
}
