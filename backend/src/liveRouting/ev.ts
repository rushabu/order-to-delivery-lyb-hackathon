import { z } from 'zod';
import { ApiError } from '../http/errors';
import type { DemoLane, ShipmentDraft } from './scenarios';

// Fictional profile for the demo van carrying the selected Mumbai shipment.
const BATTERY_KWH = 40;
const RESERVE_PCT = 20;
const CHARGING_MODES = [{
  chargingConnections: ['Charge_Direct_Current_at_50kW', 'Charge_Direct_Current_above_50kW']
    .map((facilityType) => ({ facilityType, plugType: 'Combo_to_IEC_62196_Type_2_Base' })),
  chargingCurve: [
    { chargeInkWh: 24, timeToChargeInSeconds: 1728 },
    { chargeInkWh: 32, timeToChargeInSeconds: 2528 },
    { chargeInkWh: BATTERY_KWH, timeToChargeInSeconds: 4448 },
  ],
}];

const EvRoutes = z.object({ routes: z.array(z.object({
  summary: z.object({
    lengthInMeters: z.number().positive(),
    travelTimeInSeconds: z.number().nonnegative(),
    totalChargingTimeInSeconds: z.number().nonnegative().optional(),
    batteryConsumptionInkWh: z.number(),
    remainingChargeAtArrivalInkWh: z.number().min(0).max(BATTERY_KWH),
  }),
  legs: z.array(z.object({ summary: z.object({
    chargingInformationAtEndOfLeg: z.object({
      chargingParkName: z.string().optional(),
      chargingParkOperatorName: z.string().optional(),
      chargingTimeInSeconds: z.number().nonnegative(),
    }).optional(),
  }) })),
})).min(1) });
const ProviderError = z.object({ detailedError: z.object({ code: z.string() }) });

export async function previewEvRoute(key: string, lane: DemoLane, draft: ShipmentDraft, startChargePct: number) {
  const [fromLng, fromLat] = lane.origin;
  const [toLng, toLat] = lane.destination;
  const url = new URL(`https://api.tomtom.com/routing/1/calculateLongDistanceEVRoute/${fromLat},${fromLng}:${toLat},${toLng}/json`);
  url.search = new URLSearchParams({
    key, traffic: 'true', travelMode: 'van', vehicleEngineType: 'electric', vehicleCommercial: 'true',
    vehicleWeight: String(Math.round(draft.gross_t * 1000)),
    vehicleHeight: String(draft.vehicle.height_m), vehicleWidth: String(draft.vehicle.width_m), vehicleLength: String(draft.vehicle.length_m),
    currentChargeInkWh: String(startChargePct * BATTERY_KWH / 100),
    maxChargeInkWh: String(BATTERY_KWH),
    minChargeAtDestinationInkWh: String(RESERVE_PCT * BATTERY_KWH / 100),
    minChargeAtChargingStopsInkWh: '2',
    constantSpeedConsumptionInkWhPerHundredkm: '20,21:40,23:60,27:80,33:100,42',
    auxiliaryPowerInkW: '0.8',
    routeRepresentation: 'summaryOnly',
  }).toString();

  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chargingModes: CHARGING_MODES }), signal: AbortSignal.timeout(8000),
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      const error = ProviderError.safeParse(data);
      if (error.success && error.data.detailedError.code === 'NO_ROUTE_FOUND') {
        throw new ApiError(422, 'EV_NO_ROUTE', 'TomTom found no EV route with that charge and reserve. Try a higher starting charge');
      }
      throw new Error('EV provider request failed');
    }
    const [{ summary, legs }] = EvRoutes.parse(data).routes;
    const stops = legs.flatMap(({ summary: leg }) => {
      const stop = leg.chargingInformationAtEndOfLeg;
      return stop ? [{ name: stop.chargingParkName || stop.chargingParkOperatorName || null,
        charging_min: Math.ceil(stop.chargingTimeInSeconds / 60) }] : [];
    });
    return {
      distance_km: Math.round(summary.lengthInMeters / 100) / 10,
      travel_min: Math.ceil(summary.travelTimeInSeconds / 60),
      charging_min: Math.ceil((summary.totalChargingTimeInSeconds ?? 0) / 60),
      consumption_kwh: Math.round(summary.batteryConsumptionInkWh * 10) / 10,
      arrival_charge_pct: Math.round(summary.remainingChargeAtArrivalInkWh / BATTERY_KWH * 100),
      reserve_pct: RESERVE_PCT,
      battery_kwh: BATTERY_KWH,
      stops,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'EV_ROUTING_UNAVAILABLE', 'TomTom could not calculate the EV preview. Check EV Routing access for the server key and try again');
  }
}
