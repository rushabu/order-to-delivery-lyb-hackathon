import { z } from 'zod';
import { kmMarks, pointAtKm, projectToKm, type LngLat } from './geometry';

const HORIZON_KM = 20;
const MAX_OFF_ROUTE_KM = 0.12;
const CACHE_MS = 120_000;
const TOMTOM = 'https://api.tomtom.com/traffic/services';

const Point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const Flow = z.object({ flowSegmentData: z.object({
  currentSpeed: z.number().nonnegative(), freeFlowSpeed: z.number().nonnegative(), roadClosure: z.boolean(),
  coordinates: z.object({ coordinate: z.array(z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })).min(2) }),
}) });
const Incident = z.object({
  geometry: z.discriminatedUnion('type', [
    z.object({ type: z.literal('Point'), coordinates: Point }),
    z.object({ type: z.literal('LineString'), coordinates: z.array(Point).min(1) }),
  ]),
  properties: z.object({
    id: z.string(), iconCategory: z.number(), delay: z.number().nonnegative().nullish(),
    roadNumbers: z.array(z.string()).nullish(), events: z.array(z.object({ description: z.string().nullish() })).nullish(),
  }),
});
const CATEGORY: Record<number, string> = {
  1: 'Accident', 2: 'Fog', 3: 'Hazard', 4: 'Rain', 5: 'Ice', 6: 'Traffic jam', 7: 'Lane closed',
  8: 'Road closed', 9: 'Roadworks', 10: 'Strong wind', 11: 'Flooding', 14: 'Breakdown',
};

interface RouteGeometry {
  coordinates: LngLat[];
  chainage_km?: number[];
}

interface TrafficRoute {
  id: string;
  totalKm: number;
  geometry: RouteGeometry;
}

interface FlowSegment {
  coordinates: LngLat[];
  at_km: number;
  to_km: number;
  current_kph: number;
  free_flow_kph: number;
  condition: 'FLOWING' | 'SLOW' | 'HEAVY' | 'CLOSED';
}

interface RoadIncident {
  id: string;
  category: string;
  description: string | null;
  roads: string[];
  delay_min: number | null;
  at_km: number;
  location: LngLat;
}

interface Snapshot {
  route_id: string;
  fetched_at: string;
  to_km: number;
  flow_status: 'LIVE' | 'PARTIAL' | 'UNAVAILABLE';
  incidents_status: 'LIVE' | 'UNAVAILABLE';
  flow: FlowSegment[];
  incidents: RoadIncident[];
}

type Project = (point: LngLat) => { km: number; offKm: number };

/** A provider segment can extend past a junction. Draw only its forward overlap with our route. */
function matchFlow(line: LngLat[], project: Project, sampleKm: number) {
  const stretches: { coordinates: LngLat[]; from: number; to: number }[] = [];
  let stretch: (typeof stretches)[number] | undefined;
  for (const point of line) {
    const { km, offKm } = project(point);
    if (offKm > MAX_OFF_ROUTE_KM) { stretch = undefined; continue; }
    if (!stretch || km < stretch.to - 0.005) {
      stretch = { coordinates: [point], from: km, to: km };
      stretches.push(stretch);
    } else {
      stretch.coordinates.push(point);
      stretch.to = Math.max(stretch.to, km);
    }
  }
  return stretches.filter((span) => span.to - span.from >= 0.02 && sampleKm >= span.from - 0.25 && sampleKm <= span.to + 0.25)
    .sort((a, b) => b.to - b.from - (a.to - a.from))[0];
}

async function trafficJson(path: string, params: Record<string, string>, key: string): Promise<unknown> {
  const url = new URL(`${TOMTOM}${path}`);
  url.search = new URLSearchParams({ ...params, key }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`TomTom traffic returned HTTP ${response.status}`);
  return response.json();
}

/** Road conditions are scoped to the next 20 km and shared across viewers for two minutes. */
export class RoadConditions {
  private snapshots = new Map<string, { expires: number; pending: Promise<Snapshot> }>();

  constructor(private readonly key: string) {}

  async forRoute(route: TrafficRoute, progress: number) {
    const now = Date.now();
    for (const [id, entry] of this.snapshots) {
      if (entry.expires <= now) this.snapshots.delete(id);
    }
    let entry = this.snapshots.get(route.id);
    if (!entry) {
      entry = { expires: now + CACHE_MS, pending: this.load(route, progress) };
      this.snapshots.set(route.id, entry);
    }
    const { to_km, ...snapshot } = await entry.pending;
    return {
      ...snapshot,
      horizon_km: Math.max(0, Math.round((to_km - progress) * 10) / 10),
      flow: snapshot.flow.filter((segment) => segment.to_km >= progress),
      incidents: snapshot.incidents.filter((incident) => incident.at_km >= progress),
    };
  }

