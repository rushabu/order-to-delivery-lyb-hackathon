import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApprovalDialog, type ApproveOutcome } from "./ApprovalDialog";
import { ApiError } from "../api/client";
import { deriveWorld, initialInputs } from "../mocks/scenario";
import type { DecisionOption, OptionSet } from "../api/contract";

const shipment = deriveWorld(initialInputs()).shipments[0]; // SHP-1001
const reroute: DecisionOption = {
  id: "OPT-REROUTE-RTE-01B", type: "REROUTE", feasible: true, label: "Reroute via Khalapur bypass (RTE-01B)",
  projected_eta: "2026-11-16T06:09:00Z", projected_late_min: 0, projected_risk_level: "MEDIUM", improvement_min: 46, added_km: 16, added_cost_inr: 720,
  params: { alt_route_id: "RTE-01B" },
};
const set: OptionSet = {
  id: "OPS-0001", alert_id: "ALT-0001", shipment_id: "SHP-1001", generated_at: "2026-11-16T04:00:00Z", based_on_snapshot_id: "ETA-000318",
  valid_until: "2026-11-16T04:10:00Z", recommended_option_id: reroute.id, options: [reroute],
};

function Harness({ onConfirm }: { onConfirm: (a: { decision_id: string; note: string }) => Promise<ApproveOutcome> }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Approve</button>
      <ApprovalDialog open={open} option={reroute} set={set} shipment={shipment} onCancel={() => setOpen(false)} onConfirm={onConfirm} />
    </>
  );
}

describe("ApprovalDialog", () => {
  it("says what will change and who will be notified before approving", async () => {
    render(<Harness onConfirm={async () => ({ ok: true })} />);
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("heading", { name: "Approve reroute for SHP-1001?" })).toBeInTheDocument();
    expect(screen.getByText("Route changes from RTE-01 to RTE-01B.")).toBeInTheDocument();
    expect(screen.getByText(/Projected arrival 11:39 IST, 46 min earlier than continuing/)).toBeInTheDocument();
    expect(screen.getByText(/Deccan Mouldings Pvt Ltd: the new estimate and the reason/)).toBeInTheDocument();
    expect(screen.getByText(/The driver of SHP-1001/)).toBeInTheDocument();
  });

  it("moves focus into the dialog and returns it to the opener on cancel", async () => {
    render(<Harness onConfirm={async () => ({ ok: true })} />);
    const opener = screen.getByRole("button", { name: "Approve" });
    await userEvent.click(opener);
    expect(screen.getByRole("button", { name: "Approve reroute" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(opener).toHaveFocus();
  });

  it("sends the note and keeps the same decision_id when a failed approval is retried", async () => {
    const calls: { decision_id: string; note: string }[] = [];
    let attempt = 0;
    const onConfirm = async (a: { decision_id: string; note: string }): Promise<ApproveOutcome> => {
      calls.push(a);
      attempt += 1;
      return attempt === 1 ? { ok: false, error: new ApiError(0, "NETWORK", "Could not reach the server") } : { ok: true };
    };
    render(<Harness onConfirm={onConfirm} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.type(screen.getByLabelText(/Note for the ledger/), "Bypass clear per transporter desk");
    await user.click(screen.getByRole("button", { name: "Approve reroute" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
    await user.click(screen.getByRole("button", { name: "Approve reroute" }));
    expect(calls).toHaveLength(2);
    expect(calls[0].decision_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1].decision_id).toBe(calls[0].decision_id);
    expect(calls[0].note).toBe("Bypass clear per transporter desk");
  });
});
