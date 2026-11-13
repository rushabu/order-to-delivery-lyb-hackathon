import { useId, useRef, useState } from "react";
import { DownloadSimple, FilePdf, MagicWand, UploadSimple } from "@phosphor-icons/react";
import { useDownloadInvoice, useGenerateInvoice, useUploadInvoice } from "../api/queries";
import type { ShipmentDetail } from "../api/contract";
import { dateTimeTz } from "../lib/time";
import { Button, Card, CardHeader } from "./ui";

/*
  Invoice for a shipment (bonus item, brief page 7). The coordinator generates one from the shipment
  data (fictional rates, database/README.md) or uploads a PDF; the customer downloads it.
  The API repeats the file checks; they are here so the reason is shown at once.
*/
export const MAX_INVOICE_BYTES = 2 * 1024 * 1024;

export function fileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function InvoiceCard({ shipment, canUpload = false }: { shipment: ShipmentDetail; canUpload?: boolean }) {
  const invoice = shipment.invoice ?? null;
  const upload = useUploadInvoice(shipment.id);
  const generate = useGenerateInvoice(shipment.id);
  const download = useDownloadInvoice(shipment.id);
  const saving = upload.isPending || generate.isPending;
  const inputRef = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const headingId = useId();

  function onFile(file: File | undefined) {
    if (inputRef.current) inputRef.current.value = ""; // so the same file can be chosen again
    upload.reset();
    generate.reset();
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return setProblem("Choose a PDF file.");
    if (file.size > MAX_INVOICE_BYTES) return setProblem(`That file is ${fileSize(file.size)}. The limit is 2 MB.`);
    setProblem(null);
    upload.mutate(file);
  }

  function onGenerate() {
    setProblem(null);
    upload.reset();
    generate.mutate();
  }

  const error = problem ?? upload.error?.message ?? generate.error?.message ?? download.error?.message ?? null;

  return (
    <Card aria-labelledby={headingId}>
      <CardHeader title="Invoice" id={headingId} />
      <div className="space-y-3 p-5">
        {invoice ? (
          <div className="flex flex-wrap items-center gap-3 border-l-[3px] border-accent pl-3">
            <FilePdf size={28} aria-hidden className="shrink-0 text-ink-2" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body font-semibold text-ink" title={invoice.filename}>{invoice.filename}</p>
              <p className="tnum text-meta text-muted">
                {fileSize(invoice.size_bytes)}, added {dateTimeTz(invoice.uploaded_at)}
                {canUpload && ` by ${invoice.uploaded_by_name}`}
              </p>
            </div>
            <Button variant={canUpload ? "secondary" : "primary"} disabled={download.isPending} onClick={() => download.mutate(invoice.filename)}>
              <DownloadSimple size={16} weight="bold" aria-hidden />
              {download.isPending ? "Downloading…" : "Download"}
            </Button>
          </div>
        ) : (
          <p className="text-body text-muted">{canUpload ? "No invoice yet. Generate one from this shipment or upload your own; the customer is told as soon as you add it." : "Your invoice is not ready yet. We will tell you here when it is."}</p>
        )}

        {canUpload && (
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="sr-only"
              tabIndex={-1}
              aria-label={`Invoice PDF for ${shipment.id}`}
              onChange={(e) => onFile(e.target.files?.[0])}
            />
            <Button variant={invoice ? "secondary" : "primary"} disabled={saving} onClick={onGenerate}>
              <MagicWand size={16} weight="bold" aria-hidden />
              {generate.isPending ? "Generating…" : invoice ? "Generate again" : "Generate invoice"}
            </Button>
            <Button disabled={saving} onClick={() => inputRef.current?.click()}>
              <UploadSimple size={16} weight="bold" aria-hidden />
              {upload.isPending ? "Uploading…" : invoice ? "Replace with a PDF" : "Upload PDF"}
            </Button>
            <p className="basis-full text-meta text-muted">Generated invoices use fictional rates. Uploads must be a PDF of 2 MB or less.</p>
          </div>
        )}

        {(upload.isSuccess || generate.isSuccess) && !saving && !error && <p role="status" className="text-meta font-semibold text-low">Invoice saved. The customer has been notified.</p>}
        {error && <p role="alert" className="border-l-4 border-high bg-high-soft px-3 py-2 text-body text-high">{error}</p>}
      </div>
    </Card>
  );
}
