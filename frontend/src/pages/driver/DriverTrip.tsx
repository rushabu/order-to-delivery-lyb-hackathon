import { useRef } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";
import { ArrowsSplit, CloudSlash, Warning, CheckCircle, X } from "@phosphor-icons/react";
import { useMarkRead, useNotifications } from "../../api/queries";
import { useRoutes } from "../../api/useShipmentRoutes";
import type { ShipmentDetail, ShipmentStatus, ShipmentSummary } from "../../api/contract";
import { Button, CrossFade, EmptyState, ErrorNote, Loading, RiskBadge, Skeleton, StatusTag, ConfidenceTag } from "../../components/ui";
import { JourneyBar, positionText } from "../../components/ShipmentParts";
import { clock, clockTz } from "../../lib/time";
import { DEMO_MODE } from "../../lib/env";
import { duration, easeOut } from "../../lib/motion";
import { useCurrentTrip, useDriverOutbox } from "./useCurrentTrip";
import { useDriverChecks } from "../../api/ops";
import { ShiftChecks } from "./ShiftChecks";
import { CheckinBanner, DeliveryPhoto, DrivingPanel, useHasDeliveryPhoto } from "./TripTools";
import { NewTripBanner, RouteAndAlerts, SafetyList, TripSwitcher } from "./TripBrief";

/*
  Driver trip screen (DESIGN.md 7.3): one column, one decision at a time, targets at least 44 px.
  The button offers the next stage the driver may set. Which stage that is follows the state machine
  in DESIGN.md 5.3; whether it is allowed is decided by the API.
*/
const NEXT: Partial<Record<ShipmentStatus, { to: ShipmentStatus; label: string }>> = {
  DISPATCHED: { to: "IN_TRANSIT", label: "Start trip" },
  IN_TRANSIT: { to: "ARRIVED", label: "Arrived" },
  ARRIVED: { to: "DELIVERED", label: "Delivered" },
};

export function DriverTrip() {
  const { list, detail } = useCurrentTrip();
  const checks = useDriverChecks();
  const s = detail.data;

  // Start-of-shift checks come first. If the check service cannot be reached the trip still shows,
  // so a network problem never locks a driver out of reporting.
  if (checks.isPending) return <TripSkeleton />;
  if (checks.data && !checks.data.complete) return <ShiftChecks />;

  if (list.isPending || (list.data?.length && detail.isPending)) return <TripSkeleton />;
  if (list.error && !list.data) {
    return (
      <Column>
        <ErrorNote what="your trip" error={list.error} onRetry={() => list.refetch()} />
      </Column>
    );
  }
  if (!s) {
    return (
      <Column>
        <NewTripBanner />
        <EmptyState title="No trip assigned." >Your next trip will appear here when Plant X dispatches it.</EmptyState>
      </Column>
    );
  }
  return <Trip s={s} trips={list.data ?? []} error={detail.error} onRetry={() => detail.refetch()} loadedAt={detail.dataUpdatedAt} />;
}

