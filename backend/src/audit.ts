// Audit log (DESIGN.md 9.4). Call inside the same transaction as the action it records.
import type { Db } from './db/db';

export type AuditAction =
  | 'LOGIN_SUCCEEDED'
  | 'DEMO_LOGIN'
  | 'LOGIN_FAILED'
  | 'EVENT_APPLIED'
  | 'EVENT_REJECTED'
  | 'EVENT_DUPLICATE'
  | 'ETA_RECALCULATED'
  | 'ALERT_OPENED'
  | 'ALERT_ESCALATED'
  | 'ALERT_RESOLVED'
  | 'OPTIONS_GENERATED'
  | 'DECISION_APPROVED'
  | 'NOTIFICATION_SENT'
  | 'ACCESS_DENIED'
  | 'DEMO_RESET'
  | 'DRIVER_CHECK_PASSED'
  | 'DOCUMENT_UPLOADED'
  | 'DOCUMENT_VERIFIED'
  | 'CHECKIN_REQUESTED'
  | 'CHECKIN_ANSWERED'
  | 'STOP_STARTED'
  | 'STOP_ENDED'
  | 'ASSISTANT_ASKED'
  | 'INVOICE_UPLOADED'
  | 'INVOICE_GENERATED'
  | 'INVOICE_DOWNLOADED'
  | 'ORDER_CREATED';

export function audit(
  db: Db,
  at: string,
  actorUserId: string | null,
  action: AuditAction,
  entity: string,
  entityId: string | null,
  detail: Record<string, unknown>,
): void {
  db.prepare(
    'INSERT INTO audit_events (at, actor_user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(at, actorUserId, action, entity, entityId, JSON.stringify(detail));
}
