import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DriverReport } from "./DriverReport";
import { setSession } from "../../auth/session";
import { USERS } from "../../mocks/fixtures";
import { loadInputs } from "../../mocks/scenario";

/* The report flow against the mock API: three taps (category, delay, Send), no typing. */
function renderReport() {
  const driver = USERS.find((u) => u.id === "USR-DRV-01")!;
  setSession({ token: `mock.${driver.id}`, user: { id: driver.id, name: driver.name, email: driver.email, role: "DRIVER" } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/driver/report"]}>
        <Routes>
          <Route path="/driver/report" element={<DriverReport />} />
          <Route path="/driver" element={<p>Trip screen</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("driver disruption report", () => {
  afterEach(() => setSession(null));

  it("reports an accident with a 60-minute estimate in three taps and returns to the trip", async () => {
    const user = userEvent.setup();
    renderReport();

    expect(await screen.findByRole("heading", { name: "What is the problem?" })).toBeInTheDocument();
    expect(screen.getAllByRole("button").filter((b) => ["Accident", "Breakdown", "Weather", "Road closed", "Loading delay", "Other"].includes(b.textContent ?? ""))).toHaveLength(6);

    await user.click(screen.getByRole("button", { name: "Accident" })); // tap 1
    expect(screen.getByRole("heading", { name: "How long will it hold you up?" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Accident" })).not.toBeInTheDocument(); // old step is gone at once

    await user.click(screen.getByRole("button", { name: "1 hour" })); // tap 2
    expect(screen.getByRole("heading", { name: "Send this report?" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" })); // tap 3
    expect(await screen.findByText("Trip screen")).toBeInTheDocument();

    await waitFor(() => expect(loadInputs().reports["SHP-1001"]).toBeDefined());
    expect(loadInputs().reports["SHP-1001"]).toMatchObject({ category: "ACCIDENT", expected_delay_min: 60 });
  });

  it("'Not sure' sends no estimate so the API uses the category default", async () => {
    const user = userEvent.setup();
    renderReport();
    await user.click(await screen.findByRole("button", { name: "Breakdown" }));
    await user.click(screen.getByRole("button", { name: "Not sure" }));
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(loadInputs().reports["SHP-1001"]).toBeDefined());
    expect(loadInputs().reports["SHP-1001"]).toMatchObject({ category: "BREAKDOWN", expected_delay_min: null });
  });

  it("Back steps out one stage at a time", async () => {
    const user = userEvent.setup();
    renderReport();
    await user.click(await screen.findByRole("button", { name: "Weather" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "What is the problem?" })).toBeInTheDocument();
  });
});
