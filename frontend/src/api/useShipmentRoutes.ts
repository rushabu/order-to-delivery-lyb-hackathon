import { useQueries } from "@tanstack/react-query";
import { api } from "./client";
import type { RouteDetail } from "./contract";
import { keys } from "./queries";

/**
  Fetches every route a set of shipments needs on the map: active, planned, and the planned route's
  alternatives. Returns a lookup by route id (entries appear as they load).
*/
export function useRoutes(seedIds: (string | null | undefined)[]): Record<string, RouteDetail | undefined> {
  const base = [...new Set(seedIds.filter((x): x is string => !!x))];
  const first = useQueries({
    queries: base.map((id) => ({ queryKey: keys.route(id), queryFn: () => api<RouteDetail>(`/routes/${id}`), staleTime: Infinity, refetchInterval: false as const })),
  });
  const altIds = [...new Set(first.flatMap((q) => q.data?.alternatives.map((a) => a.alt_route_id) ?? []))].filter((id) => !base.includes(id));
  const alts = useQueries({
    queries: altIds.map((id) => ({ queryKey: keys.route(id), queryFn: () => api<RouteDetail>(`/routes/${id}`), staleTime: Infinity, refetchInterval: false as const })),
  });
  const out: Record<string, RouteDetail | undefined> = {};
  [...first, ...alts].forEach((q) => {
    if (q.data) out[q.data.id] = q.data;
  });
  return out;
}
