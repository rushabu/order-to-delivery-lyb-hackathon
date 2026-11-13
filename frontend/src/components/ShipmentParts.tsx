import { Check, Truck, WarningCircle, WarningOctagon } from "@phosphor-icons/react";
import type { Alert, EtaSnapshot, Milestone, RouteDetail, ShipmentDetail } from "../api/contract";
import { RISK_WORD, STATUS_WORD } from "../lib/risk";
import { clock, clockTz, dateTimeTz } from "../lib/time";
import { Button, RiskBadge } from "./ui";
import type { MapMarker, MapRoute } from "./ShipmentMap";

/* ---------------- Milestone timeline (DESIGN.md 5.3, 7.2) ---------------- */

export function MilestoneTimeline({ milestones, layout = "horizontal" }: { milestones: Milestone[]; layout?: "horizontal" | "vertical" }) {
  const current = milestones.filter((m) => m.at).at(-1)?.status;
  return (
    <ol className={layout === "horizontal" ? "grid grid-cols-5 gap-2" : "space-y-3"}>
      {milestones.map((m) => {
        const done = !!m.at;
        const isCurrent = m.status === current;
        return (
          <li key={m.status} aria-current={isCurrent ? "step" : undefined} className={layout === "horizontal" ? "min-w-0" : "flex items-center gap-3"}>
            <div className={layout === "horizontal" ? "flex items-center gap-2" : "contents"}>
              <span
                aria-hidden
                className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${
                  done ? (isCurrent ? "border-accent bg-accent text-on-accent" : "border-ink-2 bg-ink-2 text-surface") : "border-line-strong bg-surface"
                }`}
              >
                {done && <Check size={12} weight="bold" />}
              </span>
              {layout === "horizontal" && <span className={`h-0.5 flex-1 ${done ? "bg-ink-2" : "bg-line"}`} aria-hidden />}
            </div>
            <div className={layout === "horizontal" ? "mt-2" : ""}>
              <p className={`text-meta font-semibold ${done ? "text-ink" : "text-muted"}`}>{STATUS_WORD[m.status]}</p>
              <p className="tnum text-meta text-muted">
                {m.at ? clockTz(m.at) : "Not yet"}
                {isCurrent && <span className="sr-only"> (current stage)</span>}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/* ---------------- Alert banner ---------------- */

export function AlertBanner({ alert, headline, onReview }: { alert: Alert; headline: string; onReview?: () => void }) {
  const high = alert.level === "HIGH";
  const Icon = high ? WarningOctagon : WarningCircle;
  return (
    <div
      role="region"
      aria-label={`Alert ${alert.id}`}
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-5 py-4 ${high ? "border-high/30 bg-high-soft" : "border-medium/30 bg-medium-soft"}`}
    >
      <Icon size={24} weight="bold" aria-hidden className={high ? "text-high" : "text-medium"} />
      <div className="min-w-0 flex-1">
        <p className={`text-lead font-semibold ${high ? "text-high" : "text-medium"}`}>
          <span className="sr-only">{RISK_WORD[alert.level]}. </span>
          {headline}
        </p>
        <p className="tnum text-meta text-ink-2">
          {RISK_WORD[alert.level]}. Alert {alert.id} opened {clockTz(alert.opened_at)}. Needs a decision.
        </p>
      </div>
      {onReview && (
        <Button variant="primary" onClick={onReview}>
          Review options
        </Button>
      )}
    </div>
  );
}

/* ---------------- Text alternative to the map (DESIGN.md 7.6) ---------------- */

export function positionText(s: Pick<ShipmentDetail, "last_position" | "active_route_id" | "status"> & { current_eta: EtaSnapshot | null }, route?: RouteDetail): string {
  const p = s.last_position;
  if (!p) return s.status === "PLANNED" || s.status === "DISPATCHED" ? "Not departed yet." : "No position received.";
  const stale = s.current_eta?.confidence === "LOW" && (s.current_eta?.position_age_min ?? 0) > 0;
  const of = route ? ` of ${route.total_km}` : "";
  return `km ${p.progress_km === null ? '?' : Math.round(p.progress_km)}${of} on ${s.active_route_id}, ${stale ? "last seen" : "last update"} ${clockTz(p.occurred_at)}.`;
}

export function isStale(eta: EtaSnapshot | null | undefined) {
  return !!eta && eta.confidence === "LOW" && eta.position_age_min > 0;
}

/** Map layers for one shipment: active route solid, the planned route dashed if it was replaced, alternatives dotted. */
export function shipmentLayers(
  s: ShipmentDetail,
  routes: Record<string, RouteDetail | undefined>,
  options: { drawInActive?: boolean; showAlternatives?: boolean } = {},
): { routes: MapRoute[]; marker: MapMarker | null } {
  const out: MapRoute[] = [];
  const active = routes[s.active_route_id];
  const planned = routes[s.planned_route_id];
  const rerouted = s.active_route_id !== s.planned_route_id;
  if (rerouted && planned) out.push({ route: planned, style: "previous" });
  if (active) out.push({ route: active, style: "active", drawIn: rerouted && options.drawInActive });
  if (!rerouted && options.showAlternatives && planned) {
    for (const alt of planned.alternatives) {
      const r = routes[alt.alt_route_id];
      if (r) out.push({ route: r, style: "alternative" });
    }
  }
  const p = s.last_position;
  const stale = isStale(s.current_eta);
  const marker = p
    ? { id: s.id, lat: p.lat, lng: p.lng, label: stale ? `${s.id}, last seen ${clock(p.occurred_at)}` : s.id, stale, emphasis: !!s.open_alert }
    : null;
  return { routes: out, marker };
}

export function RiskCell({ eta }: { eta: EtaSnapshot | null }) {
  return eta ? <RiskBadge level={eta.risk_level} /> : <span className="text-meta text-muted">No estimate</span>;
}

/*
  Journey bar: how far along its route the truck is, from the API's progress_km and the route length.
  The truck marker glides to each new position (CSS transform transition); reduced motion jumps.
*/
export function JourneyBar({ from, to, progressKm, totalKm, status }: { from: string; to: string; progressKm: number | null; totalKm: number | null; status: ShipmentDetail["status"] }) {
  const done = status === "ARRIVED" || status === "DELIVERED";
  const pct = done ? 100 : progressKm !== null && totalKm ? Math.min(100, Math.max(0, (progressKm / totalKm) * 100)) : 0;
  return (
    <div>
      <div className="relative h-8 [container-type:inline-size]" aria-hidden>
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-sunken" />
        <div className="journey-fill absolute left-0 top-1/2 h-1.5 w-full origin-left -translate-y-1/2 rounded-full bg-accent" style={{ transform: `translateY(-50%) scaleX(${pct / 100})` }} />
        {/* Zero-width anchor moved with container units, so the marker can never widen the page */}
        <div className="journey-truck absolute inset-y-0 left-0 w-0" style={{ transform: `translateX(${pct}cqw)` }}>
          <span className="absolute top-1/2 inline-flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-raised bg-accent text-on-accent">
            <Truck size={14} weight="fill" />
          </span>
        </div>
      </div>
      <div className="mt-1 grid grid-cols-[1fr_auto_1fr] gap-3 text-meta text-muted">
        <span className="min-w-0">{from}</span>
        <span className="tnum whitespace-nowrap font-medium text-ink-2">{done ? "Arrived" : progressKm !== null && totalKm ? `km ${Math.round(progressKm)} of ${totalKm}` : "Not departed"}</span>
        <span className="text-right">{to}</span>
      </div>
    </div>
  );
}

/** Orders that were added to this truck at dispatch (same customer, same delivery point). */
export function ExtraOrders({ shipment }: { shipment: { order: { id: string }; extra_orders?: { id: string; product: string; quantity_t: number; promised_by: string }[] } }) {
  if (!shipment.extra_orders?.length) return null;
  return (
    <div className="border-t border-line px-5 py-4">
      <h3 className="text-meta font-semibold text-ink">Also on this truck</h3>
      <ul className="mt-2 space-y-2">
        {shipment.extra_orders.map((o) => (
          <li key={o.id} className="tnum border-l-[3px] border-accent pl-3 text-body text-ink-2">
            <span className="font-semibold text-ink">{o.id}</span>, {o.quantity_t} t {o.product}
            <span className="block text-meta text-muted">Promised {dateTimeTz(o.promised_by)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1 text-meta text-muted">Added to the truck already planned for order {shipment.order.id}; one trip instead of two.</p>
    </div>
  );
}
