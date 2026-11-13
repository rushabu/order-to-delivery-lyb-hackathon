// Notifier (DESIGN.md 8). One method, send(). The in-app version writes a row, an audit event and a
// stream hint. Email or SMS would be another implementation of the same interface.
import { audit } from '../audit';
import { nextSeq, type Db } from '../db/db';
import type { PendingHint } from '../stream/hub';

export type NotificationKind =
  | 'RISK_MEDIUM'
  | 'RISK_HIGH'
  | 'DECISION_APPLIED'
  | 'BACK_ON_SCHEDULE'
  | 'TRACKING_LOST'
  | 'DELIVERED'
  | 'DELIVERY_PHOTO'
  | 'DELIVERY_VERIFIED'
  | 'CHECKIN_REQUEST'
  | 'CHECKIN_REPLY'
  | 'DRIVER_STOP'
  | 'INVOICE_READY'
  | 'ORDER_CONFIRMED'
  | 'NEW_TRIP'
  | 'ORDER_PLACED';

export interface NewNotification {
  user_id: string;
  shipment_id: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
}

export interface Notifier {
  /** Must be called inside the caller's transaction. Returns the notification id. */
  send(db: Db, at: string, n: NewNotification, hints: PendingHint[]): string;
}

export class InAppNotifier implements Notifier {
  send(db: Db, at: string, n: NewNotification, hints: PendingHint[]): string {
    const seq = nextSeq(db, 'NTF');
    const id = `NTF-${String(seq).padStart(6, '0')}`;
    db.prepare(
      'INSERT INTO notifications (id, seq, user_id, shipment_id, kind, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, seq, n.user_id, n.shipment_id, n.kind, n.title, n.body, at);
    audit(db, at, null, 'NOTIFICATION_SENT', 'notification', id, { recipient: n.user_id, kind: n.kind });
    hints.push({ hint: { entity: 'notification', id, kinds: [n.kind] }, audience: { kind: 'user', user_id: n.user_id } });
    return id;
  }
}

/** Recipient lists from DESIGN.md 8. */
export function coordinatorIds(db: Db): string[] {
  return (db.prepare(`SELECT id FROM users WHERE role = 'COORDINATOR' ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
}

export function customerUserIds(db: Db, customerId: string): string[] {
  return (
    db.prepare(`SELECT id FROM users WHERE role = 'CUSTOMER' AND customer_id = ? ORDER BY id`).all(customerId) as { id: string }[]
  ).map((r) => r.id);
}
