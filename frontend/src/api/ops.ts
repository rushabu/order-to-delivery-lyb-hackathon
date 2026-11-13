import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, authHeaders, transport } from "./client";
import { API_BASE } from "../lib/env";

/*
  Driver operations: start-of-shift checks, stops and driving time, check-ins, delivery photo and
  invoice, trip log. Keys sit under ["shipment", id] so a stream hint for the shipment refreshes them.
*/

export interface DriverChecks { licence_at: string | null; voice_at: string | null; complete: boolean }
export type StopKind = "BREAK" | "FUEL" | "CHARGING" | "OTHER" | "UNPLANNED";
export interface Stop { id: string; kind: StopKind; source: "DRIVER" | "DETECTED"; started_at: string; ended_at: string | null; at_km: number | null }
export interface Driving { driving_min_since_break: number; limit_min: number; break_min: number; break_due_at: string | null; overdue: boolean; on_stop: Stop | null }
export interface Checkin { id: string; shipment_id: string; requested_by_name: string; requested_at: string; message: string | null; responded_at: string | null; response: "OK" | "PROBLEM" | null; response_note: string | null }
export interface DocumentMeta { id: string; shipment_id: string; kind: "DELIVERY_PHOTO"; mime: string; file_name: string; size_bytes: number; uploaded_by_name: string; uploaded_at: string; verified_by_name: string | null; verified_at: string | null }
export interface LogEntry { at: string; kind: "MILESTONE" | "DISRUPTION" | "STOP" | "CHECKIN" | "DOCUMENT" | "ALERT" | "DECISION"; title: string; detail: string | null; by: string | null }

const k = {
  checks: ["me-checks"] as const,
  driving: (id: string) => ["shipment", id, "driving"] as const,
  stops: (id: string) => ["shipment", id, "stops"] as const,
  checkins: (id: string) => ["shipment", id, "checkins"] as const,
  documents: (id: string) => ["shipment", id, "documents"] as const,
  log: (id: string) => ["shipment", id, "log"] as const,
  contact: (id: string) => ["shipment", id, "contact"] as const,
};

export const useDriverChecks = () => useQuery({ queryKey: k.checks, queryFn: ({ signal }) => api<DriverChecks>("/me/checks", { signal }), refetchInterval: false });
export const useDriving = (id?: string) => useQuery({ queryKey: k.driving(id ?? ""), enabled: !!id, queryFn: ({ signal }) => api<Driving>(`/shipments/${id}/driving`, { signal }), refetchInterval: 30_000 });
export const useStops = (id?: string) => useQuery({ queryKey: k.stops(id ?? ""), enabled: !!id, queryFn: ({ signal }) => api<Stop[]>(`/shipments/${id}/stops`, { signal }) });
export const useCheckins = (id?: string) => useQuery({ queryKey: k.checkins(id ?? ""), enabled: !!id, queryFn: ({ signal }) => api<Checkin[]>(`/shipments/${id}/checkins`, { signal }) });
export const useDocuments = (id?: string) => useQuery({ queryKey: k.documents(id ?? ""), enabled: !!id, queryFn: ({ signal }) => api<DocumentMeta[]>(`/shipments/${id}/documents`, { signal }) });
export const useTripLog = (id?: string) => useQuery({ queryKey: k.log(id ?? ""), enabled: !!id, queryFn: ({ signal }) => api<LogEntry[]>(`/shipments/${id}/log`, { signal }) });
export const useDriverContact = (id?: string) =>
  useQuery({ queryKey: k.contact(id ?? ""), enabled: !!id, staleTime: Infinity, refetchInterval: false, queryFn: ({ signal }) => api<{ name: string; phone: string | null }>(`/shipments/${id}/driver-contact`, { signal }) });

export function usePassCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: "LICENCE" | "VOICE") => api<DriverChecks>("/me/checks", { method: "POST", body: { kind } }),
    onSuccess: (data) => qc.setQueryData(k.checks, data),
  });
}

/** Any mutation on a shipment's operations: refresh everything under that shipment afterwards. */
function useShipmentMutation<V>(shipmentId: string, fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSettled: () => qc.invalidateQueries({ queryKey: ["shipment", shipmentId] }) });
}

export const useStartStop = (id: string) => useShipmentMutation(id, (kind: Exclude<StopKind, "UNPLANNED">) => api<Stop>(`/shipments/${id}/stops`, { method: "POST", body: { kind } }));
export const useEndStop = (id: string) => useShipmentMutation(id, (stopId: string) => api<Stop>(`/stops/${stopId}/end`, { method: "POST" }));
export const useRequestCheckin = (id: string) => useShipmentMutation(id, (message: string) => api<Checkin>(`/shipments/${id}/checkins`, { method: "POST", body: message ? { message } : {} }));
export const useAnswerCheckin = (id: string) =>
  useShipmentMutation(id, (v: { checkinId: string; response: "OK" | "PROBLEM"; note?: string }) => api<Checkin>(`/checkins/${v.checkinId}/respond`, { method: "POST", body: { response: v.response, note: v.note || undefined } }));
export const useVerifyDocument = (id: string) => useShipmentMutation(id, (docId: string) => api<DocumentMeta>(`/documents/${docId}/verify`, { method: "POST" }));
export const useUploadDocument = (id: string) =>
  useShipmentMutation(id, async (v: { kind: DocumentMeta["kind"]; file: Blob; fileName: string }) => {
    if (v.file.size > MAX_UPLOAD_BYTES) throw new Error("The file is larger than 5 MB");
    const data_base64 = await toBase64(v.file);
    return api<DocumentMeta>(`/shipments/${id}/documents`, { method: "POST", body: { kind: v.kind, mime: v.file.type, file_name: v.fileName, data_base64 } });
  });

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function toBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Could not read the file"));
    r.readAsDataURL(b);
  });
}

/** Fetches a stored file with the session token and returns an object URL (revoke it when done). */
export async function documentUrl(docId: string): Promise<string> {
  const path = `/documents/${docId}/file`;
  const res = await transport(path)(`${API_BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Could not load the file (${res.status})`);
  return URL.createObjectURL(await res.blob());
}

/** Shrinks a camera photo to at most 1600 px on the long side as JPEG, so uploads stay small. */
export async function compressPhoto(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not process the photo"))), "image/jpeg", 0.82));
}
