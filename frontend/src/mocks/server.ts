/*
  In-browser stand-in for control-tower-api, used while VITE_USE_MOCKS is on (see src/lib/env.ts).
  It has the same signature as fetch, so the app code path is identical with or without mocks.
  Access rules mirror DESIGN.md 5.4 so the screens behave as they will against the real API.
*/
import type { Decision, DecisionRequest, InvoiceMeta, OnTimeRow, ShipmentDetail, ShipmentEventRequest, ShipmentSummary, StreamHint, User } from "../api/contract";
import { CUSTOMERS, HISTORY, ROUTES, TRANSPORTERS, USERS, minutes } from "./fixtures";
import {
  currentOptionSet, demoState, deriveWorld, driverOf, initialInputs, loadInputs, onInputsChanged, rebase, saveInputs, simNow,
  type Inputs, type World,
} from "./scenario";

const LATENCY_MS = 150;
const invoices = new Map<string, InvoiceMeta & { file: Blob }>();

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function err(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
  return json(status, { error: { code, message, details } });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function userFromAuth(headers: Headers): User | null {
  const token = headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
  if (!token.startsWith("mock.")) return null;
  const u = USERS.find((x) => x.id === token.slice(5));
  if (!u) return null;
  const { phone: _phone, ...user } = u;
  void _phone;
  return user;
}

/** DESIGN.md 9.1 scopeFor(user) */
function canSee(user: User, s: ShipmentDetail): boolean {
  if (user.role === "COORDINATOR") return true;
  if (user.role === "DRIVER") return driverOf(s.id) === user.id;
  return s.order.customer_id === user.customer_id;
}

/** What each role is allowed to receive about a shipment (DESIGN.md 5.4) */
function forRole(user: User, s: ShipmentDetail): ShipmentDetail {
  if (user.role !== "CUSTOMER") return s;
  const alert = s.open_alert && s.open_alert.level === "HIGH" ? s.open_alert : null;
  return { ...s, driver_name: undefined, open_alert: alert };
}

function summary(s: ShipmentDetail): ShipmentSummary {
  return {
    id: s.id, order_id: s.order.id, customer_name: s.customer_name, destination_name: s.destination_name, transporter_name: s.transporter_name,
    status: s.status, active_route_id: s.active_route_id, last_position: s.last_position, current_eta: s.current_eta,
    open_alert: s.open_alert, version: s.version,
    arrived_at: s.milestones.find((m) => m.status === "ARRIVED")?.at ?? null, original_promised_by: s.order.original_promised_by,
  };
}

function update(fn: (i: Inputs) => Inputs) {
  saveInputs(fn(loadInputs()));
}

export async function mockFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
  const path = url.pathname.replace(/^.*\/api\/v1/, "");
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined; // an invoice upload carries a file, not JSON

  if (path === "/stream") return streamResponse(headers, init.signal ?? undefined);
  await wait(LATENCY_MS);

  if (path === "/health") return json(200, { status: "ok", mock: true });
  if (path === "/auth/login" && method === "POST") {
    const u = USERS.find((x) => x.email.toLowerCase() === String(body?.email ?? "").toLowerCase());
    if (!u || !body?.password) return err(401, "INVALID_CREDENTIALS", "Email or password is not correct");
    const { phone: _p, ...user } = u;
    void _p;
    return json(200, { token: `mock.${u.id}`, user });
  }

  // Demo one-tap sign-in, as the API serves it in demo mode.
  if (path === "/auth/demo-accounts" && method === "GET") {
    const org = (u: (typeof USERS)[number]) =>
      u.customer_id ? CUSTOMERS[u.customer_id as keyof typeof CUSTOMERS].name : u.transporter_id ? TRANSPORTERS[u.transporter_id as keyof typeof TRANSPORTERS] : "Plant X";
    return json(200, USERS.map((u) => ({ id: u.id, name: u.name, role: u.role, org: org(u) })));
  }
  if (path === "/auth/demo-login" && method === "POST") {
    const u = USERS.find((x) => x.id === body?.user_id);
    if (!u) return err(404, "NOT_FOUND", "No such demo account");
    const { phone: _p, ...user } = u;
    void _p;
    return json(200, { token: `mock.${u.id}`, user });
  }

  const user = userFromAuth(headers);
  if (!user) return err(401, "UNAUTHENTICATED", "Sign in again");
  // Driver operations run only against the real API; the mock answers with empty data so screens still load.
  if (path === "/me/checks") return json(200, { licence_at: "mock", voice_at: "mock", complete: true });
  if (/^\/shipments\/[^/]+\/(stops|checkins|documents|log)$/.test(path) && method === "GET") return json(200, []);
  if (/^\/shipments\/[^/]+\/driving$/.test(path)) return json(200, { driving_min_since_break: 0, limit_min: 300, break_min: 30, break_due_at: null, overdue: false, on_stop: null });
  if (/^\/shipments\/[^/]+\/driver-contact$/.test(path)) return json(200, { name: "Ravi Shinde", phone: "+91 90000 00101" });
  if (/^\/(shipments\/[^/]+\/(stops|checkins|documents)|stops\/|checkins\/|documents\/)/.test(path)) return err(501, "NOT_IN_MOCK", "Driver operations need the real API (set VITE_USE_MOCKS=false)");

  const inputs = loadInputs();
  const world = deriveWorld(inputs);
  const find = (id: string) => world.shipments.find((s) => s.id === id && canSee(user, s));
  const isCoord = user.role === "COORDINATOR";
  let m: RegExpMatchArray | null;

  if (path === "/me") return json(200, user);

  if (path === "/shipments" && method === "GET") {
    const status = url.searchParams.get("status");
    const risk = url.searchParams.get("risk_level");
    const list = world.shipments
      .filter((s) => canSee(user, s))
      .filter((s) => !status || status.split(",").includes(s.status))
      .filter((s) => !risk || s.current_eta?.risk_level === risk)
      .map((s) => summary(forRole(user, s)))
      .sort((a, b) => (b.current_eta?.risk_score ?? 0) - (a.current_eta?.risk_score ?? 0));
    return json(200, list);
  }

  if ((m = path.match(/^\/shipments\/([\w-]+)$/)) && method === "GET") {
    const s = find(m[1]);
    if (!s) return err(404, "NOT_FOUND", "Shipment not found");
    const { file: _f, ...invoice } = invoices.get(s.id) ?? { file: null };
    void _f;
    return json(200, { ...forRole(user, s), ...(user.role === "DRIVER" ? {} : { invoice: "filename" in invoice ? invoice : null }) });
  }

  // Invoices are kept in memory only: a page reload or a demo reset clears them.
  if ((m = path.match(/^\/shipments\/([\w-]+)\/invoice\/generate$/)) && method === "POST") {
    const s = find(m[1]);
    if (!isCoord) return err(403, "FORBIDDEN", "Not allowed for this role");
    if (!s) return err(404, "NOT_FOUND", "Shipment not found");
    // The mock has no PDF builder: a one-line placeholder stands in for the API's real invoice.
    const file = new Blob([`%PDF-1.4\n% Mock invoice for ${s.order.id}. The real API builds the full page.\n%%EOF\n`], { type: "application/pdf" });
    const meta = { filename: `INV-${s.order.id.replace(/^ORD-/, "")}.pdf`, size_bytes: file.size, uploaded_at: world.now, uploaded_by_name: user.name };
    invoices.set(s.id, { ...meta, file });
    return json(201, meta);
  }
  if ((m = path.match(/^\/shipments\/([\w-]+)\/invoice$/))) {
    const s = find(m[1]);
    if (user.role === "DRIVER" || (method === "POST" && !isCoord)) return err(403, "FORBIDDEN", "Not allowed for this role");
    if (!s) return err(404, "NOT_FOUND", "Shipment not found");
    if (method === "POST") {
      const file = init.body as Blob;
      if (!(file instanceof Blob) || !(await file.slice(0, 5).text()).startsWith("%PDF-")) return err(422, "VALIDATION_FAILED", "That file is not a PDF");
      const meta = { filename: url.searchParams.get("filename") ?? "invoice.pdf", size_bytes: file.size, uploaded_at: world.now, uploaded_by_name: user.name };
      invoices.set(s.id, { ...meta, file });
      return json(201, meta);
    }
    const stored = invoices.get(s.id);
    if (!stored) return err(404, "NOT_FOUND", "No invoice has been uploaded for this shipment");
    return new Response(stored.file, { status: 200, headers: { "Content-Type": "application/pdf" } });
  }

  if ((m = path.match(/^\/shipments\/([\w-]+)\/eta-history$/))) {
    const s = find(m[1]);
    return s ? json(200, world.history[s.id] ?? []) : err(404, "NOT_FOUND", "Shipment not found");
  }

  if ((m = path.match(/^\/shipments\/([\w-]+)\/events$/)) && method === "POST") {
    return postEvent(user, m[1], body as ShipmentEventRequest, world);
  }

  if ((m = path.match(/^\/routes\/([\w-]+)$/))) {
    const r = ROUTES[m[1]];
    return r ? json(200, r) : err(404, "NOT_FOUND", "Route not found");
  }

  if (path === "/alerts" && method === "GET") {
    if (!isCoord) return err(403, "FORBIDDEN", "Not allowed for this role");
    const status = url.searchParams.get("status");
    return json(200, world.alerts.filter((a) => !status || a.status === status));
  }

  if ((m = path.match(/^\/alerts\/([\w-]+)\/options$/))) {
    if (!isCoord) return err(403, "FORBIDDEN", "Not allowed for this role");
    const set = currentOptionSet(inputs, m[1]);
    return set ? json(200, set) : err(404, "NOT_FOUND", "No options for this alert");
  }

  if ((m = path.match(/^\/shipments\/([\w-]+)\/decisions$/)) && method === "POST") {
    if (!isCoord) return err(403, "FORBIDDEN", "Not allowed for this role");
    return postDecision(user, m[1], body as DecisionRequest, world);
  }

  if (path === "/decisions") {
    if (!isCoord) return err(403, "FORBIDDEN", "Not allowed for this role");
    const sid = url.searchParams.get("shipment_id");
    return json(200, world.decisions.filter((d) => !sid || d.shipment_id === sid).sort((a, b) => b.decided_at.localeCompare(a.decided_at)));
  }
  if ((m = path.match(/^\/decisions\/([\w-]+)$/))) {
    if (!isCoord) return err(403, "FORBIDDEN", "Not allowed for this role");
    const d = world.decisions.find((x) => x.id === m![1]);
    return d ? json(200, d) : err(404, "NOT_FOUND", "Decision not found");
  }

  if (path === "/notifications") return json(200, world.notifications.filter((n) => n.user_id === user.id));
  if ((m = path.match(/^\/notifications\/([\w-]+)\/read$/)) && method === "POST") {
    const id = m[1];
    if (!world.notifications.some((n) => n.id === id && n.user_id === user.id)) return err(404, "NOT_FOUND", "Notification not found");
    update((i) => ({ ...i, read: { ...i.read, [id]: world.now } }));
    return json(200, { id, read_at: world.now });
  }

  if (path === "/assistant") return json(200, { configured: true, provider: "Groq", model: "mock (no language model)" });
  if (path === "/assistant/ask" && method === "POST") {
    // No language model in the mock: a fixed-form answer from the same data the screens show.
    const question = String(body?.question ?? "").trim();
    if (!question) return err(422, "VALIDATION_FAILED", "Invalid body");
    const mine = world.shipments.filter((s) => canSee(user, s));
    const asked = mine.find((s) => question.toUpperCase().includes(s.id)) ?? mine.find((s) => s.status === "IN_TRANSIT") ?? mine[0];
    const eta = asked?.current_eta;
    const answer = !asked
      ? "I do not have any shipments for you."
      : `${asked.id} is ${asked.status.toLowerCase().replace(/_/g, " ")}.${eta ? ` ${eta.headline}.` : ""} (Mock answer: the real assistant needs the API.)`;
    return json(200, { answer, provider: "Groq", model: "mock (no language model)" });
  }

  if (path === "/weather/routes") {
    if (!isCoord) return err(403, "FORBIDDEN", "Not allowed for this role");
    return json(200, MOCK_WEATHER);
  }

  if (path.startsWith("/dashboard/") || path.startsWith("/metrics/")) {
    if (!isCoord) return err(403, "FORBIDDEN", "Not allowed for this role");
    return dashboard(path, url.searchParams.get("group_by") === "transporter" ? "transporter" : "route", world);
  }

  if (path.startsWith("/demo/")) {
    if (!isCoord) return err(403, "FORBIDDEN", "Not allowed for this role");
    if (path === "/demo/state") return json(200, demoState(inputs));
    if (path === "/demo/reset" && method === "POST") {
      invoices.clear();
      saveInputs(initialInputs());
      return json(200, demoState(initialInputs()));
    }
    if ((m = path.match(/^\/demo\/scenarios\/([\w-]+)\/start$/)) && method === "POST") {
      const next = { ...rebase(inputs, true, inputs.speed || 60), started: true };
      saveInputs(next);
      return json(200, demoState(next));
    }
    if (path === "/demo/clock" && method === "POST") {
      // Changing speed before Start only stores the speed; resuming counts as starting.
      const running = body?.paused === false;
      const next = { ...rebase(inputs, running, typeof body?.speed === "number" ? body.speed : inputs.speed), started: inputs.started || running };
      saveInputs(next);
      return json(200, demoState(next));
    }
    // Mock-only controls for failure cases; the real API has no equivalent yet (see CONTRACT_GAPS.md).
    if (path === "/demo/mock-controls") {
      if (method === "POST") {
        const now = simNow(inputs).now;
        const next: Inputs = {
          ...inputs,
          gpsPausedAt: body?.gps_paused === undefined ? inputs.gpsPausedAt : body.gps_paused ? now : null,
          failDriverUpdates: body?.fail_driver_updates ?? inputs.failDriverUpdates,
          dropStream: body?.drop_stream ?? inputs.dropStream,
        };
        saveInputs(next);
        return json(200, mockControls(next));
      }
      return json(200, mockControls(inputs));
    }
  }

  return err(404, "NOT_FOUND", `No mock for ${method} ${path}`);
}

