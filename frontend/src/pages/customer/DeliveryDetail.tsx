import { Link, useParams } from "react-router";
import { ArrowLeft, ShieldCheck } from "@phosphor-icons/react";
import { useEtaHistory, useNotifications, useShipment } from "../../api/queries";
import { useRoutes } from "../../api/useShipmentRoutes";
import { ApiError } from "../../api/client";
import { Card, CardHeader, EmptyState, ErrorNote, KeyValue, Loading, Skeleton, StatusTag } from "../../components/ui";
import { EtaPanel } from "../../components/EtaPanel";
import { ShipmentRoadMap } from "../../components/ShipmentRoadMap";
import { LiveTrafficPanel } from "../../components/LiveTrafficPanel";
import { InvoiceCard } from "../../components/InvoiceCard";
import { ExtraOrders, JourneyBar, MilestoneTimeline, positionText, shipmentLayers } from "../../components/ShipmentParts";
import { clock, clockTz, dateTimeTz } from "../../lib/time";
import type { ShipmentDetail } from "../../api/contract";
import { useDocuments } from "../../api/ops";
import { openDocument } from "../../components/ShipmentOps";
import { fmtDur, useDocumentUrl } from "../driver/TripTools";

/*
  Customer delivery detail (DESIGN.md 7.4): map, milestones, "Why this ETA" in plain words and the
  notification history. Shows the transporter and vehicle, never the driver's personal details.
*/
export function DeliveryDetail() {
  const { id } = useParams();
  const shipment = useShipment(id);
  const history = useEtaHistory(id);
  const notes = useNotifications();
  const s = shipment.data;
  const routes = useRoutes([s?.active_route_id, s?.planned_route_id]);

  if (shipment.isPending) {
    return (
      <Loading label="Loading delivery">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-8 sm:px-6">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-72 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      </Loading>
    );
  }
  if (!s) {
    const notFound = shipment.error instanceof ApiError && shipment.error.status === 404;
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        {notFound ? (
          <EmptyState title="We could not find that delivery.">
            <Link to="/customer" className="link">
              Back to my deliveries
            </Link>
          </EmptyState>
        ) : (
          <ErrorNote what="this delivery" error={shipment.error} onRetry={() => shipment.refetch()} />
        )}
      </div>
    );
  }

  const layers = shipmentLayers(s, routes, { drawInActive: false });
  const eta = s.current_eta;
  const hist = history.data ?? [];
  const previous = eta && hist[0]?.id === eta.id ? hist[1] : hist[0];
  const myNotes = (notes.data ?? []).filter((n) => n.shipment_id === s.id);

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-8 sm:px-6 lg:py-10">
      <div>
        <Link to="/customer" className="inline-flex items-center gap-1.5 rounded-sm text-meta font-medium text-ink-2 hover:text-ink">
          <ArrowLeft size={14} weight="bold" aria-hidden /> My deliveries
        </Link>
        <h1 className="mt-2 text-figure font-semibold tracking-[-0.02em]">Order {s.order.id}</h1>
        <p className="text-body text-ink-2">
          {s.order.quantity_t} t {s.order.product.toLowerCase()} to {s.destination_name}
        </p>
      </div>

      {shipment.error && <ErrorNote what="the latest update" error={shipment.error} onRetry={() => shipment.refetch()} loadedAt={shipment.dataUpdatedAt} />}

      <ArrivalStrip s={s} />
      <Paperwork s={s} />

      <Card aria-labelledby="why-h">
        <CardHeader title="Why this ETA" id="why-h" />
        <div className="p-5">{eta ? <EtaPanel snapshot={eta} previous={previous} audience="customer" /> : <EmptyState title="No estimate yet." />}</div>
      </Card>

      <Card aria-labelledby="where-h">
        <CardHeader title="Where it is" id="where-h">
          <StatusTag status={s.status} />
        </CardHeader>
        <div className="p-4">
          <div className="mb-4 px-1">
            <JourneyBar from={routes[s.planned_route_id]?.origin ?? "Plant X"} to={s.destination_name} progressKm={s.last_position?.progress_km ?? null} totalKm={routes[s.active_route_id]?.total_km ?? null} status={s.status} />
          </div>
          <p className="mb-2 text-body font-semibold">{routes[s.active_route_id]?.name ?? s.active_route_id}</p>
          <ShipmentRoadMap
            shipment={s}
            label={`Map of order ${s.order.id}. ${positionText(s, routes[s.active_route_id])}`}
            routes={layers.routes}
            markers={layers.marker ? [{ ...layers.marker, label: `Order ${s.order.id}`, emphasis: true }] : []}
            traffic={s.live_traffic}
            focusRouteIds={[s.planned_route_id, s.active_route_id]}
            className="h-[320px]"
          />
          <p className="tnum mt-3 text-body text-ink-2">
            <span className="font-medium text-ink">Position:</span> {positionText(s, routes[s.active_route_id])}
          </p>
          {s.live_traffic && <div className="mt-3"><LiveTrafficPanel traffic={s.live_traffic} /></div>}
          <div className="mt-5 overflow-x-auto">
            <div className="min-w-[480px]">
              <MilestoneTimeline milestones={s.milestones} />
            </div>
          </div>
        </div>
      </Card>

      <Card aria-labelledby="facts-h">
        <CardHeader title="Delivery details" id="facts-h" />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-5">
          <KeyValue label="Transporter">{s.transporter_name}</KeyValue>
          <KeyValue label="Vehicle">{s.vehicle_reg}</KeyValue>
          <KeyValue label="Original promise">{clockTz(s.order.original_promised_by)}</KeyValue>
          <KeyValue label="Agreed delivery">{clockTz(s.order.agreed_delivery_by)}</KeyValue>
        </dl>
        <ExtraOrders shipment={s} />
      </Card>

      <InvoiceCard shipment={s} />

      <Card aria-labelledby="notes-h">
        <CardHeader title="Updates we sent you" id="notes-h" />
        {!myNotes.length ? (
          <p className="px-5 py-6 text-body text-muted">No updates yet. We will tell you here if anything changes.</p>
        ) : (
          <ol className="divide-y divide-line">
            {myNotes.map((n) => (
              <li key={n.id} className="px-5 py-4">
                <p className="text-body font-semibold">{n.title}</p>
                <p className="text-body text-ink-2">{n.body}</p>
                <p className="tnum mt-1 text-meta text-muted">{dateTimeTz(n.created_at)}</p>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}

/**
  The one line a customer wants first: how far away, how long, early or late, and why.
  Minutes come from the ETA snapshot (eta minus the time it was computed), never from the browser clock.
*/
function ArrivalStrip({ s }: { s: ShipmentDetail }) {
  const eta = s.current_eta;
  const at = (st: string) => s.milestones.find((m) => m.status === st)?.at ?? null;
  let big: string;
  let small: string;
  if (s.status === "DELIVERED") {
    big = "Delivered";
    small = at("DELIVERED") ? `at ${clockTz(at("DELIVERED")!)}` : "";
  } else if (s.status === "ARRIVED") {
    big = "At your gate";
    small = at("ARRIVED") ? `arrived ${clockTz(at("ARRIVED")!)}, unloading next` : "unloading next";
  } else if (s.status === "IN_TRANSIT" && eta) {
    const mins = Math.max(0, Math.round((Date.parse(eta.eta) - Date.parse(eta.computed_at)) / 60_000));
    big = `${fmtDur(mins)} away`;
    small = `${Math.round(eta.remaining_km)} km to go, arriving about ${clockTz(eta.eta)}`;
  } else {
    big = "Not left yet";
    small = `leaves Plant X at ${clockTz(s.planned_departure)}`;
  }
  const slack = eta && s.status !== "DELIVERED" ? eta.slack_min : null;
  const timing = slack === null ? null : slack < 0 ? { t: `${-slack} min later than promised`, c: "text-[#ff9b92]" } : slack <= 5 ? { t: "On time", c: "text-[#7fd3b7]" } : { t: `${slack} min early`, c: "text-[#7fd3b7]" };
  const reason = eta && eta.headline !== "On schedule" && s.status !== "DELIVERED" ? eta.headline : null;
  return (
    <section aria-label="Arrival" className="overflow-hidden rounded-lg bg-road text-rail-ink">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 px-5 pb-4 pt-5 sm:px-6">
        <div>
          <p className="wide text-[clamp(2rem,6vw,2.75rem)] font-[800] leading-none tracking-[-0.03em] text-[#f4f6f9]">{big}</p>
          {small && <p className="tnum mt-2 text-body text-rail-ink">{small}</p>}
        </div>
        {timing && <p className={`text-lead font-semibold ${timing.c}`}>{timing.t}</p>}
      </div>
      {reason && <p className="border-t border-rail-2 px-5 py-3 text-body text-rail-ink sm:px-6">Why: {reason.replace(/^(Expected \d+ min late|At risk): /, "")}</p>}
      {/* Lane markings under the strip, with the progress painted in marker yellow */}
      <div aria-hidden className="relative h-2 bg-rail-2">
        <span className="absolute inset-y-0 left-0 bg-accent transition-[width] duration-700" style={{ width: `${progressPct(s)}%` }} />
      </div>
    </section>
  );
}

function progressPct(s: ShipmentDetail) {
  if (s.status === "DELIVERED" || s.status === "ARRIVED") return 100;
  const eta = s.current_eta;
  const done = s.last_position?.progress_km;
  if (!eta || done === undefined || done === null) return 0;
  const total = done + eta.remaining_km;
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

/** Delivery photo, once the driver has sent it. Hidden until then. The invoice is InvoiceCard. */
function Paperwork({ s }: { s: ShipmentDetail }) {
  const docs = useDocuments(s.id);
  const photo = docs.data?.find((d) => d.kind === "DELIVERY_PHOTO");
  const thumb = useDocumentUrl(photo?.id);
  if (!photo) return null;
  return (
    <Card aria-labelledby="paper-h">
      <CardHeader title="Delivery photo" id="paper-h" />
      <div className="grid grid-cols-1 items-end gap-4 p-5 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {thumb ? (
          <button type="button" onClick={() => void openDocument(photo)} className="block w-full overflow-hidden rounded-md border border-line" aria-label="Open the delivery photo full size">
            <img src={thumb} alt={`Delivery photo for order ${s.order.id}`} className="max-h-56 w-full object-cover transition-transform duration-300 hover:scale-[1.02]" />
          </button>
        ) : (
          <div className="h-40 rounded-md bg-sunken" aria-hidden />
        )}
        <div>
          <p className="tnum text-meta text-muted">Taken at delivery, {clock(photo.uploaded_at)}</p>
          <p className={`mt-1 flex items-center gap-1.5 text-body ${photo.verified_at ? "text-low" : "text-ink-2"}`}>
            {photo.verified_at ? <><ShieldCheck size={16} weight="fill" aria-hidden /> Confirmed by Plant X</> : "Plant X is checking it."}
          </p>
        </div>
      </div>
    </Card>
  );
}
