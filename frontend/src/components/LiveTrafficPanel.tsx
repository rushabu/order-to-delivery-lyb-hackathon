import type { LiveTraffic } from "../api/contract";
import { useDemoCommand } from "../api/queries";
import { clockTz } from "../lib/time";
import { Button, ErrorNote } from "./ui";

export function LiveTrafficPanel({ traffic, refreshShipmentId }: { traffic: LiveTraffic; refreshShipmentId?: string }) {
  const refresh = useDemoCommand();
  const refreshTraffic = () => { if (refreshShipmentId) refresh.mutate({ path: `/shipments/${refreshShipmentId}/traffic/refresh` }); };
  const live = traffic.status === "LIVE";
  return (
    <div className="space-y-2 rounded-md border border-line bg-surface p-3 text-body text-ink-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-ink">{live ? "Live traffic from TomTom" : "Live traffic unavailable"}</p>
        {refreshShipmentId && <Button size="sm" disabled={refresh.isPending} onClick={refreshTraffic}>{refresh.isPending ? "Refreshing…" : "Refresh traffic"}</Button>}
      </div>
      <p className="text-meta">
        {live ? `${traffic.drive_minutes} min driving remaining, including ${traffic.traffic_delay_min} min traffic delay` : "ETA uses normal road speeds until TomTom answers"}
        {traffic.fetched_at && ` · ${live ? "Updated" : "Last response"} ${clockTz(traffic.fetched_at)}`}
      </p>
      {live && traffic.sections.length > 0 && <p className="text-meta">Highlighted road sections show reported traffic.</p>}
      {refresh.error && <ErrorNote what="live traffic" error={refresh.error} onRetry={refreshTraffic} />}
    </div>
  );
}
