import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { DriverChoice, NewOrder, defaultPromise, istInputToIso } from "./NewOrder";
import type { NewOrderForm, OrderPlan, TruckOption } from "../../api/contract";

const api = vi.hoisted(() => vi.fn());
vi.mock("../../api/client", async (original) => ({ ...(await original<typeof import("../../api/client")>()), api }));
// The page needs the real API; the test environment runs with the in-browser mock switched on.
vi.mock("../../lib/env", async (original) => ({ ...(await original<typeof import("../../lib/env")>()), isMocked: () => false }));

const FORM: NewOrderForm = {
  now: "2026-11-16T03:20:00Z",
  customers: [{ id: "CUS-01", name: "Deccan Mouldings Pvt Ltd", deliver_to: "Deccan Mouldings, Ranjangaon MIDC" }],
  products: ["Polypropylene homopolymer, bagged"],
};
const base: TruckOption = {
  id: "", type: "NEW_TRUCK", label: "", feasible: true, infeasible_reason: null, recommended: false, shipment_id: null, vehicle_reg: null, transporter_name: null,
  capacity_t: null, load_after_t: null, spare_after_t: null, planned_departure: null, eta: null, margin_min: null, km_saved: null, cost_saved_inr: null,
  driver_name: null, note: null,
};
const PLAN: OrderPlan = {
  recommended_option_id: "ADD-SHP-1004",
  options: [
    { ...base, id: "ADD-SHP-1001", type: "ADD_TO_TRUCK", label: "Add to SHP-1001 (MH 99 SB 4127), already going to this customer", feasible: false, infeasible_reason: "This truck has already left the plant" },
    { ...base, id: "ADD-SHP-1004", type: "ADD_TO_TRUCK", label: "Add to SHP-1004 (MH 99 SB 4385), already going to this customer", recommended: true, shipment_id: "SHP-1004", vehicle_reg: "MH 99 SB 4385",
      capacity_t: 28, load_after_t: 26, spare_after_t: 2, planned_departure: "2026-11-17T03:00:00Z", eta: "2026-11-17T06:15:00Z", margin_min: 195, km_saved: 150, cost_saved_inr: 6750 },
    { ...base, id: "NEW-USR-DRV-02", label: "Separate truck MH 99 KR 3048 with Gurpreet Sandhu", driver_name: "Gurpreet Sandhu", note: "Leaves after Gurpreet is back from SHP-1005", vehicle_reg: "MH 99 KR 3048", capacity_t: 20, load_after_t: 6, spare_after_t: 14,
      planned_departure: "2026-11-17T05:50:00Z", eta: "2026-11-17T08:35:00Z", margin_min: 55 },
  ],
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <NewOrder />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NewOrder", () => {
  beforeEach(() => api.mockReset());

  it("converts the typed India time to UTC and defaults to the next afternoon", () => {
    expect(istInputToIso("2026-11-17T15:00")).toBe("2026-11-17T09:30:00Z");
    expect(defaultPromise("2026-11-16T03:20:00Z")).toBe("2026-11-17T15:00");
    expect(defaultPromise("2026-11-16T20:00:00Z")).toBe("2026-11-18T15:00"); // 01:30 IST on the 17th
  });

  it("shows the API's options with the recommended truck first, and approves the chosen one", async () => {
    api.mockImplementation(async (path: string) => {
      if (path === "/orders/new") return FORM;
      if (path === "/orders/plan") return PLAN;
      return { order_id: "ORD-6001", shipment_id: "SHP-1004", option: PLAN.options[1] };
    });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Find a truck" }));
    const draft = { customer_id: "CUS-01", product: "Polypropylene homopolymer, bagged", quantity_t: 6, promised_by: "2026-11-17T09:30:00Z" };
    expect(api).toHaveBeenCalledWith("/orders/plan", { method: "POST", body: draft });

    const rows = within(await screen.findByRole("table")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Recommended");
    expect(rows[0]).toHaveTextContent("Add to SHP-1004");
    expect(rows[0]).toHaveTextContent("26 of 28 t");
    expect(rows[0]).toHaveTextContent("3 h 15 min early");
    expect(rows[0]).toHaveTextContent("150 km, ₹6,750");
    expect(rows[1]).toHaveTextContent("Not available: This truck has already left the plant");
    expect(within(rows[1]).queryByRole("button")).not.toBeInTheDocument();
    expect(rows[2]).toHaveTextContent("Separate truck MH 99 KR 3048 with Gurpreet Sandhu");

    await userEvent.click(within(rows[0]).getByRole("button", { name: /Approve/ }));
    await waitFor(() => expect(api).toHaveBeenLastCalledWith("/orders", { method: "POST", body: { ...draft, option_id: "ADD-SHP-1004" } }));
    expect(await screen.findByText(/travels on SHP-1004/)).toBeInTheDocument();
    expect(screen.getByText(/One 150 km trip avoided, about ₹6,750/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open SHP-1004" })).toHaveAttribute("href", "/coordinator/shipments/SHP-1004");
  });

  it("clears the listed trucks when the order is edited", async () => {
    api.mockImplementation(async (path: string) => (path === "/orders/new" ? FORM : PLAN));
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Find a truck" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Quantity (tonnes)"), "0");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("DriverChoice", () => {
  it("lists each free driver with their truck and arrival, and picks one", async () => {
    const pick = vi.fn();
    const deepak = { ...PLAN.options[2], id: "NEW-USR-DRV-06", driver_name: "Deepak More", transporter_name: "Konkan Roadlines", recommended: true };
    const prakash = { ...base, id: "NEW-USR-DRV-04", driver_name: "Prakash Jadhav", transporter_name: "Sahyadri Bulk Carriers", feasible: false, infeasible_reason: "No free Sahyadri Bulk Carriers truck can carry 30 t" };
    render(<DriverChoice options={[prakash, deepak]} onPick={pick} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Earliest on time");
    expect(rows[0]).toHaveTextContent("Deepak More");
    expect(rows[0]).toHaveTextContent("truck MH 99 KR 3048 (20 t)");
    expect(rows[1]).toHaveTextContent("No free Sahyadri Bulk Carriers truck can carry 30 t");
    expect(within(rows[1]).queryByRole("button")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Choose Deepak" }));
    expect(pick).toHaveBeenCalledWith(deepak);
  });
});
