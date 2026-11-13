// Alert rules (DESIGN.md 6.4, 6.5 and 8). Runs after every new snapshot, inside the same transaction.
import { audit } from '../audit';
import { nextId, type Db } from '../db/db';
import type { Ctx } from '../ctx';
import type { EtaResult } from '../eta/types';
import { coordinatorIds, customerUserIds } from '../notify/notifier';
import type { ShipmentRow, SnapshotRow } from '../shipments/repo';
import type { PendingHint } from '../stream/hub';
import { istClock, minutesBetween } from '../time';

const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

export interface AlertRow {
  id: string;
  shipment_id: string;
  level: 'MEDIUM' | 'HIGH';
  status: 'OPEN' | 'DECIDED' | 'RESOLVED';
  title: string;
  opened_at: string;
  first_snapshot_id: string;
  customer_notified: number;
  low_since: string | null;
  resolved_at: string | null;
}

export function openAlert(db: Db, shipmentId: string): AlertRow | undefined {
  return db.prepare(`SELECT * FROM alerts WHERE shipment_id = ? AND status = 'OPEN'`).get(shipmentId) as AlertRow | undefined;
}

export function alertToApi(a: AlertRow) {
  return {
    id: a.id,
    shipment_id: a.shipment_id,
    level: a.level,
    status: a.status,
    title: a.title,
    opened_at: a.opened_at,
    first_snapshot_id: a.first_snapshot_id,
    resolved_at: a.resolved_at,
  };
}

/** Returns the stream "kinds" this evaluation produced (for example ["alert"]). */
export function evaluateAlerts(
  ctx: Ctx,
  s: ShipmentRow,
  prev: SnapshotRow | undefined,
  res: EtaResult,
  snapshotId: string,
  now: string,
  hints: PendingHint[],
): string[] {
  const { db } = ctx;
  const kinds: string[] = [];
  const prevLevel = prev?.risk_level ?? 'LOW';
  const lostAfter = ctx.fixtures.config.eta.tracking_lost_after_min;
  const prevLost = prev !== undefined && prev.position_age_min !== null && prev.position_age_min > lostAfter && s.status === 'IN_TRANSIT';
  const newlyLost = res.tracking_lost && !prevLost;
  const order = s.order_id;
  let open = openAlert(db, s.id);
  const send = (userIds: string[], kind: Parameters<Ctx['notifier']['send']>[2]['kind'], title: string, body: string) => {
    for (const u of userIds) ctx.notifier.send(db, now, { user_id: u, shipment_id: s.id, kind, title, body }, hints);
  };
  const riskHigh = () => {
    send(
      [...coordinatorIds(db), ...customerUserIds(db, s.customer_id)],
      'RISK_HIGH',
      `${order} may arrive late`,
      `${order} may arrive late. Current estimate ${istClock(res.eta)}. Reason: ${res.headline}. Plant X is reviewing options.`,
    );
  };

  if (RANK[res.risk_level] > RANK[prevLevel]) {
    if (!open) {
      const id = nextId(db, 'ALT', 4);
      const level = res.risk_level as 'MEDIUM' | 'HIGH';
      const title = res.tracking_lost ? 'Tracking lost' : res.headline;
      db.prepare(
        `INSERT INTO alerts (id, shipment_id, level, status, title, opened_at, first_snapshot_id, customer_notified)
         VALUES (?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
      ).run(id, s.id, level, title, now, snapshotId, level === 'HIGH' ? 1 : 0);
      audit(db, now, null, 'ALERT_OPENED', 'alert', id, { shipment_id: s.id, level });
      if (level === 'HIGH') riskHigh();
      else if (!res.tracking_lost) {
        send(coordinatorIds(db), 'RISK_MEDIUM', `${s.id} at risk`, `${s.id}: ${res.headline}`);
      }
      kinds.push('alert');
      open = openAlert(db, s.id);
    } else if (res.risk_level === 'HIGH' && open.level === 'MEDIUM') {
      db.prepare(`UPDATE alerts SET level = 'HIGH', customer_notified = 1 WHERE id = ?`).run(open.id);
      audit(db, now, null, 'ALERT_ESCALATED', 'alert', open.id, { shipment_id: s.id, level: 'HIGH' });
      riskHigh();
      kinds.push('alert');
    }
  }

  if (newlyLost) {
    send(coordinatorIds(db), 'TRACKING_LOST', `Tracking lost: ${s.id}`, `No position from ${s.id} for ${res.position_age_min} min.`);
    kinds.push('alert');
  }

  // An open alert that stays LOW for long enough without a decision resolves itself.
  if (open) {
    if (res.risk_level === 'LOW') {
      const lowSince = open.low_since ?? now;
      if (minutesBetween(lowSince, now) >= ctx.fixtures.config.alerts.resolve_after_low_min) {
        db.prepare(`UPDATE alerts SET status = 'RESOLVED', resolved_at = ?, low_since = ? WHERE id = ?`).run(now, lowSince, open.id);
        audit(db, now, null, 'ALERT_RESOLVED', 'alert', open.id, { shipment_id: s.id, level: open.level });
        if (open.customer_notified) {
          send(
            customerUserIds(db, s.customer_id),
            'BACK_ON_SCHEDULE',
            `${order} is back on schedule`,
            `${order} is back on schedule. Estimate ${istClock(res.eta)}.`,
          );
        }
        kinds.push('alert');
      } else if (open.low_since === null) {
        db.prepare('UPDATE alerts SET low_since = ? WHERE id = ?').run(now, open.id);
      }
    } else if (open.low_since !== null) {
      db.prepare('UPDATE alerts SET low_since = NULL WHERE id = ?').run(open.id);
    }
  }
  return kinds;
}
