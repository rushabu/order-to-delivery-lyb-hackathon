import { z } from 'zod';
import type { LngLat } from '../shipments/geometry';
import type { ShipmentDraft } from './scenarios';

const Coordinate = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const Summary = z.object({
  lengthInMeters: z.number().positive(),
  travelTimeInSeconds: z.number().positive(),
  trafficDelayInSeconds: z.number().nonnegative(),
  noTrafficTravelTimeInSeconds: z.number().positive(),
  deviationPoint: Coordinate.optional(),
});
const Route = z.object({
  summary: Summary,
  legs: z.array(z.object({ points: z.array(Coordinate).min(2) })).min(1),
  sections: z.array(z.object({
    sectionType: z.string(),
    startPointIndex: z.number().int().nonnegative(),
    endPointIndex: z.number().int().nonnegative(),
    simpleCategory: z.string().optional(),
  })).default([]),
});

export interface TrafficSection {
  category: string;
  coordinates: LngLat[];
}

export interface TruckRoute {
  coordinates: LngLat[];
  distanceKm: number;
  driveMinutes: number;
  trafficMinutes: number;
  freeFlowMinutes: number;
  deviationPoint?: LngLat;
  sections: TrafficSection[];
}

const lngLat = (p: z.infer<typeof Coordinate>): LngLat => [p.longitude, p.latitude];

function parseRoute(route: z.infer<typeof Route>): TruckRoute {
  // TomTom section indices address the combined route geometry, with shared leg endpoints counted once.
  const coordinates = route.legs.flatMap((leg, index) => (index === 0 ? leg.points : leg.points.slice(1))).map(lngLat);
  return {
    coordinates,
    distanceKm: route.summary.lengthInMeters / 1000,
    driveMinutes: route.summary.travelTimeInSeconds / 60,
    trafficMinutes: Math.min(route.summary.trafficDelayInSeconds, route.summary.travelTimeInSeconds) / 60,
    freeFlowMinutes: route.summary.noTrafficTravelTimeInSeconds / 60,
    deviationPoint: route.summary.deviationPoint && lngLat(route.summary.deviationPoint),
    sections: route.sections
      .filter((s) => s.sectionType === 'TRAFFIC' && s.endPointIndex > s.startPointIndex && s.endPointIndex < coordinates.length)
      .map((s) => ({ category: s.simpleCategory ?? 'TRAFFIC', coordinates: coordinates.slice(s.startPointIndex, s.endPointIndex + 1) })),
  };
}

export async function calculateTruckRoutes(
  key: string,
  origin: LngLat,
  destination: LngLat,
  grossTonnes: number,
  vehicle: ShipmentDraft['vehicle'],
  supportingPoints?: LngLat[],
): Promise<TruckRoute[]> {
  const endpoint = (p: LngLat) => `${p[1]},${p[0]}`;
  const url = new URL(`https://api.tomtom.com/routing/1/calculateRoute/${endpoint(origin)}:${endpoint(destination)}/json`);
  url.search = new URLSearchParams({
    key,
    travelMode: 'truck',
    vehicleCommercial: 'true',
    vehicleWeight: String(Math.round(grossTonnes * 1000)),
    vehicleHeight: String(vehicle.height_m),
    vehicleWidth: String(vehicle.width_m),
    vehicleLength: String(vehicle.length_m),
    traffic: 'true',
    computeTravelTimeFor: 'all',
    sectionType: 'traffic',
    maxAlternatives: supportingPoints ? '0' : '1',
    ...(supportingPoints ? { reconstructionMode: 'strict' } : {}),
  }).toString();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    ...(supportingPoints ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supportingPoints: supportingPoints.map(([longitude, latitude]) => ({ latitude, longitude })) }),
    } : {}),
  });
  if (!response.ok) throw new Error(`TomTom returned HTTP ${response.status}`);
  const payload = z.object({ routes: z.array(Route).min(1) }).parse(await response.json());
  return payload.routes.map(parseRoute);
}
