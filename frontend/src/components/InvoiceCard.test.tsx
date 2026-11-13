import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InvoiceCard, MAX_INVOICE_BYTES, fileSize } from "./InvoiceCard";
import type { InvoiceMeta, ShipmentDetail } from "../api/contract";

const client = vi.hoisted(() => ({ uploadInvoice: vi.fn(), downloadInvoice: vi.fn(), api: vi.fn() }));
vi.mock("../api/client", async (original) => ({ ...(await original<typeof import("../api/client")>()), ...client }));
const api = client.api;

const META: InvoiceMeta = { filename: "INV-5001.pdf", size_bytes: 48_200, uploaded_at: "2026-11-16T03:20:00Z", uploaded_by_name: "Meera Kulkarni" };
const shipment = (invoice: InvoiceMeta | null) => ({ id: "SHP-1001", invoice }) as ShipmentDetail;

function renderCard(invoice: InvoiceMeta | null, canUpload = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InvoiceCard shipment={shipment(invoice)} canUpload={canUpload} />
    </QueryClientProvider>,
  );
}
const pdf = (name = "INV-5001.pdf", size = 1000) => new File([new Uint8Array(size)], name, { type: "application/pdf" });

describe("InvoiceCard", () => {
  beforeEach(() => {
    client.uploadInvoice.mockReset();
    client.downloadInvoice.mockReset();
    api.mockReset();
  });

  it("customer: waits when there is no invoice, and downloads when there is one", async () => {
    renderCard(null);
    expect(screen.getByText(/Your invoice is not ready yet/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upload/ })).not.toBeInTheDocument();
  });

  it("customer: downloads the file by its name and never sees who uploaded it", async () => {
    client.downloadInvoice.mockResolvedValue(undefined);
    renderCard(META);
    expect(screen.getByText("INV-5001.pdf")).toBeInTheDocument();
    expect(screen.getByText(/47 KB, added/)).toBeInTheDocument();
    expect(screen.queryByText(/Meera Kulkarni/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(client.downloadInvoice).toHaveBeenCalledWith("SHP-1001", "INV-5001.pdf");
  });

  it("coordinator: uploads a PDF and is told the customer was notified", async () => {
    client.uploadInvoice.mockResolvedValue(META);
    renderCard(null, true);
    const file = pdf();
    await userEvent.upload(screen.getByLabelText("Invoice PDF for SHP-1001"), file);
    await waitFor(() => expect(client.uploadInvoice).toHaveBeenCalledWith("SHP-1001", file));
    expect(await screen.findByRole("status")).toHaveTextContent("Invoice saved. The customer has been notified.");
  });

  it("coordinator: generates the invoice with one click", async () => {
    api.mockResolvedValue(META);
    renderCard(null, true);
    await userEvent.click(screen.getByRole("button", { name: "Generate invoice" }));
    expect(api).toHaveBeenCalledWith("/shipments/SHP-1001/invoice/generate", { method: "POST" });
    expect(await screen.findByRole("status")).toHaveTextContent("Invoice saved. The customer has been notified.");
  });

  it("coordinator: a wrong type or an oversized file is refused before any upload", async () => {
    renderCard(META, true);
    expect(screen.getByRole("button", { name: "Replace with a PDF" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate again" })).toBeInTheDocument();
    const input = screen.getByLabelText("Invoice PDF for SHP-1001");
    await userEvent.upload(input, new File(["x"], "photo.png", { type: "image/png" }), { applyAccept: false });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a PDF file.");
    await userEvent.upload(input, pdf("big.pdf", MAX_INVOICE_BYTES + 1));
    expect(screen.getByRole("alert")).toHaveTextContent("The limit is 2 MB.");
    expect(client.uploadInvoice).not.toHaveBeenCalled();
  });

  it("formats sizes", () => {
    expect(fileSize(500)).toBe("1 KB");
    expect(fileSize(48_200)).toBe("47 KB");
    expect(fileSize(1_572_864)).toBe("1.5 MB");
  });
});
