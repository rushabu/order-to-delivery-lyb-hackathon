// Builds a one-page invoice PDF from a shipment's own data. No PDF library: the page is a handful of
// text and line commands, written out with the cross-reference table the format requires.
// Pure: the same input gives the same bytes. Every rate and tax figure is fictional (database/README.md).
import { MIN_MS, parseIso } from '../time';

export interface InvoiceRates {
  gst_pct: number;
  default_rate_per_t_inr: number;
  /** The first rule whose `match` text appears in the product name (any case) wins. */
  rates: { match: string; rate_per_t_inr: number; hsn: string }[];
}

/** Used when the fixtures have no `invoice` block (the test stand-ins). Same figures as the seed. */
export const DEFAULT_INVOICE_RATES: InvoiceRates = {
  gst_pct: 18,
  default_rate_per_t_inr: 105000,
  rates: [
    { match: 'copolymer', rate_per_t_inr: 112000, hsn: '3902' },
    { match: 'polypropylene', rate_per_t_inr: 104000, hsn: '3902' },
    { match: 'PP', rate_per_t_inr: 104000, hsn: '3902' },
    { match: 'LLDPE', rate_per_t_inr: 110000, hsn: '3901' },
    { match: 'HDPE', rate_per_t_inr: 108000, hsn: '3901' },
    { match: 'LDPE', rate_per_t_inr: 116000, hsn: '3901' },
  ],
};

export interface InvoiceInput {
  order_id: string;
  shipment_id: string;
  customer_name: string;
  deliver_to: string;
  /** One line per order on the truck: the shipment's own order first, then any added at dispatch. */
  lines: InvoiceLine[];
  transporter_name: string;
  vehicle_reg: string;
  promised_by: string;
  departed_at: string | null;
  /** Invoice date: the time it was generated. */
  issued_at: string;
}

export interface InvoiceLine {
  order_id: string;
  product: string;
  quantity_t: number;
}

export interface InvoiceAmounts {
  invoice_no: string;
  lines: (InvoiceLine & { hsn: string; rate_per_t_inr: number; amount_inr: number })[];
  taxable_inr: number;
  cgst_inr: number;
  sgst_inr: number;
  total_inr: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Goods value at the product's rate, plus GST split equally into CGST and SGST (seller and buyer are both in Maharashtra). */
export function invoiceAmounts(input: Pick<InvoiceInput, 'order_id' | 'lines'>, cfg: InvoiceRates): InvoiceAmounts {
  const lines = input.lines.map((line) => {
    const rule = cfg.rates.find((r) => line.product.toLowerCase().includes(r.match.toLowerCase()));
    const rate = rule?.rate_per_t_inr ?? cfg.default_rate_per_t_inr;
    return { ...line, hsn: rule?.hsn ?? '39', rate_per_t_inr: rate, amount_inr: round2(line.quantity_t * rate) };
  });
  const taxable = round2(lines.reduce((sum, line) => sum + line.amount_inr, 0));
  const half = round2((taxable * cfg.gst_pct) / 200);
  return {
    invoice_no: `INV-${input.order_id.replace(/^ORD-/, '')}`,
    lines,
    taxable_inr: taxable,
    cgst_inr: half,
    sgst_inr: half,
    total_inr: round2(taxable + 2 * half),
  };
}

/** 2280000 -> "22,80,000.00" (Indian digit grouping). */
export function inr(n: number): string {
  const [whole, paise] = n.toFixed(2).split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest ? `${rest},` : ''}${last3}.${paise}`;
}

function istDate(iso: string | null, withTime = true): string {
  if (!iso) return 'Not yet dispatched';
  const d = new Date(parseIso(iso) + 330 * MIN_MS);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const two = (n: number) => String(n).padStart(2, '0');
  const date = `${two(d.getUTCDate())} ${month} ${d.getUTCFullYear()}`;
  return withTime ? `${date}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} IST` : date;
}

// ---- Page drawing ----

type Font = 'F1' | 'F2' | 'F3' | 'F4'; // Helvetica, Helvetica-Bold, Courier, Courier-Bold
const FONT_NAMES: Record<Font, string> = { F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Courier', F4: 'Courier-Bold' };
const COURIER_EM = 0.6; // every Courier glyph is 600/1000 of the font size wide, so numbers can be right-aligned

/** The standard fonts cover Latin-1 only; anything else becomes "?". Backslash and brackets are escaped. */
function pdfString(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '(' || ch === ')') out += `\\${ch}`;
    else if (code >= 32 && code <= 126) out += ch;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8)}`;
    else out += '?';
  }
  return out;
}

