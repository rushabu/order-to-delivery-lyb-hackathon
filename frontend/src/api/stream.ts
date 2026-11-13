import { useEffect, useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { API_BASE } from "../lib/env";
import { authHeaders, transport } from "./client";
import type { StreamHint } from "./contract";

/*
  Live updates (DESIGN.md 5.8). EventSource cannot send an Authorization header, so the stream is read
  with fetch. Each message is a hint: we refetch the matching REST data. If the stream drops we show
  "Reconnecting", poll every 3 seconds (see makeQueryClient) and retry the stream with backoff.
*/
export type StreamStatus = "connecting" | "live" | "reconnecting";

let status: StreamStatus = "connecting";
const listeners = new Set<() => void>();
export const streamStatus = {
  get: () => status,
  set(next: StreamStatus) {
    if (next === status) return;
    status = next;
    listeners.forEach((l) => l());
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(streamStatus.subscribe, streamStatus.get, streamStatus.get);
}

/** Map a hint to the queries that show that entity. */
export function applyHint(qc: QueryClient, hint: StreamHint) {
  switch (hint.entity) {
    case "shipment":
      if (hint.id) {
        qc.invalidateQueries({ queryKey: ["shipment", hint.id] });
        qc.invalidateQueries({ queryKey: ["eta-history", hint.id] });
      }
      qc.invalidateQueries({ queryKey: ["shipments"] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
      qc.invalidateQueries({ queryKey: ["options"] });
      qc.invalidateQueries({ queryKey: ["decisions"] });
      if (hint.kinds?.includes("status")) qc.invalidateQueries({ queryKey: ["demo-state", "live-route"] });
      break;
    case "notification":
      qc.invalidateQueries({ queryKey: ["notifications"] });
      break;
    case "dashboard":
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["decisions"] });
      break;
    case "demo":
      qc.invalidateQueries();
      break;
  }
}

/** Parse server-sent event text. Returns complete messages and the unparsed remainder. */
export function parseSse(buffer: string): { hints: StreamHint[]; rest: string } {
  const hints: StreamHint[] = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue; // comment or keep-alive line
    try {
      hints.push(JSON.parse(data) as StreamHint);
    } catch {
      /* ignore a malformed hint; polling and the next hint keep data fresh */
    }
  }
  return { hints, rest };
}

/** Keeps one stream open while signed in. Mounted once, in the app shell. */
export function useLiveUpdates(qc: QueryClient, token: string | undefined) {
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let attempt = 0;

    async function run() {
      while (!controller.signal.aborted) {
        try {
          streamStatus.set(attempt === 0 ? "connecting" : "reconnecting");
          const res = await transport("/stream")(`${API_BASE}/stream`, {
            headers: { Accept: "text/event-stream", ...authHeaders() },
            signal: controller.signal,
          });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          streamStatus.set("live");
          attempt = 0;
          qc.invalidateQueries(); // on connect or reconnect, refetch everything shown
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const parsed = parseSse(buffer + value);
            buffer = parsed.rest;
            parsed.hints.forEach((h) => applyHint(qc, h));
          }
          throw new Error("stream closed");
        } catch {
          if (controller.signal.aborted) return;
          streamStatus.set("reconnecting");
          qc.invalidateQueries();
          attempt += 1;
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** Math.min(attempt - 1, 3), 10_000)));
        }
      }
    }
    run();
    return () => controller.abort();
  }, [qc, token]);
}
