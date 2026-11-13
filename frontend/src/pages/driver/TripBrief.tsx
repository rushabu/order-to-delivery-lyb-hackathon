import { Link, useNavigate } from "react-router";
import { Bell, ShieldCheck, Warning } from "@phosphor-icons/react";
import { useMarkRead, useNotifications } from "../../api/queries";
import type { ShipmentDetail, ShipmentSummary } from "../../api/contract";
import type { useRoutes } from "../../api/useShipmentRoutes";
import { ShipmentRoadMap } from "../../components/ShipmentRoadMap";
import { shipmentLayers } from "../../components/ShipmentParts";
import { Button, StatusTag } from "../../components/ui";
import { CATEGORY_WORD } from "../../lib/risk";
import { clock } from "../../lib/time";

/*
  Driver: what a newly assigned trip needs. A banner when Plant X assigns one, a switcher between
  trips, the route map with what is ahead, and safety points worked out from this trip's load, times and alerts.
*/

const ACTIVE = new Set(["PLANNED", "DISPATCHED", "IN_TRANSIT", "ARRIVED"]);

/** Unread "new trip" notifications, with a button that opens the trip. */
export function NewTripBanner() {
  const notes = useNotifications();
  const markRead = useMarkRead();
  const navigate = useNavigate();
  const fresh = notes.data?.filter((n) => n.kind === "NEW_TRIP" && !n.read_at) ?? [];
  if (!fresh.length) return null;
  return (
    <div className="space-y-2">
      {fresh.map((n) => (
        <section key={n.id} role="status" aria-label="New trip" className="border-l-4 border-accent bg-accent-soft p-4">
          <p className="flex items-center gap-2 text-lead font-semibold text-ink">
            <Bell size={20} weight="fill" aria-hidden /> {n.title}
          </p>
          <p className="mt-1 text-body text-ink-2">{n.body}</p>
          <Button
            variant="primary"
            size="lg"
            className="mt-3"
            onClick={() => {
              markRead.mutate(n.id);
              if (n.shipment_id) navigate(`/driver?trip=${n.shipment_id}`);
            }}
          >
            Open trip
          </Button>
        </section>
      ))}
    </div>
  );
}

/** All trips not yet delivered, when there is more than one. */
export function TripSwitcher({ trips, currentId }: { trips: ShipmentSummary[]; currentId: string }) {
  const open = trips.filter((t) => ACTIVE.has(t.status));
  if (open.length < 2) return null;
  return (
    <nav aria-label="Your trips" className="border-y border-line">
      <ul className="divide-y divide-line">
        {open.map((t) => {
          const here = t.id === currentId;
          return (
            <li key={t.id}>
              <Link
                to={`/driver?trip=${t.id}`}
                aria-current={here ? "page" : undefined}
                className={`flex items-center gap-3 border-l-4 px-3 py-2.5 transition-colors duration-150 ${here ? "border-accent bg-raised" : "border-transparent hover:bg-raised"}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-semibold text-ink">{t.id}</span>
                  <span className="block truncate text-meta text-ink-2">{t.destination_name}</span>
                </span>
                {t.current_eta && <span className="tnum text-meta text-muted">due {clock(t.current_eta.eta)}</span>}
                <StatusTag status={t.status} />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The route on a map, and every alert on it in words. */
export function RouteAndAlerts({ s, routes }: { s: ShipmentDetail; routes: ReturnType<typeof useRoutes> }) {
  const layers = shipmentLayers(s, routes, { drawInActive: false });
  const alerts: string[] = [];
  const eta = s.current_eta;
  if (eta && eta.risk_level !== "LOW") alerts.push(`${eta.headline}. Plant X is watching this trip.`);
  for (const d of s.active_disruptions.filter((x) => !x.cleared_at)) {
    alerts.push(`${CATEGORY_WORD[d.category] ?? "Problem"}${typeof d.at_km === "number" ? ` at km ${Math.round(d.at_km)}` : ""}, about ${d.expected_delay_min} min delay`);
  }
  const traffic = s.live_traffic?.traffic_delay_min ?? 0;
  if (traffic > 0) alerts.push(`Traffic adds about ${traffic} min. Open "Traffic flow and incidents" on the map for details.`);

  return (
    <section aria-labelledby="route-h" className="rounded-lg border border-line bg-surface">
      <h2 id="route-h" className="border-b border-line px-4 py-3 text-body font-semibold">
        Route and alerts
      </h2>
      <div className="p-3">
        <p className="mb-2 text-body font-semibold">{routes[s.active_route_id]?.name ?? s.active_route_id}</p>
        <ShipmentRoadMap
          shipment={s}
          label={`Map of trip ${s.id} to ${s.destination_name}`}
          routes={layers.routes}
          markers={layers.marker ? [{ ...layers.marker, label: "Your truck", emphasis: true }] : []}
          traffic={s.live_traffic}
          focusRouteIds={[s.planned_route_id, s.active_route_id]}
          className="h-[260px]"
        />
      </div>
      <div className="px-4 pb-4">
        {alerts.length ? (
          <ul className="space-y-2">
            {alerts.map((a) => (
              <li key={a} className="flex gap-2 border-l-4 border-medium bg-medium-soft px-3 py-2 text-body text-ink">
                <Warning size={18} weight="bold" aria-hidden className="mt-0.5 shrink-0 text-medium" /> {a}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-ink-2">No alerts on this route right now.</p>
        )}
      </div>
    </section>
  );
}

/** Hour of the day in India, 0 to 23. */
const istHour = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).getUTCHours();

/** Safety points for this trip: the fixed basics plus the ones its load, timing and alerts call for. */
export function safetyPoints(s: ShipmentDetail): string[] {
  const more = s.extra_orders?.length ?? 0;
  const extra = more ? ` and ${more} more order${more === 1 ? "" : "s"}` : "";
  const points = [
    "Before you leave: tyres, brakes, lights, mirrors, wipers and fuel.",
    `Load: ${s.quantity_t} t ${s.order.product}${extra}. Stack the bags evenly, strap them and cover them with a tarpaulin. Gross weight ${s.gross_t} t: take nothing extra.`,
    "Plastic pellets burn: no smoking or open flame near the load, and keep the fire extinguisher in reach.",
    "Seat belt on. No phone in your hand while moving: take Plant X calls when stopped or hands-free.",
    "Rest at least 30 min after every 5 hours of driving. The app reminds you.",
  ];
  const hours = [s.planned_departure, s.current_eta?.eta].filter((x): x is string => !!x).map(istHour);
  if (hours.some((h) => h >= 19 || h < 6)) points.push("Part of this trip is after dark: use dipped headlights, keep extra distance, and never stop on the shoulder.");
  if (s.current_eta && s.current_eta.risk_level !== "LOW") points.push("Running late? Do not speed to make up time. Plant X already knows and plans around it.");
  if (s.active_disruptions.some((d) => !d.cleared_at)) points.push("Problem reported on the route: slow down near it and follow police or diversion signs.");
  return points;
}

export function SafetyList({ s }: { s: ShipmentDetail }) {
  return (
    <section aria-labelledby="safety-h" className="rounded-lg border border-line bg-surface p-4">
      <h2 id="safety-h" className="flex items-center gap-2 text-body font-semibold">
        <ShieldCheck size={20} weight="bold" aria-hidden /> Safety for this trip
      </h2>
      <ul className="mt-3 space-y-2">
        {safetyPoints(s).map((p) => (
          <li key={p} className="border-l-[3px] border-accent pl-3 text-body text-ink-2">
            {p}
          </li>
        ))}
      </ul>
    </section>
  );
}
