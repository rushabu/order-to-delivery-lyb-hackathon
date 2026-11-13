// Invoice upload and download (bonus item, brief page 7).
//   POST /shipments/:id/invoice?filename=...   coordinator; the body is the PDF itself (application/pdf)
//   POST /shipments/:id/invoice/generate       coordinator; builds the PDF from the shipment data (invoicePdf.ts)
//   GET  /shipments/:id/invoice                coordinator, or the customer of that shipment
// Drivers never see invoices. Out-of-scope shipments answer 404, like every other shipment route.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit';
import { shipmentNow, type Ctx } from '../ctx';
import type { Db } from '../db/db';
import { notFound, validationFailed } from '../http/errors';
import { defineRoute, type RegisteredRoute } from '../http/route';
import { ErrorResponse, InvoiceMeta } from '../http/schemas';
import { customerUserIds } from '../notify/notifier';
import type { AuthUser } from '../auth/policy';
import { getVisibleShipment, type ShipmentRow } from '../shipments/repo';
import { shipmentDetail } from '../shipments/routes';
import { buildInvoicePdf, DEFAULT_INVOICE_RATES } from './invoicePdf';
import type { PendingHint } from '../stream/hub';

export const MAX_INVOICE_BYTES = 2 * 1024 * 1024;
const IdParams = z.object({ id: z.string().min(1).max(40) });
const UploadQuery = z.object({ filename: z.string().trim().min(1).max(200) });

interface InvoiceRow {
  filename: string;
  size_bytes: number;
  uploaded_at: string;
  uploaded_by_name: string;
}

/** What the screens show about a shipment's invoice; null when none has been uploaded. */
export function invoiceMeta(db: Db, shipmentId: string): InvoiceRow | null {
  const row = db
    .prepare(
      `SELECT i.filename, i.size_bytes, i.uploaded_at, u.name AS uploaded_by_name
       FROM invoices i JOIN users u ON u.id = i.uploaded_by WHERE i.shipment_id = ?`,
    )
    .get(shipmentId) as InvoiceRow | undefined;
  return row ?? null;
}

/** Keep only the file's own name and a safe set of characters; the result always ends in .pdf. */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop()!.replace(/[^\w .()-]/g, '_').replace(/\.pdf$/i, '').trim().slice(0, 100);
  return `${base || 'invoice'}.pdf`;
}

/** Store (or replace) the shipment's invoice, tell the customer, and return what the screens show. */
function saveInvoice(ctx: Ctx, user: AuthUser, s: ShipmentRow, filename: string, pdf: Buffer, how: 'UPLOADED' | 'GENERATED'): InvoiceRow {
  const { db } = ctx;
  const now = shipmentNow(ctx, s.id);
  const hints: PendingHint[] = [];
  db.transaction(() => {
    const replaced = db.prepare('SELECT 1 FROM invoices WHERE shipment_id = ?').get(s.id) !== undefined;
    db.prepare(
      `INSERT INTO invoices (shipment_id, filename, size_bytes, content, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(shipment_id) DO UPDATE SET filename = excluded.filename, size_bytes = excluded.size_bytes,
         content = excluded.content, uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at`,
    ).run(s.id, filename, pdf.length, pdf, user.id, now);
    audit(db, now, user.id, how === 'UPLOADED' ? 'INVOICE_UPLOADED' : 'INVOICE_GENERATED', 'shipment', s.id, { filename, size_bytes: pdf.length, replaced });
    for (const userId of customerUserIds(db, s.customer_id)) {
      ctx.notifier.send(db, now, {
        user_id: userId,
        shipment_id: s.id,
        kind: 'INVOICE_READY',
        title: `Invoice ${replaced ? 'updated' : 'ready'} for order ${s.order_id}`,
        body: `${filename} can be downloaded from the delivery page.`,
      }, hints);
    }
    // Coordinators and the customer refetch the shipment; the driver's view does not change.
    hints.push({ hint: { entity: 'shipment', id: s.id, version: s.version, kinds: ['invoice'] }, audience: { kind: 'shipment', customer_id: s.customer_id, driver_user_id: null } });
  })();
  ctx.hub.publish(hints);
  return invoiceMeta(db, s.id)!;
}

