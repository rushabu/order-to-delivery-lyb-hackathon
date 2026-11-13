import { render, screen, within } from "@testing-library/react";
import { EtaPanel } from "./EtaPanel";
import { SNAP_1001 } from "../mocks/fixtures";

// DESIGN.md 6.6 step B is the sample snapshot in 5.7.2.
const stepB = SNAP_1001.stepB("2026-11-16T04:00:00Z", "5f0c2c1e-8a4b-4f6d-9a57-2f3f1f0b7a11");

describe("EtaPanel", () => {
  it("shows the worked example: ETA, window, promise, risk word and lateness", () => {
    render(<EtaPanel snapshot={stepB} />);
    expect(screen.getByText("12:25")).toBeInTheDocument();
    expect(screen.getByText(/Likely between 12:05 and 12:45 IST/)).toBeInTheDocument();
    expect(screen.getByText("11:45 IST")).toBeInTheDocument();
    expect(screen.getByText("40 min late")).toBeInTheDocument();
    // Risk is an icon plus a word, never colour alone
    expect(screen.getByText("Delayed")).toBeInTheDocument();
    expect(screen.getByText("Expected 40 min late: accident ahead at km 75 adds 60 min")).toBeInTheDocument();
  });

  it("lists each factor in minutes and a total equal to the sum (100 + 15 + 60 = 175)", () => {
    render(<EtaPanel snapshot={stepB} />);
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row");
    const text = rows.map((r) => r.textContent);
    expect(text).toContain("Remaining drive at normal speed100");
    expect(text).toContain("Checkpoint stop at km 10015");
    expect(text).toContain("Accident ahead at km 75 (driver estimate)60");
    expect(text.at(-1)).toBe("Total from 09:30 IST175");
  });

  it("highlights only the factor rows that changed since the previous snapshot", () => {
    render(<EtaPanel snapshot={stepB} previous={SNAP_1001.stepA} />);
    const row = (label: RegExp) => screen.getByRole("rowheader", { name: label }).closest("tr")!;
    expect(row(/Accident ahead/)).toHaveClass("row-changed"); // new factor
    expect(row(/Remaining drive/)).toHaveClass("row-changed"); // 110 -> 100
    expect(row(/Checkpoint stop/)).not.toHaveClass("row-changed"); // 15 -> 15
  });

  it("never calls the risk score a probability", () => {
    render(<EtaPanel snapshot={stepB} />);
    expect(screen.getByText(/Risk score 100 of 100 \(a ranking, not a probability\)/)).toBeInTheDocument();
  });

  it("uses plain words for customers and hides the score", () => {
    render(<EtaPanel snapshot={stepB} audience="customer" />);
    expect(screen.getByText("Expected delivery")).toBeInTheDocument();
    expect(screen.getByText("What adds time")).toBeInTheDocument();
    expect(screen.queryByText(/Risk score/)).not.toBeInTheDocument();
  });
});
