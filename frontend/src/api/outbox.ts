import { useSyncExternalStore } from "react";
import { ApiError, api } from "./client";
import type { ShipmentEventRequest, ShipmentEventResponse } from "./contract";
import { DEMO_MODE } from "../lib/env";

/*
  Driver outbox (DESIGN.md 5.6). Every driver event is written here first, then sent.
  - Network error or 5xx: keep it and retry with the SAME event_id after 2, 4, 8, 16, 30, 30 ... seconds.
    The server de-duplicates by event_id, so a retry can never apply twice.
  - Any other error (403, 404, 409, 422): the server has refused it for good; drop it and show why.
  - In demo mode occurred_at is omitted so the server stamps the simulated clock.
  Items are kept in localStorage so a page reload on the phone does not lose an unsent report.
*/

export interface OutboxItem {
  shipment_id: string;
  event: ShipmentEventRequest;
  label: string; // what the driver tapped, for the status line
  attempts: number;
  next_attempt_at: number; // epoch ms
  state: "sending" | "retrying";
}

export interface Rejection {
  event_id: string;
  label: string;
  message: string;
}

export interface OutboxDeps {
  send: (shipmentId: string, event: ShipmentEventRequest) => Promise<ShipmentEventResponse>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  storageKey: string | null;
  onSent?: (item: OutboxItem, res: ShipmentEventResponse) => void;
}

export function retryDelayMs(attempts: number): number {
  return Math.min(2000 * 2 ** Math.max(0, attempts - 1), 30_000);
}

export function createOutbox(deps: OutboxDeps) {
  let items: OutboxItem[] = load();
  let rejections: Rejection[] = [];
  let timer: unknown = null;
  let flushing = false;
  const listeners = new Set<() => void>();
  let snapshot = { items, rejections };

  function load(): OutboxItem[] {
    if (!deps.storageKey) return [];
    try {
      const raw = localStorage.getItem(deps.storageKey);
      return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
    } catch {
      return [];
    }
  }
  function changed() {
    if (deps.storageKey) {
      try {
        localStorage.setItem(deps.storageKey, JSON.stringify(items));
      } catch {
        /* the item still lives in memory */
      }
    }
    snapshot = { items, rejections };
    listeners.forEach((l) => l());
  }
  function schedule() {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    if (!items.length) return;
    const wait = Math.max(0, Math.min(...items.map((i) => i.next_attempt_at)) - deps.now());
    timer = deps.setTimer(() => {
      timer = null;
      void flush();
    }, wait);
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (const item of items.filter((i) => i.next_attempt_at <= deps.now())) {
        try {
          const res = await deps.send(item.shipment_id, item.event);
          items = items.filter((i) => i.event.event_id !== item.event.event_id);
          deps.onSent?.(item, res);
        } catch (e) {
          const retryable = !(e instanceof ApiError) || e.status === 0 || e.status >= 500;
          if (retryable) {
            const attempts = item.attempts + 1;
            items = items.map((i) => (i.event.event_id === item.event.event_id ? { ...i, attempts, state: "retrying", next_attempt_at: deps.now() + retryDelayMs(attempts) } : i));
          } else {
            items = items.filter((i) => i.event.event_id !== item.event.event_id);
            rejections = [...rejections, { event_id: item.event.event_id, label: item.label, message: (e as ApiError).message }];
          }
        }
        changed();
      }
    } finally {
      flushing = false;
      schedule();
    }
  }

  return {
    enqueue(shipmentId: string, type: ShipmentEventRequest["type"], payload: Record<string, unknown>, label: string) {
      const event: ShipmentEventRequest = { event_id: crypto.randomUUID(), type, payload };
      if (!DEMO_MODE) event.occurred_at = new Date(deps.now()).toISOString();
      items = [...items, { shipment_id: shipmentId, event, label, attempts: 0, next_attempt_at: deps.now(), state: "sending" }];
      changed();
      void flush();
      return event.event_id;
    },
    /** Retry everything now (e.g. the phone came back online). */
    retryNow() {
      items = items.map((i) => ({ ...i, next_attempt_at: deps.now() }));
      changed();
      void flush();
    },
    dismissRejection(eventId: string) {
      rejections = rejections.filter((r) => r.event_id !== eventId);
      changed();
    },
    get: () => snapshot,
    subscribe(cb: () => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    start() {
      if (items.length) void flush();
    },
  };
}

export type Outbox = ReturnType<typeof createOutbox>;

let shared: Outbox | null = null;

const sentListeners = new Set<NonNullable<OutboxDeps["onSent"]>>();

/** Subscribe to successful sends (the driver screen refetches its trip). Returns an unsubscribe function. */
export function onOutboxSent(fn: NonNullable<OutboxDeps["onSent"]>): () => void {
  sentListeners.add(fn);
  return () => {
    sentListeners.delete(fn);
  };
}

/** The app-wide outbox, created on first use. */
export function getOutbox(): Outbox {
  if (!shared) {
    shared = createOutbox({
      send: (shipmentId, event) => api<ShipmentEventResponse>(`/shipments/${shipmentId}/events`, { method: "POST", body: event }),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      storageKey: "ct.driver.outbox",
      onSent: (item, res) => sentListeners.forEach((l) => l(item, res)),
    });
    window.addEventListener("online", () => shared?.retryNow());
    shared.start();
  }
  return shared;
}

export function useOutbox(outbox: Outbox) {
  return useSyncExternalStore(outbox.subscribe, outbox.get, outbox.get);
}