  private async load(route: TrafficRoute, progress: number): Promise<Snapshot> {
    const { coordinates, chainage_km } = route.geometry;
    const marks = kmMarks(coordinates, route.totalKm, chainage_km);
    const end = Math.min(progress + HORIZON_KM, route.totalKm);
    const length = end - progress;
    const at = (km: number) => pointAtKm(coordinates, route.totalKm, km, marks);
    const inside = (km: number) => km > progress && km < end;
    const window = [at(progress), ...coordinates.filter((_, index) => inside(marks[index])), at(end)];
    const windowMarks = [progress, ...marks.filter(inside), end];
    const project: Project = (point) => projectToKm(window, end, point, windowMarks);
    const bounds = window.reduce(([west, south, east, north], [lng, lat]) => [
      Math.min(west, lng), Math.min(south, lat), Math.max(east, lng), Math.max(north, lat),
    ], [180, 90, -180, -90]);
    const bbox = bounds.map((bound, index) => (bound + (index < 2 ? -0.003 : 0.003)).toFixed(5)).join(',');

    const flowRequests = (length < 2 ? [0.5] : [0.15, 0.5, 0.94]).map(async (part): Promise<FlowSegment | null> => {
      const sampleKm = progress + length * part;
      const [lng, lat] = at(sampleKm);
      const payload = Flow.parse(await trafficJson('/4/flowSegmentData/relative0/15/json', { point: `${lat},${lng}`, unit: 'KMPH' }, this.key)).flowSegmentData;
      const line: LngLat[] = payload.coordinates.coordinate.map(({ longitude, latitude }) => [longitude, latitude]);
      const overlap = matchFlow(line, project, sampleKm);
      if (!overlap || (!payload.freeFlowSpeed && !payload.roadClosure)) return null;
      const ratio = payload.freeFlowSpeed > 0 ? payload.currentSpeed / payload.freeFlowSpeed : 1;
      return { coordinates: overlap.coordinates, at_km: (overlap.from + overlap.to) / 2, to_km: overlap.to, current_kph: payload.currentSpeed,
        free_flow_kph: payload.freeFlowSpeed, condition: payload.roadClosure ? 'CLOSED' : ratio < 0.5 ? 'HEAVY' : ratio < 0.8 ? 'SLOW' : 'FLOWING' };
    });
    const incidentRequest = trafficJson('/5/incidentDetails', {
      bbox, timeValidityFilter: 'present', language: 'en-GB',
      fields: '{incidents{geometry{type,coordinates},properties{id,iconCategory,delay,roadNumbers,events{description}}}}',
    }, this.key).then((data) => z.object({ incidents: z.array(z.unknown()) }).parse(data).incidents.flatMap((raw): RoadIncident[] => {
      const incident = Incident.safeParse(raw);
      if (!incident.success) return [];
      const { geometry, properties: p } = incident.data;
      const positions = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
      const nearby = positions.map((location) => ({ ...projectToKm(coordinates, route.totalKm, location, marks), location }))
        .filter((point) => point.km >= progress && point.km <= end && point.offKm <= MAX_OFF_ROUTE_KM)
        .sort((a, b) => a.km - b.km)[0];
      if (!nearby) return [];
      return [{ id: p.id, category: CATEGORY[p.iconCategory] ?? 'Traffic incident', description: p.events?.[0]?.description ?? null,
        roads: p.roadNumbers ?? [], delay_min: p.delay == null ? null : Math.round(p.delay / 60), at_km: nearby.km, location: nearby.location }];
    }));

    const [flows, [incidents]] = await Promise.all([Promise.allSettled(flowRequests), Promise.allSettled([incidentRequest])]);
    const successful = flows.filter((flow) => flow.status === 'fulfilled');
    const segments = new Map<string, FlowSegment>();
    for (const { value } of successful) {
      if (value) segments.set(`${value.coordinates[0]}:${value.coordinates.at(-1)}`, value);
    }
    return { route_id: route.id, fetched_at: new Date(Date.now()).toISOString(), to_km: end,
      flow_status: successful.length === 0 ? 'UNAVAILABLE' : successful.length === flows.length ? 'LIVE' : 'PARTIAL',
      incidents_status: incidents.status === 'fulfilled' ? 'LIVE' : 'UNAVAILABLE',
      flow: [...segments.values()].sort((a, b) => a.at_km - b.at_km),
      incidents: incidents.status === 'fulfilled' ? incidents.value.sort((a, b) => a.at_km - b.at_km).slice(0, 12) : [],
    };
  }
}
