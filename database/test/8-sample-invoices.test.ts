// The sample invoices in samples/invoices/ are exactly what the generator makes from the seed today.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SAMPLES_DIR, sampleInvoices } from '../scripts/make-sample-invoices';

describe('sample invoices', () => {
  const made = sampleInvoices();

  it('one PDF per demo shipment, identical to a fresh run (npm run samples:invoices)', () => {
    expect(made.map((m) => m.filename)).toEqual(['INV-5001.pdf', 'INV-5002.pdf', 'INV-5003.pdf', 'INV-5004.pdf', 'INV-5005.pdf']);
    expect(readdirSync(SAMPLES_DIR).sort()).toEqual(made.map((m) => m.filename));
    for (const { filename, pdf } of made) {
      expect(existsSync(join(SAMPLES_DIR, filename))).toBe(true);
      expect(readFileSync(join(SAMPLES_DIR, filename)).equals(pdf), `${filename} is stale`).toBe(true);
    }
  });

  it('each is a small, well-formed PDF marked as fictional', () => {
    for (const { pdf } of made) {
      const text = pdf.toString('latin1');
      expect(text.startsWith('%PDF-1.4\n')).toBe(true);
      expect(text.endsWith('%%EOF\n')).toBe(true);
      expect(pdf.length).toBeLessThan(10_000);
      expect(text).toContain('Not a valid tax invoice');
      // The cross-reference table points at the start of every object.
      const xref = Number(/startxref\n(\d+)\n/.exec(text)![1]);
      expect(text.slice(xref, xref + 4)).toBe('xref');
      const offsets = [...text.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
      offsets.forEach((at, i) => expect(text.slice(at, at + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
      expect(offsets.length).toBe(9);
    }
  });
});
