import { Link } from "react-router";
import { ArrowRight, CaretDown, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { useShipments } from "../../api/queries";
import { useRoutes } from "../../api/useShipmentRoutes";
import type { ShipmentSummary } from "../../api/contract";
import { CrossFade, EmptyState, ErrorNote, Loading, RiskBadge, Skeleton, StatusTag } from "../../components/ui";
import { JourneyBar } from "../../components/ShipmentParts";
import { clock, clockTz, dateTimeTz, duration as fmtDuration } from "../../lib/time";
import { useSession } from "../../auth/session";

/*
  Customer: my deliveries (DESIGN.md 7.4). Orders still to arrive come first, as cards with the time,
  the window and the reason. Delivered orders have no estimate to show, so they sit in a closed "Past deliveries" list with
  when they arrived and whether that was on time.
*/
const DONE = new Set(["DELIVERED", "CANCELLED"]);

/** Minutes late against the original promise; 0 or less is on time. null when the arrival time is unknown. */
export function lateMinutes(s: Pick<ShipmentSummary, "arrived_at" | "original_promised_by">): number | null {
  if (!s.arrived_at || !s.original_promised_by) return null;
  return Math.round((Date.parse(s.arrived_at) - Date.parse(s.original_promised_by)) / 60_000);
}

export function MyDeliveries() {
  const session = useSession();
  const shipments = useShipments();
  const all = (shipments.data ?? []).filter((s) => s.status !== "CANCELLED");
  const open = all
    .filter((s) => !DONE.has(s.status))
    .sort((a, b) => (a.current_eta?.eta ?? "~").localeCompare(b.current_eta?.eta ?? "~"));
  // Most recent first.
  const delivered = all.filter((s) => s.status === "DELIVERED").sort((a, b) => (b.arrived_at ?? "").localeCompare(a.arrived_at ?? ""));
  const routes = useRoutes(open.map((s) => s.active_route_id));
  const company = all[0]?.customer_name;
  const moving = open.filter((s) => s.status === "IN_TRANSIT" || s.status === "ARRIVED").length;

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-8 sm:px-6 lg:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-figure font-[750] tracking-[-0.025em]">Your deliveries</h1>
          <p className="mt-1 text-body text-muted">
            {session?.user.name}
            {company ? `, ${company}` : ""}. Times are IST.
          </p>
        </div>
        <Link to="/customer/orders/new" className="btn-primary ct-go inline-flex h-11 items-center gap-2 rounded-md border border-accent bg-accent px-5 text-body font-semibold text-on-accent hover:bg-accent-hover">
          New order <ArrowRight size={16} weight="bold" aria-hidden />
        </Link>
      </div>

      {shipments.error && (
        <div className="mt-5">
          <ErrorNote what="your deliveries" error={shipments.error} onRetry={() => shipments.refetch()} loadedAt={shipments.data ? shipments.dataUpdatedAt : undefined} />
        </div>
      )}

      {shipments.isPending ? (
        <Loading label="Loading your deliveries">
          <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-60 rounded-lg" />
            ))}
          </div>
        </Loading>
      ) : !all.length && !shipments.error ? (
        <div className="mt-8 rounded-lg border border-line bg-surface">
          <EmptyState title="No deliveries yet.">New orders appear here as soon as Plant X plans them.</EmptyState>
        </div>
      ) : (
        <>
          <section aria-labelledby="open-h" className="mt-8">
            <h2 id="open-h" className="text-lead font-semibold">
              Coming to you{" "}
              <span className="font-normal text-muted">
                {open.length} {open.length === 1 ? "order" : "orders"}
                {moving ? `, ${moving} on the road` : ""}
              </span>
            </h2>
            {open.length ? (
              <ul className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
                {open.map((s) => (
                  <li key={s.id}>
                    <DeliveryCard s={s} route={routes[s.active_route_id]} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-body text-muted">Nothing on the way right now.</p>
            )}
          </section>

          {delivered.length > 0 && <PastDeliveries past={delivered} />}
        </>
      )}
    </div>
  );
}

