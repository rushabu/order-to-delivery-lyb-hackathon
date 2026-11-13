// Driver operations: start-of-shift checks, stops (declared and detected), coordinator check-ins,
// driving time, delivery photo and invoice, and the trip log that puts all of it in one place.
// Every shipment read goes through getVisibleShipment, so out-of-scope ids answer 404.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit';
import type { AuthUser } from '../auth/policy';
import type { Ctx } from '../ctx';
import { nextSeq, type Db } from '../db/db';
import { ApiError, notFound } from '../http/errors';
import { defineRoute, type RegisteredRoute } from '../http/route';
import { ErrorResponse } from '../http/schemas';
import { coordinatorIds, customerUserIds, type NotificationKind } from '../notify/notifier';
import { getVisibleShipment, type ShipmentRow } from '../shipments/repo';
import type { PendingHint } from '../stream/hub';
import { istClock, minutesBetween } from '../time';

/** Fictional working rule, stated on screen: a 30-minute break after at most 5 hours of driving. */
export const DRIVE_LIMIT_MIN = 300;
export const BREAK_MIN = 30;
/** A start-of-shift check stays valid for 12 real hours. */
const CHECK_VALID_HOURS = 12;
/** Stop detection: less than 0.3 km in 10 minutes, away from a planned checkpoint. */
const STOP_WINDOW_MIN = 10;
const STOP_MOVE_KM = 0.3;
const CHECKPOINT_RADIUS_KM = 1;
/** Upload limit. Base64 adds a third, so the body limit in app.ts is set above this. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp'];

const IdParams = z.object({ id: z.string().min(1).max(60) });
const STOP_WORD: Record<string, string> = { BREAK: 'rest break', FUEL: 'fuel stop', CHARGING: 'charging stop', OTHER: 'stop', UNPLANNED: 'unplanned stop' };
const isoNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------- schemas

const ChecksResponse = z.object({ licence_at: z.string().nullable(), voice_at: z.string().nullable(), complete: z.boolean() });
const Stop = z.object({
  id: z.string(),
  kind: z.enum(['BREAK', 'FUEL', 'CHARGING', 'OTHER', 'UNPLANNED']),
  source: z.enum(['DRIVER', 'DETECTED']),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  at_km: z.number().nullable(),
});
type StopT = z.infer<typeof Stop>;
const Checkin = z.object({
  id: z.string(),
  shipment_id: z.string(),
  requested_by_name: z.string(),
  requested_at: z.string(),
  message: z.string().nullable(),
  responded_at: z.string().nullable(),
  response: z.enum(['OK', 'PROBLEM']).nullable(),
  response_note: z.string().nullable(),
});
const DocumentMeta = z.object({
  id: z.string(),
  shipment_id: z.string(),
  kind: z.literal('DELIVERY_PHOTO'),
  mime: z.string(),
  file_name: z.string(),
  size_bytes: z.number().int(),
  uploaded_by_name: z.string(),
  uploaded_at: z.string(),
  verified_by_name: z.string().nullable(),
  verified_at: z.string().nullable(),
});
const Driving = z.object({
  driving_min_since_break: z.number().int(),
  limit_min: z.number().int(),
  break_min: z.number().int(),
  break_due_at: z.string().nullable(),
  overdue: z.boolean(),
  on_stop: Stop.nullable(),
});
const Contact = z.object({ name: z.string(), phone: z.string().nullable() });
const LogEntry = z.object({
  at: z.string(),
  kind: z.enum(['MILESTONE', 'DISRUPTION', 'STOP', 'CHECKIN', 'DOCUMENT', 'ALERT', 'DECISION']),
  title: z.string(),
  detail: z.string().nullable(),
  by: z.string().nullable(),
});

// ---------------------------------------------------------------- helpers

const nameOf = (db: Db, id: string | null) =>
  id ? ((db.prepare('SELECT name FROM users WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? id) : null;

const newId = (db: Db, prefix: string) => `${prefix}-${String(nextSeq(db, prefix)).padStart(5, '0')}`;

function visible(ctx: Ctx, user: AuthUser, id: string): ShipmentRow {
  const s = getVisibleShipment(ctx.db, user, id);
  if (!s) throw notFound('Shipment not found');
  return s;
}

function shipmentHint(s: ShipmentRow, kind: string): PendingHint {
  return { hint: { entity: 'shipment', id: s.id, version: s.version, kinds: [kind] }, audience: { kind: 'shipment', customer_id: s.customer_id, driver_user_id: s.driver_user_id } };
}

function notifyAll(ctx: Ctx, ids: string[], at: string, s: ShipmentRow, kind: NotificationKind, title: string, body: string, hints: PendingHint[]) {
  for (const uid of ids) ctx.notifier.send(ctx.db, at, { user_id: uid, shipment_id: s.id, kind, title, body }, hints);
}

function stopsOf(db: Db, shipmentId: string): StopT[] {
  return db.prepare('SELECT id, kind, source, started_at, ended_at, at_km FROM stops WHERE shipment_id = ? ORDER BY started_at').all(shipmentId) as StopT[];
}

/** Minutes driven since the last break of at least BREAK_MIN, on the API clock. */
export function drivingStatus(db: Db, s: ShipmentRow, now: string): z.infer<typeof Driving> {
  const stops = stopsOf(db, s.id);
  const open = stops.find((x) => !x.ended_at) ?? null;
  const base = { limit_min: DRIVE_LIMIT_MIN, break_min: BREAK_MIN, on_stop: open };
  if (!s.departed_at || s.status !== 'IN_TRANSIT') return { ...base, driving_min_since_break: 0, break_due_at: null, overdue: false };
  const lastBreak = stops.filter((x) => x.kind === 'BREAK' && x.ended_at && minutesBetween(x.started_at, x.ended_at) >= BREAK_MIN).at(-1);
  const from = lastBreak?.ended_at && lastBreak.ended_at > s.departed_at ? lastBreak.ended_at : s.departed_at;
  // Time on any stop since then does not count as driving.
  let paused = 0;
  for (const x of stops) if (x.started_at >= from) paused += Math.max(0, minutesBetween(x.started_at, x.ended_at ?? now));
  const driving = Math.max(0, Math.round(minutesBetween(from, now) - paused));
  const dueAt = new Date(Date.parse(now) + (DRIVE_LIMIT_MIN - driving) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { ...base, driving_min_since_break: driving, break_due_at: open ? null : dueAt, overdue: driving > DRIVE_LIMIT_MIN };
}

/**
  Detects a truck that has stopped away from a planned checkpoint: positions over the last 10 minutes
  cover less than 0.3 km and no stop is open. Ends a detected stop once the truck moves again.
  Called from the stale tick, inside its transaction.
*/
export function detectStops(ctx: Ctx, now: string, hints: PendingHint[]): void {
  const { db } = ctx;
  const moving = db.prepare(`SELECT s.*, o.customer_id FROM shipments s JOIN orders o ON o.id = s.order_id WHERE s.status = 'IN_TRANSIT'`).all() as ShipmentRow[];
  const since = new Date(Date.parse(now) - STOP_WINDOW_MIN * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const s of moving) {
    const pts = db
      .prepare(`SELECT occurred_at, progress_km FROM shipment_events WHERE shipment_id = ? AND type = 'POSITION' AND apply_status = 'APPLIED' AND progress_km IS NOT NULL AND occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at`)
      .all(s.id, since, now) as { occurred_at: string; progress_km: number }[];
    const open = db.prepare('SELECT id, source, at_km FROM stops WHERE shipment_id = ? AND ended_at IS NULL').get(s.id) as { id: string; source: string; at_km: number | null } | undefined;
    if (open) {
      const last = pts.at(-1);
      if (open.source === 'DETECTED' && last && open.at_km !== null && last.progress_km - open.at_km > STOP_MOVE_KM) {
        db.prepare('UPDATE stops SET ended_at = ? WHERE id = ?').run(now, open.id);
        audit(db, now, null, 'STOP_ENDED', 'stop', open.id, { detected: true });
        hints.push(shipmentHint(s, 'stop'));
      }
      continue;
    }
    if (pts.length < 2 || minutesBetween(pts[0].occurred_at, pts.at(-1)!.occurred_at) < STOP_WINDOW_MIN - 2) continue;
    const km = pts.at(-1)!.progress_km;
    if (km - pts[0].progress_km >= STOP_MOVE_KM) continue;
    const checkpoint = db
      .prepare('SELECT 1 FROM route_segments WHERE route_id = ? AND dwell_after_min > 0 AND ABS(end_km - ?) <= ?')
      .get(s.active_route_id, km, CHECKPOINT_RADIUS_KM);
    if (checkpoint) continue;
    const id = newId(db, 'STP');
    db.prepare(`INSERT INTO stops (id, shipment_id, kind, source, started_at, at_km) VALUES (?, ?, 'UNPLANNED', 'DETECTED', ?, ?)`).run(id, s.id, pts[0].occurred_at, km);
    audit(db, now, null, 'STOP_STARTED', 'stop', id, { detected: true });
    const driver = nameOf(db, s.driver_user_id) ?? 'The driver';
    notifyAll(ctx, coordinatorIds(db), now, s, 'DRIVER_STOP', `${s.id}: unplanned stop`, `${driver} has not moved for ${STOP_WINDOW_MIN} min at km ${Math.round(km)}, away from any planned stop. Consider asking for a check-in.`, hints);
    hints.push(shipmentHint(s, 'stop'));
  }
}

// ---------------------------------------------------------------- routes

export function registerDriverOpsRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[]) {
  const { db } = ctx;
  const run = <T>(fn: (hints: PendingHint[]) => T): T => {
    const hints: PendingHint[] = [];
    const out = db.transaction(() => fn(hints))();
    ctx.hub.publish(hints);
    return out;
  };

  // ---- Start-of-shift checks (licence scan and voice check run in the driver's browser) ----

  const checksFor = (userId: string) => {
    const since = new Date(Date.now() - CHECK_VALID_HOURS * 3_600_000).toISOString();
    const last = (kind: string) =>
      (db.prepare('SELECT MAX(passed_at) AS at FROM driver_checks WHERE user_id = ? AND kind = ? AND passed_at >= ?').get(userId, kind, since) as { at: string | null }).at;
    const licence_at = last('LICENCE');
    const voice_at = last('VOICE');
    return { licence_at, voice_at, complete: !!licence_at && !!voice_at };
  };

  defineRoute(app, ctx, reg, {
    method: 'GET',
    url: '/me/checks',
    roles: ['DRIVER'],
    summary: 'Start-of-shift checks passed in the last 12 hours',
    responses: { 200: ChecksResponse },
    handler: ({ user }) => ({ status: 200, body: checksFor(user!.id) }),
  });

  defineRoute<Record<string, never>, Record<string, never>, { kind: 'LICENCE' | 'VOICE' }>(app, ctx, reg, {
    method: 'POST',
    url: '/me/checks',
    roles: ['DRIVER'],
    summary: 'Record a passed check. No image, text or audio is sent: only that it passed',
    body: z.object({ kind: z.enum(['LICENCE', 'VOICE']) }).strict(),
    responses: { 200: ChecksResponse },
    handler: ({ user, body }) => {
      const at = isoNow();
      db.transaction(() => {
        db.prepare('INSERT INTO driver_checks (id, user_id, kind, passed_at) VALUES (?, ?, ?, ?)').run(newId(db, 'CHK'), user!.id, body.kind, at);
        audit(db, at, user!.id, 'DRIVER_CHECK_PASSED', 'user', user!.id, { kind: body.kind });
      })();
      return { status: 200, body: checksFor(user!.id) };
    },
  });

  // ---- Driving time and stops ----

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/shipments/:id/driving',
    roles: ['COORDINATOR', 'DRIVER'],
    summary: 'Driving time since the last break, and any stop in progress',
    params: IdParams,
    responses: { 200: Driving, 404: ErrorResponse },
    handler: ({ user, params }) => ({ status: 200, body: drivingStatus(db, visible(ctx, user!, params.id), ctx.clock.nowIso()) }),
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/shipments/:id/stops',
    roles: ['COORDINATOR', 'DRIVER'],
    summary: 'Stops on this trip, oldest first',
    params: IdParams,
    responses: { 200: z.array(Stop), 404: ErrorResponse },
    handler: ({ user, params }) => ({ status: 200, body: stopsOf(db, visible(ctx, user!, params.id).id) }),
  });

  defineRoute<{ id: string }, Record<string, never>, { kind: 'BREAK' | 'FUEL' | 'CHARGING' | 'OTHER' }>(app, ctx, reg, {
    method: 'POST',
    url: '/shipments/:id/stops',
    roles: ['DRIVER'],
    summary: 'The driver starts a stop; coordinators are told it is planned',
    params: IdParams,
    body: z.object({ kind: z.enum(['BREAK', 'FUEL', 'CHARGING', 'OTHER']) }),
    responses: { 201: Stop, 404: ErrorResponse, 409: ErrorResponse },
    handler: ({ user, params, body }) => {
      const s = visible(ctx, user!, params.id);
      if (s.status !== 'IN_TRANSIT') throw new ApiError(409, 'NOT_IN_TRANSIT', 'Stops can be recorded only while the trip is in transit');
      const now = ctx.clock.nowIso();
      const id = run((hints) => {
        // Starting a stop closes any other open one (for example a detected stop the driver now explains).
        db.prepare('UPDATE stops SET ended_at = ? WHERE shipment_id = ? AND ended_at IS NULL').run(now, s.id);
        const id = newId(db, 'STP');
        db.prepare(`INSERT INTO stops (id, shipment_id, kind, source, started_at, at_km) VALUES (?, ?, ?, 'DRIVER', ?, ?)`).run(id, s.id, body.kind, now, s.last_progress_km);
        audit(db, now, user!.id, 'STOP_STARTED', 'stop', id, { kind: body.kind });
        const where = s.last_progress_km !== null ? `, km ${Math.round(s.last_progress_km)}` : '';
        notifyAll(ctx, coordinatorIds(db), now, s, 'DRIVER_STOP', `${s.id}: ${STOP_WORD[body.kind]}`, `${user!.name} started a planned ${STOP_WORD[body.kind]} at ${istClock(now)}${where}.`, hints);
        hints.push(shipmentHint(s, 'stop'));
        return id;
      });
      return { status: 201, body: stopsOf(db, s.id).find((x) => x.id === id)! };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'POST',
    url: '/stops/:id/end',
    roles: ['DRIVER'],
    summary: 'The driver ends the stop in progress and drives on',
    params: IdParams,
    responses: { 200: Stop, 404: ErrorResponse },
    handler: ({ user, params }) => {
      const row = db.prepare('SELECT shipment_id FROM stops WHERE id = ?').get(params.id) as { shipment_id: string } | undefined;
      if (!row) throw notFound('Stop not found');
      const s = visible(ctx, user!, row.shipment_id);
      const now = ctx.clock.nowIso();
      run((hints) => {
        db.prepare('UPDATE stops SET ended_at = COALESCE(ended_at, ?) WHERE id = ?').run(now, params.id);
        audit(db, now, user!.id, 'STOP_ENDED', 'stop', params.id, {});
        hints.push(shipmentHint(s, 'stop'));
      });
      return { status: 200, body: stopsOf(db, s.id).find((x) => x.id === params.id)! };
    },
  });

  // ---- Driver contact and check-ins ----

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/shipments/:id/driver-contact',
    roles: ['COORDINATOR'],
    summary: "The assigned driver's name and phone number",
    params: IdParams,
    responses: { 200: Contact, 404: ErrorResponse },
    handler: ({ user, params }) => {
      const s = visible(ctx, user!, params.id);
      const d = s.driver_user_id ? (db.prepare('SELECT name, phone FROM users WHERE id = ?').get(s.driver_user_id) as { name: string; phone: string | null } | undefined) : undefined;
      if (!d) throw notFound('No driver is assigned');
      return { status: 200, body: d };
    },
  });

  const checkinsOf = (shipmentId: string) =>
    (db.prepare('SELECT * FROM checkins WHERE shipment_id = ? ORDER BY requested_at DESC').all(shipmentId) as (Omit<z.infer<typeof Checkin>, 'requested_by_name'> & { requested_by: string })[]).map(
      ({ requested_by, ...c }) => ({ ...c, requested_by_name: nameOf(db, requested_by)! }),
    );

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/shipments/:id/checkins',
    roles: ['COORDINATOR', 'DRIVER'],
    summary: 'Check-in requests and answers, newest first',
    params: IdParams,
    responses: { 200: z.array(Checkin), 404: ErrorResponse },
    handler: ({ user, params }) => ({ status: 200, body: checkinsOf(visible(ctx, user!, params.id).id) }),
  });

  defineRoute<{ id: string }, Record<string, never>, { message?: string }>(app, ctx, reg, {
    method: 'POST',
    url: '/shipments/:id/checkins',
    roles: ['COORDINATOR'],
    summary: 'Ask the driver to check in; the driver answers in one tap',
    params: IdParams,
    body: z.object({ message: z.string().trim().max(200).optional() }),
    responses: { 201: Checkin, 404: ErrorResponse, 409: ErrorResponse },
    handler: ({ user, params, body }) => {
      const s = visible(ctx, user!, params.id);
      if (!s.driver_user_id) throw new ApiError(409, 'NO_DRIVER', 'No driver is assigned to this shipment');
      const now = ctx.clock.nowIso();
      const id = run((hints) => {
        // One open request at a time: a new one replaces any unanswered one.
        db.prepare('DELETE FROM checkins WHERE shipment_id = ? AND responded_at IS NULL').run(s.id);
        const id = newId(db, 'CHI');
        db.prepare('INSERT INTO checkins (id, shipment_id, requested_by, requested_at, message) VALUES (?, ?, ?, ?, ?)').run(id, s.id, user!.id, now, body.message || null);
        audit(db, now, user!.id, 'CHECKIN_REQUESTED', 'checkin', id, {});
        notifyAll(ctx, [s.driver_user_id!], now, s, 'CHECKIN_REQUEST', 'Please check in', body.message || `${user!.name} asked you to confirm everything is all right.`, hints);
        hints.push(shipmentHint(s, 'checkin'));
        return id;
      });
      return { status: 201, body: checkinsOf(s.id).find((c) => c.id === id)! };
    },
  });

  defineRoute<{ id: string }, Record<string, never>, { response: 'OK' | 'PROBLEM'; note?: string }>(app, ctx, reg, {
    method: 'POST',
    url: '/checkins/:id/respond',
    roles: ['DRIVER'],
    summary: 'The driver answers a check-in request',
    params: IdParams,
    body: z.object({ response: z.enum(['OK', 'PROBLEM']), note: z.string().trim().max(300).optional() }),
    responses: { 200: Checkin, 404: ErrorResponse, 409: ErrorResponse },
    handler: ({ user, params, body }) => {
      const row = db.prepare('SELECT shipment_id, responded_at FROM checkins WHERE id = ?').get(params.id) as { shipment_id: string; responded_at: string | null } | undefined;
      if (!row) throw notFound('Check-in not found');
      const s = visible(ctx, user!, row.shipment_id);
      if (row.responded_at) throw new ApiError(409, 'ALREADY_ANSWERED', 'This check-in was already answered');
      const now = ctx.clock.nowIso();
      run((hints) => {
        db.prepare('UPDATE checkins SET responded_at = ?, response = ?, response_note = ? WHERE id = ?').run(now, body.response, body.note || null, params.id);
        audit(db, now, user!.id, 'CHECKIN_ANSWERED', 'checkin', params.id, { response: body.response });
        const ok = body.response === 'OK';
        const said = body.note ? `: "${body.note}"` : ok ? '.' : '. Call the driver.';
        notifyAll(ctx, coordinatorIds(db), now, s, 'CHECKIN_REPLY', `${s.id}: ${ok ? 'driver is all right' : 'driver reports a problem'}`, `${user!.name} answered at ${istClock(now)}${said}`, hints);
        hints.push(shipmentHint(s, 'checkin'));
      });
      return { status: 200, body: checkinsOf(s.id).find((c) => c.id === params.id)! };
    },
  });

  // ---- Documents: delivery photo and invoice ----

  const docsOf = (shipmentId: string) =>
    (db.prepare('SELECT id, shipment_id, kind, mime, file_name, size_bytes, uploaded_by, uploaded_at, verified_by, verified_at FROM documents WHERE shipment_id = ? ORDER BY uploaded_at').all(shipmentId) as (Omit<z.infer<typeof DocumentMeta>, 'uploaded_by_name' | 'verified_by_name'> & { uploaded_by: string; verified_by: string | null })[]).map(
      ({ uploaded_by, verified_by, ...d }) => ({ ...d, uploaded_by_name: nameOf(db, uploaded_by)!, verified_by_name: nameOf(db, verified_by) }),
    );

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/shipments/:id/documents',
    roles: ['COORDINATOR', 'DRIVER', 'CUSTOMER'],
    summary: 'Delivery photo and invoice for this shipment (details only, not the file)',
    params: IdParams,
    responses: { 200: z.array(DocumentMeta), 404: ErrorResponse },
    handler: ({ user, params }) => ({ status: 200, body: docsOf(visible(ctx, user!, params.id).id) }),
  });

  defineRoute<{ id: string }, Record<string, never>, { kind: 'DELIVERY_PHOTO'; mime: string; file_name: string; data_base64: string }>(app, ctx, reg, {
    method: 'POST',
    url: '/shipments/:id/documents',
    roles: ['COORDINATOR', 'DRIVER'],
    summary: 'Upload the delivery photo (driver on arrival, or coordinator). Up to 5 MB. Invoices use /shipments/:id/invoice',
    params: IdParams,
    body: z.object({
      kind: z.literal('DELIVERY_PHOTO'),
      mime: z.string().max(60),
      file_name: z.string().trim().min(1).max(120),
      data_base64: z.string().min(8),
    }),
    responses: { 201: DocumentMeta, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    handler: ({ user, params, body }) => {
      const s = visible(ctx, user!, params.id);
      if (user!.role === 'DRIVER' && s.status !== 'ARRIVED' && s.status !== 'DELIVERED') {
        throw new ApiError(409, 'NOT_ARRIVED', 'Take the delivery photo once you have arrived');
      }
      if (!PHOTO_MIME.includes(body.mime)) throw new ApiError(422, 'UNSUPPORTED_FILE', 'Use a JPEG, PNG or WebP photo');
      const bytes = Buffer.from(body.data_base64, 'base64');
      if (bytes.length === 0) throw new ApiError(422, 'EMPTY_FILE', 'The file is empty');
      if (bytes.length > MAX_FILE_BYTES) throw new ApiError(422, 'FILE_TOO_LARGE', 'The file is larger than 5 MB');
      const now = ctx.clock.nowIso();
      const id = run((hints) => {
        // One current file of each kind per shipment: a new upload replaces the previous one.
        db.prepare('DELETE FROM documents WHERE shipment_id = ? AND kind = ?').run(s.id, body.kind);
        const id = newId(db, 'DOC');
        db.prepare('INSERT INTO documents (id, shipment_id, kind, mime, file_name, size_bytes, data, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          id, s.id, body.kind, body.mime, body.file_name, bytes.length, bytes, user!.id, now,
        );
        audit(db, now, user!.id, 'DOCUMENT_UPLOADED', 'document', id, { kind: body.kind, size_bytes: bytes.length });
        const customers = customerUserIds(db, s.customer_id);
        const msg = `${user!.name} added the delivery photo at ${istClock(now)}.`;
        notifyAll(ctx, coordinatorIds(db), now, s, 'DELIVERY_PHOTO', `${s.id}: delivery photo to verify`, msg, hints);
        notifyAll(ctx, customers, now, s, 'DELIVERY_PHOTO', `Order ${s.order_id}: delivery photo`, `${msg} You can view it on the order.`, hints);
        hints.push(shipmentHint(s, 'document'));
        return id;
      });
      return { status: 201, body: docsOf(s.id).find((d) => d.id === id)! };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/documents/:id/file',
    roles: ['COORDINATOR', 'DRIVER', 'CUSTOMER'],
    summary: 'The file itself',
    params: IdParams,
    responses: { 200: z.any(), 404: ErrorResponse },
    handler: ({ user, params, reply }) => {
      const d = db.prepare('SELECT shipment_id, mime, file_name, data FROM documents WHERE id = ?').get(params.id) as { shipment_id: string; mime: string; file_name: string; data: Buffer } | undefined;
      if (!d) throw notFound('Document not found');
      visible(ctx, user!, d.shipment_id);
      reply.header('Content-Type', d.mime);
      reply.header('Content-Disposition', `inline; filename="${d.file_name.replace(/[^\w.\- ]/g, '_')}"`);
      reply.header('Cache-Control', 'private, no-store');
      return { status: 200, body: d.data };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'POST',
    url: '/documents/:id/verify',
    roles: ['COORDINATOR'],
    summary: 'The coordinator confirms the delivery photo shows a completed delivery',
    params: IdParams,
    responses: { 200: DocumentMeta, 404: ErrorResponse, 409: ErrorResponse },
    handler: ({ user, params }) => {
      const d = db.prepare('SELECT shipment_id, kind FROM documents WHERE id = ?').get(params.id) as { shipment_id: string; kind: string } | undefined;
      if (!d) throw notFound('Document not found');
      if (d.kind !== 'DELIVERY_PHOTO') throw new ApiError(409, 'NOT_A_PHOTO', 'Only the delivery photo is verified');
      const s = visible(ctx, user!, d.shipment_id);
      const now = ctx.clock.nowIso();
      run((hints) => {
        db.prepare('UPDATE documents SET verified_by = ?, verified_at = ? WHERE id = ?').run(user!.id, now, params.id);
        audit(db, now, user!.id, 'DOCUMENT_VERIFIED', 'document', params.id, {});
        notifyAll(ctx, customerUserIds(db, s.customer_id), now, s, 'DELIVERY_VERIFIED', `Order ${s.order_id}: delivery confirmed`, `Plant X confirmed the delivery at ${istClock(now)}.`, hints);
        hints.push(shipmentHint(s, 'document'));
      });
      return { status: 200, body: docsOf(s.id).find((x) => x.id === params.id)! };
    },
  });

  // ---- Trip log: everything that happened on the trip, newest first ----

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/shipments/:id/log',
    roles: ['COORDINATOR'],
    summary: 'Milestones, reports, stops, check-ins, documents, alerts and decisions, newest first',
    params: IdParams,
    responses: { 200: z.array(LogEntry), 404: ErrorResponse },
    handler: ({ user, params }) => {
      const s = visible(ctx, user!, params.id);
      const out: z.infer<typeof LogEntry>[] = [];
      const driverName = nameOf(db, s.driver_user_id);
      const words = (v: unknown) => String(v).toLowerCase().replace(/_/g, ' ');
      const events = db
        .prepare(`SELECT type, occurred_at, actor_user_id, payload, source FROM shipment_events WHERE shipment_id = ? AND type <> 'POSITION' AND apply_status = 'APPLIED' ORDER BY occurred_at`)
        .all(s.id) as { type: string; occurred_at: string; actor_user_id: string | null; payload: string; source: string }[];
      for (const e of events) {
        const p = JSON.parse(e.payload) as Record<string, unknown>;
        const by = nameOf(db, e.actor_user_id) ?? (e.source === 'SIMULATOR' ? 'Replay' : e.source === 'SEED' ? 'Plan' : null);
        if (e.type === 'MILESTONE') out.push({ at: e.occurred_at, kind: 'MILESTONE', title: `Status: ${words(p.to_status)}`, detail: null, by });
        else if (e.type === 'DISRUPTION_REPORTED') {
          const parts = [p.note ? `"${p.note}"` : '', p.expected_delay_min ? `about ${p.expected_delay_min} min` : ''].filter(Boolean);
          const where = typeof p.at_km === 'number' ? ` at km ${p.at_km}` : '';
          out.push({ at: e.occurred_at, kind: 'DISRUPTION', title: `Reported: ${words(p.category)}${where}`, detail: parts.join(', ') || null, by });
        } else if (e.type === 'DISRUPTION_CLEARED') out.push({ at: e.occurred_at, kind: 'DISRUPTION', title: 'Disruption cleared', detail: null, by });
      }
      for (const x of stopsOf(db, s.id)) {
        const mins = x.ended_at ? Math.round(minutesBetween(x.started_at, x.ended_at)) : null;
        out.push({
          at: x.started_at,
          kind: 'STOP',
          title: `${x.source === 'DETECTED' ? 'Detected' : 'Planned'} ${STOP_WORD[x.kind]}${x.at_km !== null ? ` at km ${Math.round(x.at_km)}` : ''}`,
          detail: mins !== null ? `${mins} min, ended ${istClock(x.ended_at!)}` : 'In progress',
          by: x.source === 'DRIVER' ? driverName : 'Detected from positions',
        });
      }
      for (const c of checkinsOf(s.id)) {
        out.push({ at: c.requested_at, kind: 'CHECKIN', title: 'Check-in requested', detail: c.message, by: c.requested_by_name });
        if (c.responded_at) out.push({ at: c.responded_at, kind: 'CHECKIN', title: c.response === 'OK' ? 'Driver checked in: all right' : 'Driver checked in: problem', detail: c.response_note, by: driverName });
      }
      for (const d of docsOf(s.id)) {
        out.push({ at: d.uploaded_at, kind: 'DOCUMENT', title: 'Delivery photo added', detail: d.file_name, by: d.uploaded_by_name });
        if (d.verified_at) out.push({ at: d.verified_at, kind: 'DOCUMENT', title: 'Delivery verified from the photo', detail: null, by: d.verified_by_name });
      }
      const inv = db.prepare('SELECT filename, uploaded_by, uploaded_at FROM invoices WHERE shipment_id = ?').get(s.id) as { filename: string; uploaded_by: string; uploaded_at: string } | undefined;
      if (inv) out.push({ at: inv.uploaded_at, kind: 'DOCUMENT', title: 'Invoice ready', detail: inv.filename, by: nameOf(db, inv.uploaded_by) });
      const alerts = db.prepare('SELECT opened_at, level, title FROM alerts WHERE shipment_id = ? ORDER BY opened_at').all(s.id) as { opened_at: string; level: string; title: string }[];
      for (const a of alerts) out.push({ at: a.opened_at, kind: 'ALERT', title: `Alert opened (${a.level.toLowerCase()})`, detail: a.title, by: 'Control tower' });
      const decisions = db.prepare('SELECT decided_at, decided_by, option_type, note FROM decisions WHERE shipment_id = ? ORDER BY decided_at').all(s.id) as { decided_at: string; decided_by: string; option_type: string; note: string | null }[];
      for (const d of decisions) out.push({ at: d.decided_at, kind: 'DECISION', title: `Approved: ${words(d.option_type)}`, detail: d.note, by: nameOf(db, d.decided_by) });
      out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
      return { status: 200, body: out };
    },
  });
}
