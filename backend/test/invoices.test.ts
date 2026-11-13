// Invoice upload and download: who may do what, what counts as a PDF, and that a reset clears it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_INVOICE_BYTES, safeFilename } from '../src/invoices/routes';
import { DEFAULT_INVOICE_RATES, inr, invoiceAmounts } from '../src/invoices/invoicePdf';
import { REAL_FIXTURES_DIR } from '../src/sim/fixtures';
import { COORD, CUST1, DRIVER1, makeApp, type TestApp } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n% fictional test invoice\n%%EOF\n', 'latin1');
const OTHER_CUSTOMER = 'USR-CUST-03'; // Godavari Flexipack; SHP-1001 belongs to Deccan Mouldings

describe('invoices', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp({}, REAL_FIXTURES_DIR);
  });
  afterEach(() => t.close());

  const upload = async (userId: string, shipmentId: string, body: Buffer | string, filename = 'INV-5001.pdf', contentType = 'application/pdf') =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/shipments/${shipmentId}/invoice?filename=${encodeURIComponent(filename)}`,
      headers: { authorization: `Bearer ${await t.login(userId)}`, 'content-type': contentType },
      payload: body,
    });
  const download = async (userId: string, shipmentId: string) =>
    t.app.inject({ method: 'GET', url: `/api/v1/shipments/${shipmentId}/invoice`, headers: { authorization: `Bearer ${await t.login(userId)}` } });

  it('coordinator uploads; the customer is told, sees it on the shipment and downloads the same bytes', async () => {
    const cust = await t.login(CUST1);
    expect((await t.req('GET', '/shipments/SHP-1001', cust)).body.invoice).toBeNull();
    expect((await download(CUST1, 'SHP-1001')).statusCode).toBe(404);

    const up = await upload(COORD, 'SHP-1001', PDF);
    expect(up.statusCode).toBe(201);
    expect(up.json()).toEqual({ filename: 'INV-5001.pdf', size_bytes: PDF.length, uploaded_at: '2026-11-16T03:20:00Z', uploaded_by_name: 'Meera Kulkarni' });

    expect((await t.req('GET', '/shipments/SHP-1001', cust)).body.invoice).toMatchObject({ filename: 'INV-5001.pdf', size_bytes: PDF.length });
    const note = (await t.req('GET', '/notifications', cust)).body.find((n: any) => n.kind === 'INVOICE_READY');
    expect(note).toMatchObject({ shipment_id: 'SHP-1001', title: 'Invoice ready for order ORD-5001' });

    const got = await download(CUST1, 'SHP-1001');
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('application/pdf');
    expect(got.headers['content-disposition']).toBe('attachment; filename="INV-5001.pdf"');
    expect(got.rawPayload.equals(PDF)).toBe(true);
    expect((await download(COORD, 'SHP-1001')).rawPayload.equals(PDF)).toBe(true);
  });

  it('only a coordinator uploads; other customers and drivers cannot download or see it', async () => {
    expect((await upload(CUST1, 'SHP-1001', PDF)).statusCode).toBe(403);
    expect((await upload(DRIVER1, 'SHP-1001', PDF)).statusCode).toBe(403);
    expect((await upload(COORD, 'SHP-1001', PDF)).statusCode).toBe(201);
    expect((await download(OTHER_CUSTOMER, 'SHP-1001')).statusCode).toBe(404); // not their shipment
    expect((await download(DRIVER1, 'SHP-1001')).statusCode).toBe(403);
    expect((await t.req('GET', '/shipments/SHP-1001', await t.login(DRIVER1))).body).not.toHaveProperty('invoice');
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/shipments/SHP-1001/invoice' })).statusCode).toBe(401);
    expect((await upload(COORD, 'SHP-NOPE', PDF)).statusCode).toBe(404);
  });

  it('refuses anything that is not a PDF of at most 2 MB, and cleans the file name', async () => {
    expect((await upload(COORD, 'SHP-1001', Buffer.from('MZ not a pdf'))).json().error.message).toBe('That file is not a PDF');
    expect((await upload(COORD, 'SHP-1001', '{"a":1}', 'x.pdf', 'application/json')).statusCode).toBe(422);
    const big = Buffer.concat([PDF, Buffer.alloc(MAX_INVOICE_BYTES)]);
    expect((await upload(COORD, 'SHP-1001', big)).statusCode).toBe(422);
    expect((await t.req('GET', '/shipments/SHP-1001', await t.login(COORD))).body.invoice).toBeNull();

    expect(safeFilename('C:\\Users\\me\\..\\INV 5001 (final).PDF')).toBe('INV 5001 (final).pdf');
    expect(safeFilename('../../etc/passwd')).toBe('passwd.pdf');
    expect(safeFilename('a"b\r\nc.pdf')).toBe('a_b__c.pdf');
    expect(safeFilename('///')).toBe('invoice.pdf');
  });

  it('a second upload replaces the first, and a demo reset removes it', async () => {
    const second = Buffer.concat([PDF, Buffer.from('% corrected\n')]);
    await upload(COORD, 'SHP-1001', PDF);
    expect((await upload(COORD, 'SHP-1001', second, 'INV-5001-rev1.pdf')).json().filename).toBe('INV-5001-rev1.pdf');
    expect((await download(CUST1, 'SHP-1001')).rawPayload.equals(second)).toBe(true);
    const notes = (await t.req('GET', '/notifications', await t.login(CUST1))).body.filter((n: any) => n.kind === 'INVOICE_READY');
    expect(notes.map((n: any) => n.title).sort()).toEqual(['Invoice ready for order ORD-5001', 'Invoice updated for order ORD-5001']);

    expect((await t.req('POST', '/demo/reset', await t.login(COORD))).status).toBe(200);
    expect((await download(CUST1, 'SHP-1001')).statusCode).toBe(404);
  });

  it('generates the invoice from the shipment data at the seed rates', async () => {
    const coord = await t.login(COORD);
    expect((await t.req('POST', '/shipments/SHP-1001/invoice/generate', await t.login(CUST1))).status).toBe(403);
    expect((await t.req('POST', '/shipments/SHP-NOPE/invoice/generate', coord)).status).toBe(404);
    const made = await t.req('POST', '/shipments/SHP-1001/invoice/generate', coord);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ filename: 'INV-5001.pdf', uploaded_by_name: 'Meera Kulkarni' });

    const got = await download(CUST1, 'SHP-1001');
    expect(got.rawPayload.length).toBe(made.body.size_bytes);
    const text = got.rawPayload.toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    // 24 t of polypropylene homopolymer at INR 1,04,000 per tonne, plus 9% + 9% GST.
    for (const part of ['Deccan Mouldings Pvt Ltd', 'ORD-5001', 'SHP-1001', 'MH 99 SB 4127', '(24.00)', '(1,04,000.00)', '(24,96,000.00)', '(2,24,640.00)', '(29,45,280.00)', 'Not a valid tax invoice']) {
      expect(text, part).toContain(part);
    }
    const note = (await t.req('GET', '/notifications', await t.login(CUST1))).body.find((n: any) => n.kind === 'INVOICE_READY');
    expect(note.title).toBe('Invoice ready for order ORD-5001');
  });

  it('works out amounts: rate by product, GST split in two, Indian digit grouping', () => {
    const cfg = DEFAULT_INVOICE_RATES;
    const one = (order_id: string, product: string, quantity_t: number) => invoiceAmounts({ order_id, lines: [{ order_id, product, quantity_t }] }, cfg);
    expect(one('ORD-5002', 'HDPE pellets, bagged', 24)).toMatchObject({
      invoice_no: 'INV-5002', taxable_inr: 2592000, cgst_inr: 233280, sgst_inr: 233280, total_inr: 3058560,
      lines: [{ hsn: '3901', rate_per_t_inr: 108000, amount_inr: 2592000 }],
    });
    // "LLDPE" contains "LDPE": the more specific rule comes first.
    expect(one('ORD-1', 'LLDPE film grade, bagged', 1).lines[0].rate_per_t_inr).toBe(110000);
    expect(one('ORD-1', 'Polypropylene copolymer, bagged', 1).lines[0].rate_per_t_inr).toBe(112000);
    expect(one('ORD-LIVE-001', 'Mystery resin', 0.6)).toMatchObject({ invoice_no: 'INV-LIVE-001', taxable_inr: 63000, total_inr: 74340, lines: [{ hsn: '39' }] });
    // Two orders on one truck: one line each, tax on the sum.
    expect(invoiceAmounts({ order_id: 'ORD-5004', lines: [
      { order_id: 'ORD-5004', product: 'Polypropylene copolymer, bagged', quantity_t: 20 },
      { order_id: 'ORD-6001', product: 'Polypropylene homopolymer, bagged', quantity_t: 6 },
    ] }, cfg)).toMatchObject({ invoice_no: 'INV-5004', taxable_inr: 2864000, cgst_inr: 257760, total_inr: 3379520 });
    expect([inr(999), inr(1000), inr(123456.5), inr(29452800)]).toEqual(['999.00', '1,000.00', '1,23,456.50', '2,94,52,800.00']);
    expect(t.ctx.fixtures.config.invoice).toEqual(cfg); // the seed carries the same figures as the fallback
  });
});
