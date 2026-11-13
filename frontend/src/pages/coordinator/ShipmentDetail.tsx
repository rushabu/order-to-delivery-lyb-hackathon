import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { ArrowLeft } from "@phosphor-icons/react";
import { useEtaHistory, useShipment } from "../../api/queries";
import { useRoutes } from "../../api/useShipmentRoutes";
import { ApiError } from "../../api/client";
import { Card, CardHeader, EmptyState, ErrorNote, KeyValue, Loading, Skeleton, StatusTag, RiskBadge } from "../../components/ui";
import { EtaPanel } from "../../components/EtaPanel";
import { EtaHistory } from "../../components/EtaHistory";
import { ShipmentRoadMap } from "../../components/ShipmentRoadMap";
import { LiveTrafficPanel } from "../../components/LiveTrafficPanel";
import { WeatherPanel } from "../../components/WeatherPanel";
import { InvoiceCard } from "../../components/InvoiceCard";
import { ExtraOrders } from "../../components/ShipmentParts";
import { AlertBanner, MilestoneTimeline, positionText, shipmentLayers } from "../../components/ShipmentParts";
import { OptionsSection } from "../../components/OptionsSection";
import { DocumentsCard, DriverCard, TripLog } from "../../components/ShipmentOps";
import { clockTz } from "../../lib/time";

