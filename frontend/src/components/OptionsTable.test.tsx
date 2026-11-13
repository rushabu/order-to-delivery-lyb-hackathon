import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptionsTable } from "./OptionsTable";
import type { OptionSet } from "../api/contract";

// DESIGN.md 5.7.3 sample options. CONTINUE is listed before the recommended REROUTE on purpose,
// to check that the table moves the recommended row to the top.
const set: OptionSet = {
  id: "OPS-0001", alert_id: "ALT-0001", shipment_id: "SHP-1001", generated_at: "2026-11-16T04:00:00Z",
  based_on_snapshot_id: "ETA-000318", valid_until: "2026-11-16T04:10:00Z", recommended_option_id: "OPT-REROUTE-RTE-01B",
  options: [
    { id: "OPT-CONTINUE", type: "CONTINUE", feasible: true, label: "Continue on current route and monitor", projected_eta: "2026-11-16T06:55:00Z", projected_late_min: 40, projected_risk_level: "HIGH", improvement_min: 0, added_km: 0, added_cost_inr: 0, params: {} },
    { id: "OPT-REROUTE-RTE-01B", type: "REROUTE", feasible: true, label: "Reroute via Khalapur bypass (RTE-01B)", projected_eta: "2026-11-16T06:09:00Z", projected_late_min: 0, projected_risk_level: "MEDIUM", improvement_min: 46, added_km: 16, added_cost_inr: 720, params: { alt_route_id: "RTE-01B" } },
    { id: "OPT-SPLIT", type: "SPLIT_SHIPMENT", feasible: false, infeasible_reason: "Load is already in transit on one vehicle", label: "Split shipment" },
  ],
};

describe("OptionsTable", () => {
  it("puts the recommended option first and marks it with a word, not colour alone", () => {
    render(<OptionsTable set={set} onApprove={() => {}} />);
    const bodyRows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(bodyRows[0]).toHaveTextContent("Recommended");
    expect(bodyRows[0]).toHaveTextContent("Reroute via Khalapur bypass (RTE-01B)");
    expect(bodyRows[0]).toHaveTextContent("11:39");
    expect(bodyRows[0]).toHaveTextContent("On time");
    expect(bodyRows[0]).toHaveTextContent("46 min");
    expect(bodyRows[0]).toHaveTextContent("+16 km");
    expect(bodyRows[0]).toHaveTextContent("₹720");
  });

  it("shows infeasible options disabled with the API's reason and no approve button", () => {
    render(<OptionsTable set={set} onApprove={() => {}} />);
    const split = screen.getByText("Split shipment").closest("tr")!;
    expect(split).toHaveTextContent("Not available: Load is already in transit on one vehicle");
    expect(within(split).queryByRole("button")).not.toBeInTheDocument();
    expect(split).toHaveTextContent("Unavailable");
  });

  it("calls onApprove with the chosen option, operable by keyboard", async () => {
    const onApprove = vi.fn();
    render(<OptionsTable set={set} onApprove={onApprove} />);
    const user = userEvent.setup();
    await user.tab();
    expect(screen.getByRole("button", { name: /Approve: Reroute via Khalapur bypass/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: "OPT-REROUTE-RTE-01B" }));
  });
});