function mockControls(i: Inputs) {
  return { gps_paused: !!i.gpsPausedAt, fail_driver_updates: i.failDriverUpdates, drop_stream: i.dropStream };
}

/* ---------------- Events (DESIGN.md 5.6) ---------------- */

const DRIVER_MILESTONES = ["IN_TRANSIT", "ARRIVED", "DELIVERED"];
const COORD_MILESTONES = ["DISPATCHED", "CANCELLED"];
const NEXT: Record<string, string[]> = { PLANNED: ["DISPATCHED", "IN_TRANSIT", "CANCELLED"], DISPATCHED: ["IN_TRANSIT", "CANCELLED"], IN_TRANSIT: ["ARRIVED"], ARRIVED: ["DELIVERED"] };

function postEvent(user: User, shipmentId: string, ev: ShipmentEventRequest, world: World): Response | Promise<Response> {
  const inputs = loadInputs();
  if (user.role === "DRIVER" && inputs.failDriverUpdates) return Promise.reject(new TypeError("Failed to fetch (mock network failure)"));
  if (user.role === "CUSTOMER") return err(403, "FORBIDDEN", "Customers cannot post events");
  const s = world.shipments.find((x) => x.id === shipmentId);
  if (!s) return err(404, "NOT_FOUND", "Shipment not found");
  if (user.role === "DRIVER" && driverOf(shipmentId) !== user.id) return err(403, "FORBIDDEN", "This shipment is not assigned to you");
  if (!ev?.event_id || !ev.type || typeof ev.payload !== "object") return err(422, "VALIDATION_FAILED", "event_id, type and payload are required");

  const stored = inputs.events[ev.event_id];
  if (stored) return json(200, { ...(stored as object), apply_status: "DUPLICATE" });

  const now = world.now;
  const base = { event_id: ev.event_id, shipment_id: shipmentId, shipment_version: s.version + 1, occurred_at: now };
  let next: Inputs = inputs;
  let snapshotId: string | null = s.current_eta?.id ?? null;

  if (ev.type === "MILESTONE") {
    const to = String(ev.payload.to_status);
    const allowed = user.role === "DRIVER" ? DRIVER_MILESTONES : COORD_MILESTONES;
    if (!allowed.includes(to)) return err(403, "FORBIDDEN", `${user.role} cannot set ${to}`);
    if (to === s.status) return json(200, { ...base, shipment_version: s.version, apply_status: "DUPLICATE", eta_snapshot_id: snapshotId });
    if (!NEXT[s.status]?.includes(to)) return err(409, "INVALID_TRANSITION", `Cannot go from ${s.status} to ${to}`, { from: s.status, to });
    next = { ...inputs, milestones: { ...inputs.milestones, [shipmentId]: [...(inputs.milestones[shipmentId] ?? []), { status: to as never, at: now }] } };
  } else if (ev.type === "DISRUPTION_REPORTED") {
    const p = ev.payload as { category?: string; expected_delay_min?: number; at_km?: number; note?: string };
    if (!p.category) return err(422, "VALIDATION_FAILED", "payload.category is required");
    if (!inputs.reports[shipmentId]) {
      next = {
        ...inputs,
        reports: { ...inputs.reports, [shipmentId]: { event_id: ev.event_id, at: now, category: p.category as never, expected_delay_min: p.expected_delay_min ?? null, at_km: p.at_km ?? null, note: p.note } },
      };
      if (shipmentId === "SHP-1001") snapshotId = "ETA-000318";
    }
  } else if (ev.type === "DISRUPTION_CLEARED") {
    // Accepted and stored; the mock scenario's ground truth decides when the accident clears.
  } else if (ev.type === "POSITION") {
    return json(201, { ...base, apply_status: "STORED_NOT_APPLIED", eta_snapshot_id: snapshotId });
  } else {
    return err(422, "VALIDATION_FAILED", `Unknown event type ${ev.type}`);
  }

  const response = { ...base, apply_status: "APPLIED", eta_snapshot_id: snapshotId };
  saveInputs({ ...next, events: { ...next.events, [ev.event_id]: response } });
  return json(201, response);
}

