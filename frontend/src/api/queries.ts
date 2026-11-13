import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, downloadInvoice, uploadInvoice } from "./client";
import { streamStatus } from "./stream";
import type {
  Alert, Decision, DecisionRequest, DelayCauseRow, DemoState, EtaSnapshot, ImpactMetrics, Notification, OnTimeRow,
  AssistantAnswer, AssistantStatus, ChatTurn, InvoiceMeta, NewOrderForm, OrderCreated, OrderDraft, OrderPlan, EvPreview, LiveDemoArea, LiveRouteSource, LiveRouteState, LiveRouteTrip, LiveShipmentDraft, OptionSet, RoadConditions, RouteDetail, RouteWeatherResponse, ShipmentDetail, ShipmentSummary,
} from "./contract";

/*
  One hook per endpoint. Components never call fetch directly.
  REST is the only source of data; the stream only tells us which of these keys to refetch (DESIGN.md 5.8).
  While the stream is down every visible query polls every 3 seconds.
*/
export const keys = {
  shipments: (filter = "") => ["shipments", filter] as const,
  shipment: (id: string) => ["shipment", id] as const,
  etaHistory: (id: string) => ["eta-history", id] as const,
  route: (id: string) => ["route", id] as const,
  alerts: ["alerts"] as const,
  options: (alertId: string) => ["options", alertId] as const,
  decisions: (shipmentId = "") => ["decisions", shipmentId] as const,
  notifications: ["notifications"] as const,
  onTime: (groupBy: string) => ["dashboard", "on-time", groupBy] as const,
  delayCauses: (groupBy: string) => ["dashboard", "delay-causes", groupBy] as const,
  impact: ["dashboard", "impact"] as const,
  demo: ["demo-state"] as const,
  weather: ["weather"] as const,
};

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 0,
        retry: 1,
        refetchOnWindowFocus: true,
        refetchInterval: () => (streamStatus.get() === "live" ? false : 3000),
        refetchIntervalInBackground: true,
      },
    },
  });
}

export const useShipments = (filter = "") =>
  useQuery({ queryKey: keys.shipments(filter), queryFn: ({ signal }) => api<ShipmentSummary[]>(`/shipments${filter ? `?${filter}` : ""}`, { signal }) });

export const useShipment = (id: string | undefined) =>
  useQuery({ queryKey: keys.shipment(id ?? ""), enabled: !!id, queryFn: ({ signal }) => api<ShipmentDetail>(`/shipments/${id}`, { signal }) });

export const useRoadConditions = (id: string, routeId: string, enabled: boolean) =>
  useQuery({ queryKey: ["road-conditions", id, routeId], enabled, staleTime: 120_000, refetchInterval: 120_000,
    refetchIntervalInBackground: false, queryFn: ({ signal }) => api<RoadConditions>(`/shipments/${id}/road-conditions`, { signal }) });

export const useEtaHistory = (id: string | undefined) =>
  useQuery({ queryKey: keys.etaHistory(id ?? ""), enabled: !!id, queryFn: ({ signal }) => api<EtaSnapshot[]>(`/shipments/${id}/eta-history`, { signal }) });

/** Route geometry never changes during a run, so it is fetched once. */
export const useRoute = (id: string | undefined | null) =>
  useQuery({ queryKey: keys.route(id ?? ""), enabled: !!id, staleTime: Infinity, refetchInterval: false, queryFn: ({ signal }) => api<RouteDetail>(`/routes/${id}`, { signal }) });

export const useAlerts = (enabled = true) =>
  useQuery({ queryKey: keys.alerts, enabled, queryFn: ({ signal }) => api<Alert[]>(`/alerts`, { signal }) });

export const useOptions = (alertId: string | undefined | null) =>
  useQuery({ queryKey: keys.options(alertId ?? ""), enabled: !!alertId, queryFn: ({ signal }) => api<OptionSet>(`/alerts/${alertId}/options`, { signal }) });

export const useDecisions = (shipmentId = "") =>
  useQuery({ queryKey: keys.decisions(shipmentId), queryFn: ({ signal }) => api<Decision[]>(`/decisions${shipmentId ? `?shipment_id=${shipmentId}` : ""}`, { signal }) });

export const useNotifications = () =>
  useQuery({ queryKey: keys.notifications, queryFn: ({ signal }) => api<Notification[]>(`/notifications`, { signal }) });

export const useOnTime = (groupBy: "route" | "transporter") =>
  useQuery({ queryKey: keys.onTime(groupBy), queryFn: ({ signal }) => api<OnTimeRow[]>(`/dashboard/on-time?group_by=${groupBy}`, { signal }) });