function Trip({ s, trips, error, onRetry, loadedAt }: { s: ShipmentDetail; trips: ShipmentSummary[]; error: unknown; onRetry: () => void; loadedAt: number }) {
  const { outbox, items, rejections } = useDriverOutbox();
  const routes = useRoutes([s.active_route_id, s.planned_route_id]);
  const eta = s.current_eta;
  const next = NEXT[s.status];
  const pendingMilestone = items.find((i) => i.shipment_id === s.id && i.event.type === "MILESTONE");
  const pendingReport = items.find((i) => i.shipment_id === s.id && i.event.type === "DISRUPTION_REPORTED");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const hasPhoto = useHasDeliveryPhoto(s.id);
  const needsPhoto = s.status === "ARRIVED" && !hasPhoto;

  function advance() {
    if (!next) return;
    outbox.enqueue(s.id, "MILESTONE", { to_status: next.to }, next.label);
  }

  return (
    <Column>
      {!!error && <ErrorNote what="the latest trip update" error={error} onRetry={onRetry} loadedAt={loadedAt} />}
      <NewTripBanner />
      <RouteChangeBanner s={s} routes={routes} />
      <CheckinBanner s={s} />
      <TripSwitcher trips={trips} currentId={s.id} />

      <section aria-labelledby="trip-h">
        <h1 id="trip-h" className="sr-only">
          Current trip {s.id}
        </h1>
        <p className="text-meta font-medium text-muted">Deliver to</p>
        <p className="text-heading font-semibold leading-tight">{s.destination_name}</p>
        <p className="text-body text-ink-2">{s.customer_name}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted">
          <span>{s.id}</span>
          <span>{s.vehicle_reg}</span>
          <StatusTag status={s.status} />
        </div>

        <dl className="tnum mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-line bg-surface p-4">
            <dt className="text-meta text-muted">Promised by</dt>
            <dd className="text-driver font-semibold">{clock(s.order.agreed_delivery_by)}</dd>
            <dd className="text-meta text-muted">IST</dd>
          </div>
          <div className="rounded-lg border border-line bg-surface p-4">
            <dt className="text-meta text-muted">Current ETA</dt>
            <dd>
              <CrossFade value={eta?.eta ?? ""}>{(v) => <span className="block text-driver font-semibold">{v ? clock(v) : "—"}</span>}</CrossFade>
            </dd>
            <dd className="text-meta text-muted">IST</dd>
          </div>
        </dl>
        {eta && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <RiskBadge level={eta.risk_level} />
            <ConfidenceTag confidence={eta.confidence} />
          </div>
        )}
      </section>

      <DeliveryPhoto s={s} />

      <section aria-label="Next step" className="mt-2">
        {/* The next button replaces the old one at once (entry animation only), so a stale button is never tappable. */}
        {next ? (
            <motion.div key={s.status} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: duration.base, ease: easeOut }}>
              <Button ref={buttonRef} variant="primary" size="xl" className="min-h-20 text-driver" onClick={advance} disabled={!!pendingMilestone || needsPhoto}>
                {pendingMilestone ? (pendingMilestone.state === "retrying" ? "Not sent, retrying" : "Sending…") : next.label}
              </Button>
              {needsPhoto && <p className="mt-2 text-center text-meta text-muted">Take the delivery photo first.</p>}
            </motion.div>
          ) : (
            <motion.p key="none" className="rounded-lg border border-line bg-surface p-4 text-body text-ink-2" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              {s.status === "DELIVERED" ? "Delivered. Thank you." : s.status === "PLANNED" ? "Waiting for Plant X to dispatch this trip." : "No action needed now."}
            </motion.p>
          )}
      </section>

      <DrivingPanel s={s} />

      <OutboxStatus items={items.filter((i) => i.shipment_id === s.id)} onRetry={() => outbox.retryNow()} />
      {rejections.map((r) => (
        <div key={r.event_id} role="alert" className="flex items-start gap-3 rounded-lg border border-high/30 bg-high-soft p-4 text-body text-high">
          <Warning size={20} weight="bold" aria-hidden className="mt-0.5 shrink-0" />
          <p className="flex-1">
            <span className="font-semibold">{r.label} was not accepted.</span> {r.message}.
          </p>
          <button type="button" onClick={() => outbox.dismissRejection(r.event_id)} className="-m-2 inline-flex h-11 w-11 items-center justify-center rounded-md" aria-label="Dismiss">
            <X size={18} weight="bold" aria-hidden />
          </button>
        </div>
      ))}
      {pendingReport === undefined && <ReportSentNote s={s} />}

      {s.status === "IN_TRANSIT" || s.status === "DISPATCHED" || s.status === "PLANNED" ? (
        <Link
          to="/driver/report"
          className="flex min-h-14 w-full items-center justify-center gap-2 rounded-md border-2 border-ink bg-surface px-6 text-lead font-semibold text-ink hover:bg-sunken"
        >
          <Warning size={22} weight="bold" aria-hidden /> Report a problem
        </Link>
      ) : null}

      <RouteAndAlerts s={s} routes={routes} />
      {s.status !== "DELIVERED" && <SafetyList s={s} />}

      <section aria-labelledby="pos-h" className="rounded-lg border border-line bg-surface p-4">
        <h2 id="pos-h" className="text-meta font-medium text-muted">
          Position{DEMO_MODE || s.live_traffic ? ": simulated" : ""}
        </h2>
        <div className="mt-3">
          <JourneyBar from={routes[s.planned_route_id]?.origin ?? "Plant X"} to={s.destination_name} progressKm={s.last_position?.progress_km ?? null} totalKm={routes[s.active_route_id]?.total_km ?? null} status={s.status} />
        </div>
        <p className="tnum mt-3 text-body text-ink">{positionText(s, routes[s.active_route_id])}</p>
        {eta && <p className="mt-2 text-body text-ink-2">{eta.headline}</p>}
      </section>
    </Column>
  );
}

