import { useSyncExternalStore } from "react";

/*
  Light / dark theme. Light is the default because projectors wash out dark themes (brief, section 6).
  The choice is per browser (localStorage) and applied as <html data-theme="...">.
  Colours live in CSS variables (index.css); `token()` reads one for places that cannot use CSS
  variables directly, such as SVG attributes drawn by Leaflet and Recharts.
*/
export type Theme = "light" | "dark";
const KEY = "ct.theme";
const listeners = new Set<() => void>();

function stored(): Theme {
  try {
    return localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

let current: Theme = stored();
if (typeof document !== "undefined") document.documentElement.dataset.theme = current;

export function setTheme(next: Theme) {
  const apply = () => {
    document.documentElement.dataset.theme = next;
    current = next;
    listeners.forEach((l) => l());
  };
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* the theme still applies for this visit */
  }
  // One cross-fade of the whole page where the browser supports it; otherwise the colours change at once.
  // Animating every element's colours instead made pages with many cards lag.
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (doc.startViewTransition && !reduced) doc.startViewTransition(apply);
  else apply();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => current,
    () => "light",
  );
}

/** Current value of a colour variable from index.css, e.g. token("--ink"). */
export function token(name: string): string {
  if (typeof document === "undefined") return "#000";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#000";
}
