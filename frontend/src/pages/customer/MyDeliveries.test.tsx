import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { MyDeliveries, lateMinutes } from "./MyDeliveries";
import type { ShipmentSummary } from "../../api/contract";

const api = vi.hoisted(() => vi.fn());
vi.mock("../../api/client", async (original) => ({ ...(await original<typeof import("../../api/client")>()), api }));

const row = (over: Partial<ShipmentSummary>): ShipmentSummary => ({
  id: "SHP-1", order_id: "ORD-1", customer_name: "Godavari Flexipack Pvt Ltd", destination_name: "Godavari Flexipack, Satpur MIDC", transporter_name: "Konkan Roadlines",
  status: "DELIVERED", active_route_id: "RTE-02", last_position: null, current_eta: null, open_alert: null, version: 1, ...over,
});
const LIST: ShipmentSummary[] = [
  row({ id: "SHP-1003", order_id: "ORD-5003", status: "PLANNED" }),
  row({ id: "SHP-0902", order_id: "ORD-4902", arrived_at: "2026-11-10T06:30:00Z", original_promised_by: "2026-11-10T07:00:00Z" }),
  row({ id: "SHP-0906", order_id: "ORD-4906", arrived_at: "2026-11-12T08:10:00Z", original_promised_by: "2026-11-12T07:30:00Z" }),
];

describe("MyDeliveries", () => {
  it("measures lateness against the original promise", () => {
    expect(lateMinutes(LIST[1])).toBe(-30);
    expect(lateMinutes(LIST[2])).toBe(40);
    expect(lateMinutes(LIST[0])).toBeNull();
  });

  it("gives active deliveries a card and lists finished ones under a closed Past deliveries section", async () => {
    api.mockImplementation(async (path: string) => (path.startsWith("/shipments") ? LIST : { id: "RTE-02", origin: "Plant X", total_km: 178, alternatives: [] }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <MyDeliveries />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Order ORD-5003")).toBeInTheDocument();
    expect(screen.getAllByText(/^Expected/)).toHaveLength(1); // no blank ETA cards for finished deliveries
    expect(screen.queryByText("No active deliveries.")).not.toBeInTheDocument();

    const summary = screen.getByText("Past deliveries").closest("summary")!;
    expect(summary).toHaveTextContent("2 delivered, 1 on time");
    const details = summary.closest("details")!;
    expect(details).not.toHaveAttribute("open");
    await userEvent.click(summary);
    expect(details).toHaveAttribute("open");
    const items = within(details).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("ORD-4906"); // most recent first
    expect(items[0]).toHaveTextContent("Delivered 12 Nov, 13:40 IST");
    expect(items[0]).toHaveTextContent("40 min late");
    expect(items[1]).toHaveTextContent("ORD-4902");
    expect(items[1]).toHaveTextContent("On time");
    expect(within(items[1]).getByRole("link")).toHaveAttribute("href", "/customer/shipments/SHP-0902");
  });
});