/** "New route approved" (DESIGN.md 7.3), shown while the trip is on an approved alternative route. */
function RouteChangeBanner({ s, routes }: { s: ShipmentDetail; routes: ReturnType<typeof useRoutes> }) {
  const notes = useNotifications();
  const markRead = useMarkRead();
  const instruction = notes.data?.find((n) => n.shipment_id === s.id && n.kind === "DECISION_APPLIED");
  const rerouted = s.active_route_id !== s.planned_route_id;
  const alt = routes[s.active_route_id];
  const exit = routes[s.planned_route_id]?.alternatives.find((a) => a.alt_route_id === s.active_route_id)?.exit_km;
  if (!rerouted && !instruction) return null;
  const unread = instruction && !instruction.read_at;
  return (
    <motion.div
      role="status"
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.base, ease: easeOut }}
      className={`rounded-lg border-2 p-4 ${unread ? "border-accent bg-accent-soft" : "border-line bg-surface"}`}
    >
      <div className="flex items-start gap-3">
        <ArrowsSplit size={28} weight="bold" aria-hidden className="mt-0.5 shrink-0 text-accent-ink" />
        <div className="min-w-0 flex-1">
          {rerouted ? (
            <p className="text-lead font-semibold text-ink">
              New route approved: via {alt?.name ?? s.active_route_id}.{exit !== undefined ? ` Take exit at km ${exit}.` : ""}
            </p>
          ) : (
            <p className="text-lead font-semibold text-ink">{instruction?.title}</p>
          )}
          {instruction && <p className="mt-1 text-body text-ink-2">{instruction.body}</p>}
          {instruction && <p className="tnum mt-1 text-meta text-muted">Approved {clockTz(instruction.created_at)}</p>}
        </div>
      </div>
      {unread && (
        <Button variant="primary" size="lg" className="mt-3 w-full" onClick={() => markRead.mutate(instruction!.id)}>
          <CheckCircle size={20} weight="bold" aria-hidden /> Got it
        </Button>
      )}
    </motion.div>
  );
}

function OutboxStatus({ items, onRetry }: { items: ReturnType<typeof useDriverOutbox>["items"]; onRetry: () => void }) {
  const retrying = items.filter((i) => i.state === "retrying");
  if (!retrying.length) return null;
  return (
    <div role="status" className="rounded-lg border border-medium/40 bg-medium-soft p-4 text-body text-medium">
      <div className="flex items-start gap-3">
        <CloudSlash size={22} weight="bold" aria-hidden className="mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="font-semibold">Not sent, retrying</p>
          <ul className="mt-1 text-ink-2">
            {retrying.map((i) => (
              <li key={i.event.event_id}>
                {i.label}: tried {i.attempts} {i.attempts === 1 ? "time" : "times"}, trying again automatically
              </li>
            ))}
          </ul>
          <p className="mt-1 text-meta text-ink-2">Your update is saved on this phone and will be sent when the network is back.</p>
        </div>
      </div>
      <Button size="lg" className="mt-3 w-full" onClick={onRetry}>
        Try again now
      </Button>
    </div>
  );
}

function ReportSentNote({ s }: { s: ShipmentDetail }) {
  const d = s.active_disruptions.find((x) => !x.cleared_at);
  if (!d) return null;
  return (
    <p className="tnum rounded-lg border border-line bg-surface p-4 text-body text-ink-2">
      <span className="font-semibold text-ink">Problem reported {clockTz(d.reported_at)}.</span> Plant X has it and is reviewing options.
    </p>
  );
}

export function Column({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-5">{children}</div>;
}

function TripSkeleton() {
  return (
    <Loading label="Loading your trip">
      <Column>
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-8 w-3/4" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-20" />
        <Skeleton className="h-14" />
      </Column>
    </Loading>
  );
}