export const useDelayCauses = (groupBy: "route" | "transporter") =>
  useQuery({ queryKey: keys.delayCauses(groupBy), queryFn: ({ signal }) => api<DelayCauseRow[]>(`/dashboard/delay-causes?group_by=${groupBy}`, { signal }) });

export const useImpact = () =>
  useQuery({ queryKey: keys.impact, queryFn: ({ signal }) => api<ImpactMetrics>(`/metrics/impact`, { signal }) });

export const useDemoState = (enabled = true) =>
  useQuery({ queryKey: keys.demo, enabled, queryFn: ({ signal }) => api<DemoState>(`/demo/state`, { signal }) });

export const useLiveRouteState = () =>
  useQuery({ queryKey: [...keys.demo, "live-route"], queryFn: ({ signal }) => api<LiveRouteState>("/demo/live-route", { signal }) });

export function useGenerateLiveShipment() {
  return useMutation({ mutationFn: ({ area, seed }: { area: LiveDemoArea; seed?: number }) =>
    api<LiveShipmentDraft>(`/demo/live-route/generate?area=${area}${seed === undefined ? "" : `&seed=${seed}`}`) });
}

export function useStartLiveShipment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LiveRouteSource & { request_id: string }) => api<LiveRouteTrip>("/demo/live-route/start", { method: "POST", body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...keys.demo, "live-route"] });
      qc.invalidateQueries({ queryKey: ["shipments"] });
      qc.invalidateQueries({ queryKey: keys.weather });
    },
  });
}

export function useEvPreview() {
  return useMutation({ mutationFn: (body: LiveRouteSource & { start_charge_pct: number }) =>
    api<EvPreview>("/demo/live-route/ev-preview", { method: "POST", body }) });
}

/** Real-world forecast: the backend caches it for 15 minutes, so polling every 5 minutes is plenty. */
export const useRouteWeather = () =>
  useQuery({ queryKey: keys.weather, staleTime: 5 * 60_000, refetchInterval: 5 * 60_000, queryFn: ({ signal }) => api<RouteWeatherResponse>(`/weather/routes`, { signal }) });

export const useNewOrderForm = (enabled: boolean) =>
  useQuery({ queryKey: ["order-form"], enabled, queryFn: ({ signal }) => api<NewOrderForm>("/orders/new", { signal }) });

/** Candidate trucks for an order. Changes nothing on the server. */
export function usePlanOrder() {
  return useMutation({ mutationFn: (body: OrderDraft) => api<OrderPlan>("/orders/plan", { method: "POST", body }) });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: OrderDraft & { option_id: string }) => api<OrderCreated>("/orders", { method: "POST", body }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["shipments"] });
      qc.invalidateQueries({ queryKey: keys.shipment(r.shipment_id) });
    },
  });
}

export function useUploadInvoice(shipmentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadInvoice(shipmentId, file),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.shipment(shipmentId) }),
  });
}

/** The API builds the PDF from the shipment data and the fictional rates in the seed. */
export function useGenerateInvoice(shipmentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<InvoiceMeta>(`/shipments/${shipmentId}/invoice/generate`, { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.shipment(shipmentId) }),
  });
}

export function useDownloadInvoice(shipmentId: string) {
  return useMutation({ mutationFn: (filename: string) => downloadInvoice(shipmentId, filename) });
}

/** Is the assistant switched on? Asked once when the chat panel first opens. */
export const useAssistantStatus = (enabled: boolean) =>
  useQuery({ queryKey: ["assistant"], enabled, staleTime: Infinity, queryFn: ({ signal }) => api<AssistantStatus>("/assistant", { signal }) });

export function useAskAssistant() {
  return useMutation({ mutationFn: (body: { question: string; history: ChatTurn[] }) => api<AssistantAnswer>("/assistant/ask", { method: "POST", body }) });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.notifications }),
  });
}

export function useApproveDecision(shipmentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: DecisionRequest) => api<Decision>(`/shipments/${shipmentId}/decisions`, { method: "POST", body: req }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.shipment(shipmentId) });
      qc.invalidateQueries({ queryKey: keys.etaHistory(shipmentId) });
      qc.invalidateQueries({ queryKey: ["shipments"] });
      qc.invalidateQueries({ queryKey: keys.alerts });
      qc.invalidateQueries({ queryKey: ["options"] });
      qc.invalidateQueries({ queryKey: ["decisions"] });
    },
  });
}

export function useDemoCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api<unknown>(path, { method: "POST", body }),
    onSettled: () => qc.invalidateQueries(),
  });
}