/* ---------------- Decisions (DESIGN.md 5.7.3) ---------------- */

function postDecision(user: User, shipmentId: string, req: DecisionRequest, world: World): Response {
  const inputs = loadInputs();
  const prior = Object.values(inputs.decisions).find((d) => d.response.decision_id === req?.decision_id);
  if (prior) return json(200, prior.response);
  const s = world.shipments.find((x) => x.id === shipmentId);
  if (!s) return err(404, "NOT_FOUND", "Shipment not found");
  const alert = world.alerts.find((a) => a.shipment_id === shipmentId);
  if (!alert) return err(409, "OPTIONS_STALE", "There is no alert for this shipment");
  if (alert.status !== "OPEN") return err(409, "ALERT_ALREADY_DECIDED", "A decision has already been made for this alert");
  const set = currentOptionSet(inputs, alert.id);
  if (!set || set.id !== req.option_set_id) return err(409, "OPTIONS_STALE", "The situation changed since these options were generated", { current_option_set_id: set?.id ?? null });
  const option = set.options.find((o) => o.id === req.option_id);
  if (!option) return err(422, "VALIDATION_FAILED", "Unknown option");
  if (!option.feasible) return err(409, "OPTION_INFEASIBLE", option.infeasible_reason ?? "Option is not available");

  const noAction = set.options.find((o) => o.type === "CONTINUE")?.projected_eta ?? option.projected_eta!;
  const response: Decision = {
    id: `DEC-000${Object.keys(inputs.decisions).length + 1}`,
    decision_id: req.decision_id,
    shipment_id: shipmentId,
    option_type: option.type,
    decided_by: user.id,
    decided_at: world.now,
    shipment_version: s.version + 1,
    eta_snapshot_id: shipmentId === "SHP-1001" ? "ETA-000319" : "ETA-000320",
    notifications_created: 2,
    predicted: { chosen_eta: option.projected_eta!, no_action_eta: noAction },
    outcome: null,
  };
  saveInputs({ ...inputs, decisions: { ...inputs.decisions, [shipmentId]: { response, option_set: set, option, note: req.note?.trim() || null } } });
  return json(201, response);
}

