// Stale-position tick (DESIGN.md 5.6 and 6.5): every 5 minutes of clock time, any shipment in transit
// with no position for more than 10 minutes gets a new snapshot that holds the ETA and lowers confidence.
import type { Ctx } from '../ctx';
import type { PendingHint } from '../stream/hub';
import { minutesBetween } from '../time';
import { recomputeEta } from './recompute';
import { detectStops } from '../driverOps/routes';

export function staleTick(ctx: Ctx): number {
  const now = ctx.clock.nowIso();
  const limit = ctx.fixtures.config.eta.stale_after_min;
  const rows = ctx.db
    .prepare(`SELECT id, last_position_at FROM shipments WHERE status = 'IN_TRANSIT' AND last_position_at IS NOT NULL ORDER BY id`)
    .all() as { id: string; last_position_at: string }[];
  const hints: PendingHint[] = [];
  let n = 0;
  ctx.db.transaction(() => {
    for (const r of rows) {
      if (ctx.liveRouteDemo?.isLiveShipment(r.id)) continue;
      if (minutesBetween(r.last_position_at, now) > limit) {
        recomputeEta(ctx, r.id, now, null, 'TICK', hints);
        n++;
      }
    }
    detectStops(ctx, now, hints);
  })();
  ctx.hub.publish(hints);
  return n;
}
