import { API_BASE, isMocked } from "../lib/env";
import { getSession, setSession } from "../auth/session";
import { mockFetch } from "../mocks/server";
import type { InvoiceMeta } from "./contract";

/** An error from the API in the DESIGN.md 5.1 shape, or a network failure (status 0). */
export class ApiError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** fetch, or the in-browser mock for paths listed in VITE_USE_MOCKS. */
export function transport(path: string): typeof fetch {
  return isMocked(path) ? mockFetch : fetch.bind(window);
}

export function authHeaders(): Record<string, string> {
  const token = getSession()?.token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

interface Options {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, { method = "GET", body, signal }: Options = {}): Promise<T> {
  let res: Response;
  try {
    res = await transport(path)(`${API_BASE}${path}`, {
      method,
      signal,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "NETWORK", "Could not reach the server");
  }

  if (res.status === 401 && !path.startsWith("/auth/")) {
    setSession(null);
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `Request failed (${res.status})`, err?.details ?? {});
  }
  return data as T;
}

/** Same error handling as api(), for the two invoice calls that carry a file instead of JSON. */
async function fileCall(path: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await transport(path)(`${API_BASE}${path}`, { ...init, headers: { ...init.headers, ...authHeaders() } });
  } catch {
    throw new ApiError(0, "NETWORK", "Could not reach the server");
  }
  if (res.status === 401) setSession(null);
  if (!res.ok) {
    const err = (safeJson(await res.text()) as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `Request failed (${res.status})`);
  }
  return res;
}

/** POST /shipments/:id/invoice: the body is the PDF itself. */
export async function uploadInvoice(shipmentId: string, file: File): Promise<InvoiceMeta> {
  const path = `/shipments/${shipmentId}/invoice?filename=${encodeURIComponent(file.name)}`;
  const res = await fileCall(path, { method: "POST", headers: { "Content-Type": "application/pdf", Accept: "application/json" }, body: file });
  return (await res.json()) as InvoiceMeta;
}

/** GET /shipments/:id/invoice. A plain link cannot send the sign-in token, so the file is fetched and then saved. */
export async function downloadInvoice(shipmentId: string, filename: string): Promise<void> {
  const res = await fileCall(`/shipments/${shipmentId}/invoice`, { headers: { Accept: "application/pdf" } });
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
