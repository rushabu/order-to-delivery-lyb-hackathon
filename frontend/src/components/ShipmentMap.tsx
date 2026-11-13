import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import type { LiveTraffic, RoadConditions, RouteDetail } from "../api/contract";
import { prefersReducedMotion } from "../lib/motion";
import { token, useTheme } from "../lib/theme";

/*
  Leaflet map with OpenStreetMap tiles. Routes and markers come only from API data (GeoJSON).
  - If tiles fail to load, routes and markers still draw on a plain background and a note says so.
  - Markers glide between positions over ~0.9 s (one replay tick at 60x), never jump; reduced motion jumps.
  - The map is never the only source: every page shows the same positions as text (DESIGN.md 7.6).
*/

export type RouteStyle = "active" | "alternative" | "previous";
export interface MapRoute {
  route: RouteDetail;
  style: RouteStyle;
  /** Animate the line drawing in, used once when a reroute is approved. */
  drawIn?: boolean;
}
export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  stale?: boolean;
  emphasis?: boolean;
}

export const FLOW_STYLE = {
  FLOWING: { label: "Flowing", tone: "--low" },
  SLOW: { label: "Slow", tone: "--medium" },
  HEAVY: { label: "Heavy", tone: "--high" },
  CLOSED: { label: "Closed", tone: "--ink" },
};