/* ---------------- Dashboard (shapes PROPOSED, see CONTRACT_GAPS.md) ---------------- */

function dashboard(path: string, groupBy: "route" | "transporter", world: World): Response {
  const arrived = world.shipments
    .map((s) => ({ s, at: s.milestones.find((m) => m.status === "ARRIVED")?.at }))
    .filter((x): x is { s: ShipmentDetail; at: string } => !!x.at);
  const keyOf = (s: ShipmentDetail) => (groupBy === "route" ? s.planned_route_id : s.transporter_id);
  const lateMin = (s: ShipmentDetail, at: string) => Math.max(0, Math.round(minutes(at) - minutes(s.order.original_promised_by)));

  if (path === "/dashboard/on-time") {
    const rows: OnTimeRow[] = HISTORY.onTime[groupBy].map((r) => {
      const extra = arrived.filter((a) => keyOf(a.s) === r.group_id);
      const delivered = r.delivered + extra.length;
      const onTime = r.on_time + extra.filter((a) => lateMin(a.s, a.at) === 0).length;
      return { ...r, delivered, on_time: onTime, on_time_pct: Math.round((onTime / delivered) * 1000) / 10 };
    });
    return json(200, rows);
  }
  if (path === "/dashboard/delay-causes") {
    const rows = HISTORY.delayCauses[groupBy].map((r) => {
      const causes: Record<string, number> = { ...r.minutes_by_cause };
      for (const a of arrived.filter((x) => keyOf(x.s) === r.group_id)) {
        const late = lateMin(a.s, a.at);
        if (late > 0) {
          const cause = a.s.id === "SHP-1002" ? "WEATHER" : "ACCIDENT";
          causes[cause] = (causes[cause] ?? 0) + late;
        }
      }
      return { ...r, minutes_by_cause: causes };
    });
    return json(200, rows);
  }
  if (path === "/metrics/impact") {
    const decided = world.decisions.filter((d) => d.outcome);
    const leadTimes = world.alerts.map((a) => {
      const s = world.shipments.find((x) => x.id === a.shipment_id)!;
      return Math.round(minutes(s.order.original_promised_by) - minutes(a.opened_at));
    });
    const sorted = [...leadTimes].sort((a, b) => a - b);
    const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
    const avoided = decided.reduce((s, d) => s + (d.outcome!.delay_avoided_min ?? 0), 0);
    const histDelivered = 40;
    const histOnTime = 29;
    const withD = arrived.filter((a) => lateMin(a.s, a.at) === 0).length;
    const withoutD = decided.filter((d) => {
      const s = world.shipments.find((x) => x.id === d.shipment_id)!;
      return minutes(d.outcome!.counterfactual_no_action_arrival ?? d.outcome!.actual_arrival) <= minutes(s.order.original_promised_by);
    }).length + arrived.filter((a) => !world.decisions.some((d) => d.shipment_id === a.s.id) && lateMin(a.s, a.at) === 0).length;
    const total = histDelivered + arrived.length;
    return json(200, {
      warning_lead_time_median_min: median,
      eta_error_mean_min: decided.length ? Math.round((decided.reduce((s, d) => s + d.outcome!.eta_error_min, 0) / decided.length) * 10) / 10 : null,
      alert_precision: decided.length ? 1 : null,
      alert_recall: decided.length ? 1 : null,
      delay_avoided_total_min: decided.length ? avoided : null,
      on_time_pct_with_decisions: Math.round(((histOnTime + withD) / total) * 1000) / 10,
      on_time_pct_without_decisions: Math.round(((histOnTime + withoutD) / total) * 1000) / 10,
      cost_of_lateness_avoided_inr: decided.length ? Math.round((avoided / 60) * 1500) : null,
      assumptions: [
        "Every figure comes from a fictional scenario; it shows the mechanism works, not real performance.",
        "Today's lead time is zero or less: lateness is learned only after it happens.",
        "Cost per late hour is a fictional ₹1,500 per shipment.",
        "Counterfactual arrivals exist only because the simulator knows the scenario's ground truth.",
      ],
    });
  }
  return err(404, "NOT_FOUND", "Unknown dashboard query");
}

