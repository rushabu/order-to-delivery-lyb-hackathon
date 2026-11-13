import { createOutbox, retryDelayMs } from "./outbox";
import { ApiError } from "./client";
import type { ShipmentEventRequest, ShipmentEventResponse } from "./contract";

const ok = (e: ShipmentEventRequest): ShipmentEventResponse => ({
  event_id: e.event_id, apply_status: "APPLIED", shipment_id: "SHP-1001", shipment_version: 42, occurred_at: "2026-11-16T04:00:00Z", eta_snapshot_id: "ETA-000318",
});

function setup(send: (id: string, e: ShipmentEventRequest) => Promise<ShipmentEventResponse>) {
  const sent: ShipmentEventRequest[] = [];
  const onSent = vi.fn();
  const outbox = createOutbox({
    send: (id, e) => {
      sent.push(structuredClone(e));
      return send(id, e);
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    storageKey: null,
    onSent,
  });
  return { outbox, sent, onSent };
}

describe("driver outbox (DESIGN.md 5.6)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("backs off 2, 4, 8, 16, 30 then 30 seconds", () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelayMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("retries a network failure with the same event_id until it is accepted", async () => {
    let calls = 0;
    const { outbox, sent, onSent } = setup(async (_id, e) => {
      calls += 1;
      if (calls < 3) throw new ApiError(0, "NETWORK", "Could not reach the server");
      return ok(e);
    });

    const eventId = outbox.enqueue("SHP-1001", "DISRUPTION_REPORTED", { category: "ACCIDENT", expected_delay_min: 60 }, "Problem report");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(outbox.get().items[0]).toMatchObject({ state: "retrying", attempts: 1 });

    await vi.advanceTimersByTimeAsync(1999);
    expect(sent).toHaveLength(1); // not before 2 s
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);
    expect(outbox.get().items[0]).toMatchObject({ state: "retrying", attempts: 2 });

    await vi.advanceTimersByTimeAsync(4000);
    expect(sent).toHaveLength(3);
    expect(sent.map((e) => e.event_id)).toEqual([eventId, eventId, eventId]);
    expect(outbox.get().items).toHaveLength(0);
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("also retries a 5xx", async () => {
    let calls = 0;
    const { outbox, sent } = setup(async (_id, e) => {
      calls += 1;
      if (calls === 1) throw new ApiError(503, "HTTP_503", "Service unavailable");
      return ok(e);
    });
    outbox.enqueue("SHP-1001", "MILESTONE", { to_status: "ARRIVED" }, "Arrived");
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(2);
    expect(outbox.get().items).toHaveLength(0);
  });

  it("drops a permanently refused event and reports why", async () => {
    const { outbox, sent } = setup(async () => {
      throw new ApiError(409, "INVALID_TRANSITION", "Cannot go from PLANNED to DELIVERED");
    });
    outbox.enqueue("SHP-1001", "MILESTONE", { to_status: "DELIVERED" }, "Delivered");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(1);
    expect(outbox.get().items).toHaveLength(0);
    expect(outbox.get().rejections[0]).toMatchObject({ label: "Delivered", message: "Cannot go from PLANNED to DELIVERED" });
  });

  it("omits occurred_at in demo mode so the server stamps the simulated clock", async () => {
    const { outbox, sent } = setup(async (_id, e) => ok(e));
    outbox.enqueue("SHP-1001", "MILESTONE", { to_status: "ARRIVED" }, "Arrived");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0]).not.toHaveProperty("occurred_at");
  });

  it("'Try again now' sends at once instead of waiting for the back-off", async () => {
    let calls = 0;
    const { outbox, sent } = setup(async (_id, e) => {
      calls += 1;
      if (calls === 1) throw new ApiError(0, "NETWORK", "offline");
      return ok(e);
    });
    outbox.enqueue("SHP-1001", "MILESTONE", { to_status: "ARRIVED" }, "Arrived");
    await vi.advanceTimersByTimeAsync(0);
    outbox.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(2);
    expect(outbox.get().items).toHaveLength(0);
  });
});