export function registerInvoiceRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[]) {
  const { db } = ctx;
  // The upload is the raw file, so no multipart library is needed. Fastify refuses a larger body itself.
  app.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: MAX_INVOICE_BYTES }, (_req, body, done) => done(null, body));

  defineRoute<{ id: string }, { filename: string }, unknown>(app, ctx, reg, {
    method: 'POST',
    url: '/shipments/:id/invoice',
    roles: ['COORDINATOR'],
    summary: 'Upload or replace the invoice PDF for a shipment (body: application/pdf, at most 2 MB)',
    params: IdParams,
    query: UploadQuery,
    responses: { 201: InvoiceMeta, 404: ErrorResponse, 422: ErrorResponse },
    handler: ({ user, params, query, body }) => {
      const s = getVisibleShipment(db, user!, params.id);
      if (!s) throw notFound('Shipment not found');
      if (!Buffer.isBuffer(body)) throw validationFailed('Send the PDF file itself with Content-Type application/pdf');
      if (body.length === 0 || body.length > MAX_INVOICE_BYTES) throw validationFailed('The invoice must be a PDF of at most 2 MB');
      if (body.subarray(0, 5).toString('latin1') !== '%PDF-') throw validationFailed('That file is not a PDF');
      return { status: 201, body: saveInvoice(ctx, user!, s, safeFilename(query.filename), body, 'UPLOADED') };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'POST',
    url: '/shipments/:id/invoice/generate',
    roles: ['COORDINATOR'],
    summary: 'Build the invoice PDF from the shipment data and the fictional rates in the seed, and save it',
    params: IdParams,
    responses: { 201: InvoiceMeta, 404: ErrorResponse },
    handler: ({ user, params }) => {
      const s = getVisibleShipment(db, user!, params.id);
      if (!s) throw notFound('Shipment not found');
      const d = shipmentDetail(ctx, user!, s);
      const { filename, pdf } = buildInvoicePdf(
        {
          order_id: s.order_id,
          shipment_id: s.id,
          customer_name: d.customer_name,
          deliver_to: d.destination_name,
          // The truck's own order (whatever the added orders do not account for), then each added order.
          lines: [
            { order_id: s.order_id, product: d.order.product, quantity_t: Math.round((s.quantity_t - d.extra_orders.reduce((sum, o) => sum + o.quantity_t, 0)) * 100) / 100 },
            ...d.extra_orders.map((o) => ({ order_id: o.id, product: o.product, quantity_t: o.quantity_t })),
          ],
          transporter_name: d.transporter_name,
          vehicle_reg: s.vehicle_reg,
          promised_by: s.agreed_delivery_by,
          departed_at: s.departed_at,
          issued_at: shipmentNow(ctx, s.id),
        },
        ctx.fixtures.config.invoice ?? DEFAULT_INVOICE_RATES,
      );
      return { status: 201, body: saveInvoice(ctx, user!, s, filename, pdf, 'GENERATED') };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/shipments/:id/invoice',
    roles: ['COORDINATOR', 'CUSTOMER'],
    summary: 'Download the invoice PDF (answers application/pdf, not JSON)',
    params: IdParams,
    responses: { 200: z.unknown(), 404: ErrorResponse },
    handler: ({ user, params, reply }) => {
      const s = getVisibleShipment(db, user!, params.id);
      const row = s && (db.prepare('SELECT filename, content FROM invoices WHERE shipment_id = ?').get(s.id) as { filename: string; content: Buffer } | undefined);
      if (!s || !row) throw notFound(s ? 'No invoice has been uploaded for this shipment' : 'Shipment not found');
      audit(db, shipmentNow(ctx, s.id), user!.id, 'INVOICE_DOWNLOADED', 'shipment', s.id, { filename: row.filename });
      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="${row.filename}"`)
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(row.content);
      return { status: 200, body: null };
    },
  });
}
