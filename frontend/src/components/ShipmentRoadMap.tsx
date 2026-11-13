import { useMemo, useState, type ComponentProps } from "react";
import type { RoadConditions, ShipmentDetail } from "../api/contract";
import { useRoadConditions } from "../api/queries";
import { clockTz } from "../lib/time";
import { FLOW_STYLE, ShipmentMap } from "./ShipmentMap";
import { Button, ErrorNote } from "./ui";

export function ShipmentRoadMap({ shipment, ...map }: { shipment: ShipmentDetail } & ComponentProps<typeof ShipmentMap>) {
  const [showConditions, setShowConditions] = useState(true);
  const available = Boolean(shipment.live_traffic) && shipment.status === "IN_TRANSIT";
  const enabled = available && showConditions;
  const query = useRoadConditions(shipment.id, shipment.active_route_id, enabled);
  const progress = shipment.last_position?.progress_km ?? 0;
  const data = useMemo(() => {
    const snapshot = query.data;
    if (!enabled || snapshot?.route_id !== shipment.active_route_id) return undefined;
    return { ...snapshot, flow: snapshot.flow.filter((segment) => segment.to_km >= progress),
      incidents: snapshot.incidents.filter((incident) => incident.at_km >= progress) };
  }, [enabled, progress, query.data, shipment.active_route_id]);

  return (
    <>
      {available && <div className="mb-3">
        <Button size="sm" aria-pressed={showConditions} onClick={() => setShowConditions((show) => !show)}>
          {showConditions ? "Hide traffic flow and incidents" : "Show traffic flow and incidents"}
        </Button>
      </div>}
      <ShipmentMap {...map} traffic={data?.flow.length ? undefined : map.traffic} roadConditions={data} />
      {enabled && <section aria-label="Traffic flow and incidents" className="mt-3 rounded-md border border-line bg-surface p-3 text-body">
        <h3 className="font-semibold text-ink">Traffic flow and incidents</h3>
        {query.isPending && <p className="mt-1 text-meta text-muted" role="status">Checking the road ahead…</p>}
        {query.error && <ErrorNote what="road conditions" error={query.error} onRetry={() => query.refetch()} />}
        {data && <RoadConditionsDetails data={data} progress={progress} />}
      </section>}
    </>
  );
}

function RoadConditionsDetails({ data, progress }: { data: RoadConditions; progress: number }) {
  return (
    <div className="mt-1 space-y-3">
      <p className="text-meta text-muted">TomTom · Checked {clockTz(data.fetched_at)} · Up to {data.horizon_km} km ahead</p>
      <div>
        <h4 className="text-meta font-semibold text-ink">Sampled traffic speeds</h4>
        {data.flow.length ? <ul className="mt-1 space-y-1">
          {data.flow.map((segment) => {
            const style = FLOW_STYLE[segment.condition];
            return <li key={`${segment.at_km}:${segment.to_km}`} className="flex items-center gap-2 text-meta text-ink-2">
              <span aria-hidden className="h-1 w-4 shrink-0 rounded-full" style={{ backgroundColor: `var(${style.tone})` }} />
              <span>{style.label} near km {segment.at_km.toFixed(1)} · {segment.current_kph} km/h now, {segment.free_flow_kph} km/h free-flow</span>
            </li>;
          })}
        </ul> : <p className="mt-1 text-meta text-muted">{data.flow_status === "UNAVAILABLE" ? "Traffic speeds unavailable." : "No matching speed samples returned."}</p>}
        {data.flow_status === "PARTIAL" && <p className="mt-1 text-meta text-muted">Some speed samples were unavailable.</p>}
      </div>
      <div>
        <h4 className="text-meta font-semibold text-ink">Reported incidents near the route</h4>
        {data.incidents.length ? <ul className="mt-1 space-y-2">
          {data.incidents.map((incident) => <li key={incident.id} className="rounded-sm border border-line px-2 py-1.5 text-meta text-ink-2">
            <p className="font-semibold text-ink">{incident.category} · {(incident.at_km - progress).toFixed(1)} km ahead{incident.roads.length > 0 && ` · ${incident.roads.join(", ")}`}</p>
            {incident.description && <p>{incident.description}</p>}
            {incident.delay_min !== null && incident.delay_min > 0 && <p>{incident.delay_min} min reported delay</p>}
          </li>)}
        </ul> : <p className="mt-1 text-meta text-muted">{data.incidents_status === "UNAVAILABLE" ? "Incident feed unavailable." : "No incidents reported near the route ahead."}</p>}
      </div>
    </div>
  );
}
