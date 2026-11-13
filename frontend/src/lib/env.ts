/* Build-time settings. See .env.example. Nothing secret lives here: the bundle is public. */
export const API_URL: string = (import.meta.env.VITE_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
export const API_BASE = `${API_URL}/api/v1`;
export const DEMO_MODE: boolean = import.meta.env.VITE_DEMO_MODE === "true";

const mockSetting: string = (import.meta.env.VITE_USE_MOCKS ?? "").trim();

/** True when this API path should be served by the in-browser mock instead of the real API. */
export function isMocked(path: string): boolean {
  if (mockSetting === "true") return true;
  if (mockSetting === "" || mockSetting === "false") return false;
  return mockSetting
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .some((prefix) => path.startsWith(prefix));
}

export const ANY_MOCKS = mockSetting !== "" && mockSetting !== "false";
