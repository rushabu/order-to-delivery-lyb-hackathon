// Writes one sample invoice PDF per demo shipment into database/samples/invoices/, for trying the
// manual "Upload PDF" button. It uses the backend's own invoice builder and the rates in seed/config.json,
// so a sample is byte for byte what "Generate invoice" makes at the 08:50 demo start.
//
// Usage (from database/): npm run samples:invoices
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInvoicePdf, type InvoiceRates } from '../../backend/src/invoices/invoicePdf';
import { ROOT, SEED_DIR } from './seed-lib';

export const SAMPLES_DIR = join(ROOT, 'samples', 'invoices');
const read = (name: string) => JSON.parse(readFileSync(join(SEED_DIR, name), 'utf8'));

export function sampleInvoices(): { filename: string; pdf: Buffer }[] {
  const scenario = read('scenario-main.json');
  const config = read('config.json') as { invoice: InvoiceRates };
  const customers = read('customers.json').customers as { id: string; name: string }[];
  const transporters = read('transporters.json').transporters as { id: string; name: string }[];
  const routes = read('routes.json').routes as { id: string; destination: string }[];
  return (scenario.shipments as any[]).map((s) => {
    const order = scenario.orders.find((o: { id: string }) => o.id === s.order_id);
    const departed = s.milestones.find((m: { status: string }) => m.status === 'IN_TRANSIT');
    return buildInvoicePdf(
      {
        order_id: order.id,
        shipment_id: s.id,
        customer_name: customers.find((c) => c.id === order.customer_id)!.name,
        deliver_to: routes.find((r) => r.id === s.route_id)!.destination,
        lines: [{ order_id: order.id, product: order.product, quantity_t: s.quantity_t }],
        transporter_name: transporters.find((t) => t.id === s.transporter_id)!.name,
        vehicle_reg: s.vehicle_reg,
        promised_by: order.agreed_delivery_by,
        departed_at: departed?.at ?? null,
        issued_at: scenario.clock_start,
      },
      config.invoice,
    );
  });
}

if (process.argv[1]?.endsWith('make-sample-invoices.ts')) {
  mkdirSync(SAMPLES_DIR, { recursive: true });
  for (const { filename, pdf } of sampleInvoices()) {
    writeFileSync(join(SAMPLES_DIR, filename), pdf);
    console.log('wrote', join(SAMPLES_DIR, filename), pdf.length, 'bytes');
  }
}