/* Coordinator shipment detail (DESIGN.md 7.2). */
export function ShipmentDetailPage() {
  const { id } = useParams();
  const shipment = useShipment(id);
  const history = useEtaHistory(id);
  const s = shipment.data;
  const routes = useRoutes([s?.active_route_id, s?.planned_route_id]);
  const optionsRef = useRef<HTMLDivElement>(null);
  const location = useLocation();

  // Arriving from "Review options" in the queue (#options): bring the options into view once loaded.
  const scrolled = useRef(false);
  useEffect(() => {
    if (s && location.hash === "#options" && !scrolled.current) {
      scrolled.current = true;
      requestAnimationFrame(() => optionsRef.current?.scrollIntoView({ block: "start" }));
    }
  }, [s, location.hash]);

  // Draw the new route in only when the reroute happens while this page is open.
  const firstRoute = useRef<string | null>(null);
  const [drawIn, setDrawIn] = useState(false);
  useEffect(() => {
    if (!s) return;
    if (firstRoute.current === null) firstRoute.current = s.active_route_id;
    else if (firstRoute.current !== s.active_route_id) setDrawIn(true);
  }, [s]);

  if (shipment.isPending) return <DetailSkeleton />;
  if (shipment.error && !s) {
    if (shipment.error instanceof ApiError && shipment.error.status === 404) {
      return (
        <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-6">
          <EmptyState title={`Shipment ${id} was not found.`}>
            <Link to="/coordinator" className="link">
              Back to the attention queue
            </Link>
          </EmptyState>
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-6">
        <ErrorNote what="this shipment" error={shipment.error} onRetry={() => shipment.refetch()} />
      </div>
    );
  }
  if (!s) return null;

  const layers = shipmentLayers(s, routes, { drawInActive: drawIn, showAlternatives: true });
  const eta = s.current_eta;
  const hist = history.data ?? [];
  const previous = eta && hist[0]?.id === eta.id ? hist[1] : hist[0];

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-6 sm:px-6">
      <div className="min-w-0">
        <Link to="/coordinator" className="inline-flex items-center gap-1.5 rounded-sm text-meta font-medium text-ink-2 hover:text-ink">
          <ArrowLeft size={14} weight="bold" aria-hidden /> Attention queue
        </Link>
        <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <h1 title={s.id} className="wide min-w-0 max-w-full truncate text-heading font-[800] tracking-[-0.03em] sm:text-figure">{s.id}</h1>
          {eta && <RiskBadge level={eta.risk_level} size="lg" />}
          <StatusTag status={s.status} />
        </div>
        <p className="mt-1 text-body text-ink-2">
          {s.order.id} for {s.customer_name}, to {s.destination_name}
        </p>
      </div>

      {shipment.error && <ErrorNote what="the latest update" error={shipment.error} onRetry={() => shipment.refetch()} loadedAt={shipment.dataUpdatedAt} />}

      {s.open_alert && eta && (
        <AlertBanner alert={s.open_alert} headline={eta.headline} onReview={() => optionsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })} />
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="min-w-0 space-y-5 lg:col-span-7 xl:col-span-8">
          <Card aria-labelledby="map-h">
            <CardHeader title="Route and position" id="map-h">
              <MapLegend rerouted={s.active_route_id !== s.planned_route_id} />
            </CardHeader>
            <div className="p-4">
              <ShipmentRoadMap
                shipment={s}
                label={`Map of ${s.id}. ${positionText(s, routes[s.active_route_id])}`}
                routes={layers.routes}
                markers={layers.marker ? [layers.marker] : []}
                traffic={s.live_traffic}
                focusRouteIds={[s.planned_route_id, s.active_route_id]}
              />
              <p className="tnum mt-3 text-body text-ink-2">
                <span className="font-medium text-ink">Position:</span> {positionText(s, routes[s.active_route_id])}
              </p>
              {s.live_traffic && <div className="mt-3"><LiveTrafficPanel traffic={s.live_traffic} refreshShipmentId={s.status === "IN_TRANSIT" ? s.id : undefined} /></div>}
            </div>
          </Card>

          <Card aria-labelledby="ms-h">
            <CardHeader title="Milestones" id="ms-h" />
            <div className="overflow-x-auto px-5 py-4">
              <div className="min-w-[520px]">
                <MilestoneTimeline milestones={s.milestones} />
              </div>
            </div>
          </Card>
          <TripLog s={s} />
        </div>

        <div className="min-w-0 space-y-5 lg:col-span-5 xl:col-span-4">
          <Card aria-labelledby="eta-h">
            <CardHeader title="ETA and why" id="eta-h" />
            <div className="p-5">{eta ? <EtaPanel snapshot={eta} previous={previous} headingId="eta-label" /> : <EmptyState title="No estimate yet." />}</div>
          </Card>
          <DriverCard s={s} />
          <DocumentsCard s={s} />
          <InvoiceCard shipment={s} canUpload />

          <Card aria-labelledby="facts-h">
            <CardHeader title="Shipment" id="facts-h" />
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 p-5">
              <KeyValue label="Customer">{s.customer_name}</KeyValue>
              <KeyValue label="Deliver to">{s.destination_name}</KeyValue>
              <KeyValue label="Product">{s.order.product}</KeyValue>
              <KeyValue label="Load">{s.quantity_t} t ({s.gross_t} t gross)</KeyValue>
              <KeyValue label="Transporter">{s.transporter_name}</KeyValue>
              <KeyValue label="Vehicle">{s.vehicle_reg}</KeyValue>
              <KeyValue label="Driver">{s.driver_name ?? "—"}</KeyValue>
              <KeyValue label="Planned departure">{clockTz(s.planned_departure)}</KeyValue>
              <KeyValue label="Original promise">{clockTz(s.order.original_promised_by)}</KeyValue>
              <KeyValue label="Agreed delivery">{clockTz(s.order.agreed_delivery_by)}</KeyValue>
            </dl>
            <ExtraOrders shipment={s} />
          </Card>
          {s.live_traffic && s.status === "IN_TRANSIT" && <WeatherPanel routeId={s.active_route_id} />}

        </div>
      </div>

      <div ref={optionsRef} className="scroll-mt-4">
        <OptionsSection shipment={s} />
      </div>

      <Card aria-labelledby="hist-h">
        <CardHeader title="ETA history" id="hist-h" />
        {history.isPending ? (
          <Loading label="Loading ETA history">
            <div className="space-y-2 p-5">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-6" />
              ))}
            </div>
          </Loading>
        ) : history.error && !history.data ? (
          <div className="p-5">
            <ErrorNote what="the ETA history" error={history.error} onRetry={() => history.refetch()} />
          </div>
        ) : (
          <EtaHistory snapshots={hist} />
        )}
      </Card>
    </div>
  );
}

function MapLegend({ rerouted }: { rerouted: boolean }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted" aria-label="Map legend">
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block h-1 w-5 rounded-full bg-accent-ink" /> Current route
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="inline-block w-5 border-t-2 border-dashed border-ink-2" /> {rerouted ? "Previous route" : "Alternative route"}
      </li>
    </ul>
  );
}

function DetailSkeleton() {
  return (
    <Loading label="Loading shipment">
      <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-6 sm:px-6">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-80" />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <Skeleton className="h-[480px] lg:col-span-7" />
          <Skeleton className="h-[480px] lg:col-span-5" />
        </div>
      </div>
    </Loading>
  );
}