class Page {
  private ops: string[] = [];
  text(x: number, y: number, size: number, font: Font, value: string): void {
    this.ops.push(`BT /${font} ${size} Tf ${x} ${y} Td (${pdfString(value)}) Tj ET`);
  }
  /** Courier text ending at x. */
  right(x: number, y: number, size: number, font: 'F3' | 'F4', value: string): void {
    this.text(Math.round((x - value.length * size * COURIER_EM) * 100) / 100, y, size, font, value);
  }
  line(x1: number, y: number, x2: number, width = 0.6): void {
    this.ops.push(`${width} w ${x1} ${y} m ${x2} ${y} l S`);
  }
  band(x: number, y: number, w: number, h: number): void {
    this.ops.push(`0.92 g ${x} ${y} ${w} ${h} re f 0 g`);
  }
  content(): string {
    return this.ops.join('\n');
  }
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 3)}...` : s);

function draw(input: InvoiceInput, a: InvoiceAmounts, cfg: InvoiceRates): string {
  const p = new Page();
  const L = 50;
  const R = 545;
  const half = cfg.gst_pct / 2;

  p.text(L, 790, 20, 'F2', 'Plant X');
  p.text(L, 774, 9, 'F1', 'Polymer plant (fictional company), Panvel, Maharashtra');
  p.text(430, 790, 15, 'F2', 'TAX INVOICE');
  p.text(430, 774, 9, 'F1', 'Fictional demo document');
  p.line(L, 762, R, 1);

  p.text(L, 740, 8, 'F2', 'BILL TO');
  p.text(L, 725, 11, 'F2', clip(input.customer_name, 44));
  p.text(L, 711, 9, 'F1', `Deliver to: ${clip(input.deliver_to, 48)}`);

  const meta: [string, string][] = [
    ['Invoice no.', a.invoice_no],
    ['Invoice date', istDate(input.issued_at, false)],
    ['Order', input.order_id],
    ['Shipment', input.shipment_id],
  ];
  meta.forEach(([label, value], i) => {
    p.text(350, 740 - i * 14, 9, 'F1', label);
    p.text(430, 740 - i * 14, 9, 'F2', value);
  });

  p.line(L, 678, R);
  p.text(L, 662, 8, 'F2', 'DISPATCH');
  const dispatch: [string, string][] = [
    ['Transporter', clip(input.transporter_name, 34)],
    ['Vehicle', input.vehicle_reg],
    ['Dispatched', istDate(input.departed_at)],
    ['Promised delivery', istDate(input.promised_by)],
  ];
  dispatch.forEach(([label, value], i) => {
    const x = i % 2 === 0 ? L : 310;
    const y = 646 - Math.floor(i / 2) * 14;
    p.text(x, y, 9, 'F1', label);
    p.text(x + 90, y, 9, 'F2', value);
  });

  // Line items: one row per order on the truck. The order number is shown only when there is more than one.
  p.band(L, 588, R - L, 20);
  p.text(L + 6, 594, 9, 'F2', 'Description');
  p.text(262, 594, 9, 'F2', 'HSN');
  p.right(360, 594, 9, 'F4', 'Qty (t)');
  p.right(450, 594, 9, 'F4', 'Rate (INR/t)');
  p.right(R - 6, 594, 9, 'F4', 'Amount (INR)');
  const ROW = 16;
  a.lines.forEach((line, i) => {
    const y = 570 - i * ROW;
    p.text(L + 6, y, 9, 'F1', clip(a.lines.length > 1 ? `${line.order_id}: ${line.product}` : line.product, 44));
    p.text(262, y, 9, 'F1', line.hsn);
    p.right(360, y, 9, 'F3', line.quantity_t.toFixed(2));
    p.right(450, y, 9, 'F3', inr(line.rate_per_t_inr));
    p.right(R - 6, y, 9, 'F3', inr(line.amount_inr));
  });
  const down = (a.lines.length - 1) * ROW; // everything below the table moves down with it
  p.line(L, 558 - down, R);

  const totals: [string, number][] = [
    ['Taxable value', a.taxable_inr],
    [`CGST ${half}%`, a.cgst_inr],
    [`SGST ${half}%`, a.sgst_inr],
  ];
  totals.forEach(([label, value], i) => {
    p.text(350, 540 - down - i * 16, 9, 'F1', label);
    p.right(R - 6, 540 - down - i * 16, 9, 'F3', inr(value));
  });
  p.line(350, 498 - down, R, 1);
  p.text(350, 480 - down, 11, 'F2', 'Total (INR)');
  p.right(R - 6, 480 - down, 11, 'F4', inr(a.total_inr));

  p.line(L, 120, R);
  p.text(L, 104, 8, 'F2', 'Fictional document for a hackathon demonstration. Not a valid tax invoice.');
  p.text(L, 92, 8, 'F1', 'Plant X and the buyer are fictional. Rates and taxes are invented, so no GSTIN, bank or payment details are shown.');
  p.text(L, 80, 8, 'F1', `Generated by the Order-to-Delivery Control Tower on ${istDate(input.issued_at)}.`);
  return p.content();
}

/** PDF date: D:YYYYMMDDHHmmSSZ (UTC). */
const pdfDate = (iso: string) => `D:${iso.replace(/[-:T]/g, '').replace(/\.\d+/, '')}`;

export function buildInvoicePdf(input: InvoiceInput, cfg: InvoiceRates = DEFAULT_INVOICE_RATES): { filename: string; pdf: Buffer; amounts: InvoiceAmounts } {
  const amounts = invoiceAmounts(input, cfg);
  const content = draw(input, amounts, cfg);
  const fonts = (Object.keys(FONT_NAMES) as Font[]).map((f, i) => `/${f} ${5 + i} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << ${fonts} >> >> >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    ...(Object.values(FONT_NAMES).map((name) => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`)),
    `<< /Title (${pdfString(`Invoice ${amounts.invoice_no}`)}) /Producer (Order-to-Delivery Control Tower) /CreationDate (${pdfDate(input.issued_at)}) >>`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  // Each cross-reference entry is exactly 20 bytes: 10-digit offset, 5-digit generation, flag, space, newline.
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return { filename: `${amounts.invoice_no}.pdf`, pdf: Buffer.from(body, 'latin1'), amounts };
}