function DeliveryCard({ s, route }: { s: ShipmentSummary; route: ReturnType<typeof useRoutes>[string] }) {
  const eta = s.current_eta;
  return (
    <Link to={`/customer/shipments/${s.id}`} className="flex h-full flex-col rounded-lg border border-line bg-surface p-5 transition-colors duration-150 hover:border-ink sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-meta text-muted">Order {s.order_id}{s.extra_order_ids?.length ? ` + ${s.extra_order_ids.join(", ")}` : ""}</p>
          <p className="mt-0.5 truncate text-body font-medium text-ink">{s.destination_name}</p>
        </div>
        {eta && <RiskBadge level={eta.risk_level} />}
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <div>
          <p className="text-meta text-muted">Expected{s.status === "IN_TRANSIT" && eta ? `, ${Math.round(eta.remaining_km)} km away` : ""}</p>
          <p className="tnum leading-none">
            <CrossFade value={eta?.eta ?? ""}>{(v) => <span className="wide text-[2.25rem] font-[800] tracking-[-0.03em]">{v ? clock(v) : "Not yet"}</span>}</CrossFade>
          </p>
        </div>
        {eta && <p className="tnum pb-1 text-meta text-ink-2">between {clock(eta.eta_window.earliest)} and {clockTz(eta.eta_window.latest)}</p>}
      </div>

      <div className="mb-5 mt-5">
        <JourneyBar from={route?.origin ?? "Plant X"} to={s.destination_name} progressKm={s.last_position?.progress_km ?? null} totalKm={route?.total_km ?? null} status={s.status} />
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-line pt-4">
        <p className="min-w-0 text-body text-ink">{!eta ? "The arrival time appears once the truck is planned." : eta.headline === "On schedule" ? "No delays reported." : eta.headline}</p>
        <StatusTag status={s.status} />
      </div>
    </Link>
  );
}

function PastDeliveries({ past }: { past: ShipmentSummary[] }) {
  const onTime = past.filter((s) => (lateMinutes(s) ?? 0) <= 0).length;
  return (
    <details className="group mt-10 border-t-2 border-ink">
      <summary className="flex cursor-pointer list-none items-baseline justify-between gap-3 py-4 [&::-webkit-details-marker]:hidden">
        <span className="text-lead font-semibold text-ink">
          Past deliveries{" "}
          <span className="tnum font-normal text-muted">
            {past.length} delivered, {onTime} on time
          </span>
        </span>
        <CaretDown size={16} weight="bold" aria-hidden className="shrink-0 self-center text-ink-2 transition-transform duration-200 group-open:rotate-180" />
      </summary>
      <ul className="divide-y divide-line border-y border-line">
        {past.map((s) => {
          const late = lateMinutes(s);
          return (
            <li key={s.id}>
              <Link to={`/customer/shipments/${s.id}`} className="ct-go flex flex-wrap items-center gap-x-4 gap-y-1 px-2 py-3 transition-colors duration-150 hover:bg-raised">
                <span className="shrink-0 text-body font-semibold text-ink sm:w-28">{s.order_id}</span>
                <span className="tnum order-last basis-full text-meta text-ink-2 sm:order-none sm:min-w-0 sm:flex-1 sm:basis-auto sm:text-body">{s.arrived_at ? `Delivered ${dateTimeTz(s.arrived_at)}` : "Delivered"}</span>
                <span className="ml-auto flex items-center gap-3">
                {late !== null &&
                  (late <= 0 ? (
                    <span className="inline-flex items-center gap-1 text-meta font-semibold text-low">
                      <CheckCircle size={16} weight="bold" aria-hidden /> On time
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-meta font-semibold text-medium">
                      <WarningCircle size={16} weight="bold" aria-hidden /> {fmtDuration(late)} late
                    </span>
                  ))}
                <ArrowRight size={14} weight="bold" aria-hidden className="shrink-0 text-muted" />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