/** Route styles read the theme's colours at draw time (SVG attributes cannot use CSS variables). */
function lineStyle(style: RouteStyle): L.PolylineOptions {
  if (style === "active") return { color: token("--accent-ink"), weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round" };
  if (style === "alternative") return { color: token("--ink-2"), weight: 4, opacity: 0.8, dashArray: "1 9", lineCap: "round" };
  return { color: token("--ink-2"), weight: 4, opacity: 0.55, dashArray: "10 8" };
}

function markerIcon(m: MapMarker) {
  // The truck in focus is marker yellow with an asphalt glyph, like paint on the road.
  const fill = m.stale ? token("--line-strong") : m.emphasis ? token("--accent") : token("--ink-2");
  const glyph = m.emphasis && !m.stale ? "#1b2230" : token("--raised");
  const ring = m.stale ? "stroke-dasharray:3 2;" : "";
  return L.divIcon({
    className: "",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `<svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <circle cx="14" cy="14" r="11" fill="${fill}" stroke="${m.emphasis && !m.stale ? "#1b2230" : token("--raised")}" stroke-width="3" style="${ring}"/>
      <path d="M9 15h6v-4h2l2 3v1h-1M9 15v-4h6" stroke="${glyph}" stroke-width="1.6" fill="none" stroke-linejoin="round"/>
    </svg>`,
  });
}

export function ShipmentMap({
  routes,
  markers,
  traffic,
  roadConditions,
  focusRouteIds,
  label,
  className = "h-[420px]",
}: {
  routes: MapRoute[];
  markers: MapMarker[];
  traffic?: LiveTraffic;
  roadConditions?: RoadConditions;
  /** Fit the view to these routes when they change. */
  focusRouteIds?: string[];
  label: string;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const routeLayer = useRef<L.LayerGroup | null>(null);
  const markerRefs = useRef(new Map<string, { marker: L.Marker; anim: number | null; latlng: L.LatLng }>());
  const [tilesFailed, setTilesFailed] = useState(false);
  const theme = useTheme();
  const fitted = useRef("");

  // Create the map once.
  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, scrollWheelZoom: false, attributionControl: true, keyboard: true });
    m.setView([18.9, 73.4], 9);
    let loaded = 0;
    let failed = 0;
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    })
      .on("tileload", () => {
        loaded += 1;
        setTilesFailed(false);
      })
      .on("tileerror", () => {
        failed += 1;
        if (failed > 2 && loaded === 0) setTilesFailed(true);
      })
      .addTo(m);
    routeLayer.current = L.layerGroup().addTo(m);
    m.createPane("road-conditions").style.zIndex = "415";
    map.current = m;
    const markersMap = markerRefs.current;
    return () => {
      markersMap.forEach((v) => v.anim && cancelAnimationFrame(v.anim));
      markersMap.clear();
      m.remove();
      map.current = null;
    };
  }, []);

  // Routes
  const routeKey = theme + routes.map((r) => `${r.route.id}:${r.style}:${r.drawIn ? 1 : 0}`).join("|");
  useEffect(() => {
    const layer = routeLayer.current;
    if (!layer) return;
    layer.clearLayers();
    // Draw alternatives and previous routes underneath the active one.
    const order: RouteStyle[] = ["previous", "alternative", "active"];
    for (const style of order) {
      for (const r of routes.filter((x) => x.style === style)) {
        const latlngs = r.route.geometry.coordinates.map(([lng, lat]) => L.latLng(lat, lng));
        const line = L.polyline(latlngs, { ...lineStyle(style), interactive: false }).addTo(layer);
        if (r.drawIn && !prefersReducedMotion()) {
          const path = line.getElement() as SVGPathElement | undefined;
          if (path) {
            const length = Math.ceil(path.getTotalLength());
            path.style.strokeDasharray = `${length}`;
            path.style.setProperty("--route-length", `${length}`);
            path.classList.add("route-draw");
            path.addEventListener("animationend", () => (path.style.strokeDasharray = ""), { once: true });
          }
        }
      }
    }
    for (const section of traffic?.sections ?? []) {
      const points = section.coordinates.map(([lng, lat]) => L.latLng(lat, lng));
      L.polyline(points, { color: token("--medium"), weight: 7, opacity: 0.9, dashArray: "8 4", interactive: false }).addTo(layer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, traffic?.sections]);

  useEffect(() => {
    const m = map.current;
    if (!m || !roadConditions) return;
    const layer = L.layerGroup().addTo(m);
    for (const segment of roadConditions.flow) {
      L.polyline(segment.coordinates.map(([lng, lat]) => L.latLng(lat, lng)), {
        pane: "road-conditions", className: "ct-road-flow", color: token(FLOW_STYLE[segment.condition].tone), weight: 7,
        dashArray: segment.condition === "CLOSED" ? "5 4" : undefined, interactive: false,
      }).addTo(layer);
    }
    for (const incident of roadConditions.incidents) {
      const [lng, lat] = incident.location;
      const tooltip = document.createElement("span");
      tooltip.textContent = incident.category;
      L.circleMarker([lat, lng], { pane: "road-conditions", className: "ct-road-incident", radius: 7,
        color: token("--surface"), fillColor: token("--high"), fillOpacity: 1, weight: 2,
      }).bindTooltip(tooltip).addTo(layer);
    }
    m.attributionControl.addAttribution("Traffic &copy; TomTom");
    return () => { layer.remove(); m.attributionControl.removeAttribution("Traffic &copy; TomTom"); };
  }, [roadConditions, theme]);

  // Fit to the focused routes when the focus changes (not on every position update).
  const focusKey = (focusRouteIds ?? routes.map((r) => r.route.id)).join(",");
  useEffect(() => {
    const m = map.current;
    if (!m || !routes.length || fitted.current === focusKey) return;
    const ids = focusKey.split(",");
    const pts = routes.filter((r) => ids.includes(r.route.id)).flatMap((r) => r.route.geometry.coordinates.map(([lng, lat]) => L.latLng(lat, lng)));
    if (!pts.length) return;
    m.fitBounds(L.latLngBounds(pts), { padding: [28, 28], animate: fitted.current !== "" && !prefersReducedMotion() });
    fitted.current = focusKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, routes.length]);

  // Markers: create, glide to new positions, remove.
  const markerKey = theme + markers.map((m) => `${m.id}:${m.lat.toFixed(5)}:${m.lng.toFixed(5)}:${m.stale ? 1 : 0}:${m.emphasis ? 1 : 0}:${m.label}`).join("|");
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const mk of markers) {
      seen.add(mk.id);
      const target = L.latLng(mk.lat, mk.lng);
      const existing = markerRefs.current.get(mk.id);
      if (!existing) {
        const marker = L.marker(target, { icon: markerIcon(mk), keyboard: false, title: mk.label, alt: mk.label })
          .bindTooltip(mk.label, { permanent: true, direction: "right", offset: [14, 0], className: "ct-map-label" })
          .addTo(m);
        markerRefs.current.set(mk.id, { marker, anim: null, latlng: target });
        continue;
      }
      existing.marker.setIcon(markerIcon(mk));
      existing.marker.setTooltipContent(mk.label);
      if (existing.anim) cancelAnimationFrame(existing.anim);
      const from = existing.marker.getLatLng();
      if (prefersReducedMotion() || from.distanceTo(target) > 40_000) {
        existing.marker.setLatLng(target);
        continue;
      }
      const start = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - start) / 900);
        existing.marker.setLatLng(L.latLng(from.lat + (target.lat - from.lat) * k, from.lng + (target.lng - from.lng) * k));
        existing.anim = k < 1 ? requestAnimationFrame(step) : null;
      };
      existing.anim = requestAnimationFrame(step);
    }
    for (const [id, v] of markerRefs.current) {
      if (!seen.has(id)) {
        if (v.anim) cancelAnimationFrame(v.anim);
        v.marker.remove();
        markerRefs.current.delete(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerKey]);

  return (
    <div className="relative overflow-hidden rounded-lg border border-line">
      <div ref={el} className={`ct-map ${className}`} role="region" aria-label={label} />
      {tilesFailed && (
        <p role="status" className="absolute left-3 top-3 z-[500] rounded-sm border border-line bg-surface px-2 py-1 text-meta text-ink-2">
          Map background unavailable. Routes and positions are still shown.
        </p>
      )}
    </div>
  );
}