/* ---------------- Stream (DESIGN.md 5.8) ---------------- */

function fingerprints(user: User, world: World, inputs: Inputs): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of world.shipments) {
    if (!canSee(user, s)) continue;
    out.set(`shipment:${s.id}`, `${s.version}|${s.status}|${s.last_position?.progress_km}|${s.current_eta?.id}|${s.open_alert?.level}`);
  }
  out.set("notification:", String(world.notifications.filter((n) => n.user_id === user.id).map((n) => n.id + (n.read_at ?? "")).join()));
  if (user.role === "COORDINATOR") {
    const d = demoState(inputs);
    out.set("demo:", `${d.scenario_status}|${d.clock}|${d.speed}`);
    out.set("dashboard:", String(world.decisions.map((x) => x.outcome?.actual_arrival).join()));
  }
  return out;
}

function streamResponse(headers: Headers, signal?: AbortSignal): Promise<Response> {
  const user = userFromAuth(headers);
  if (!user) return Promise.resolve(err(401, "UNAUTHENTICATED", "Sign in again"));
  if (loadInputs().dropStream) return Promise.reject(new TypeError("Failed to fetch (mock stream dropped)"));
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let unsubscribe = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let last = fingerprints(user, deriveWorld(loadInputs()), loadInputs());
      const close = () => {
        clearInterval(timer);
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const check = () => {
        const inputs = loadInputs();
        if (inputs.dropStream) {
          clearInterval(timer);
          clearInterval(keepAlive);
          unsubscribe();
          controller.error(new TypeError("mock stream dropped"));
          return;
        }
        const now = fingerprints(user, deriveWorld(inputs), inputs);
        for (const [key, value] of now) {
          if (last.get(key) === value) continue;
          const [entity, id] = key.split(":");
          const hint: StreamHint = { entity: entity as StreamHint["entity"], ...(id ? { id } : {}) };
          controller.enqueue(encoder.encode(`event: change\ndata: ${JSON.stringify(hint)}\n\n`));
        }
        last = now;
      };
      controller.enqueue(encoder.encode(": connected\n\n"));
      timer = setInterval(check, 1000);
      keepAlive = setInterval(() => controller.enqueue(encoder.encode(": keep-alive\n\n")), 15_000);
      unsubscribe = onInputsChanged(check);
      signal?.addEventListener("abort", close);
    },
    cancel() {
      clearInterval(timer);
      clearInterval(keepAlive);
      unsubscribe();
    },
  });
  return Promise.resolve(new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
}

/** Fixed sample for the mock API; the real backend asks Open-Meteo. */
const MOCK_WEATHER = {
  mode: "ADVISORY",
  source: "Sample data (mock API); the real backend uses Open-Meteo",
  status: "OK",
  fetched_at: "2026-11-16T03:20:00Z",
  error: null,
  routes: [
    { route_id: "RTE-01", route_name: "Talegaon-Chakan road", level: "CLEAR", suggested_delay_min: 0, worst: null, points: [] },
    { route_id: "RTE-01B", route_name: "Pune-Shikrapur road", level: "CLEAR", suggested_delay_min: 0, worst: null, points: [] },
    { route_id: "RTE-02", route_name: "Kasara ghat road", level: "MODERATE", suggested_delay_min: 10, worst: { km: 120, reasons: ["rain 2 mm/h"] }, points: [] },
    { route_id: "RTE-02B", route_name: "Wada-Trimbakeshwar road", level: "CLEAR", suggested_delay_min: 0, worst: null, points: [] },
  ],
};
