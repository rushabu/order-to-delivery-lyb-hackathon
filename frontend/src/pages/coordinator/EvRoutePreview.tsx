import { useState } from "react";
import type { LiveRouteSource } from "../../api/contract";
import { useEvPreview } from "../../api/queries";
import { Button, ErrorNote, KeyValue } from "../../components/ui";

export function EvRoutePreview({ source, unloadMinutes }: { source: LiveRouteSource; unloadMinutes: number }) {
  const [charge, setCharge] = useState("60");
  const preview = useEvPreview();
  const data = preview.data;
  const percent = Number(charge);
  const valid = Number.isInteger(percent) && percent >= 5 && percent <= 100;
  const calculate = () => preview.mutate({ ...source, start_charge_pct: percent });

  return (
    <details className="rounded-md border border-line bg-surface px-3 py-2">
      <summary className="cursor-pointer text-body font-semibold text-ink">Preview electric van</summary>
      <div className="mt-3 space-y-3">
        <p className="text-meta text-muted">Pre-dispatch estimate from TomTom for a fictional electric delivery van.</p>
        <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (valid && !preview.isPending) calculate();
        }}>
          <label className="grid gap-1 text-meta font-medium" htmlFor="ev-start-charge">
            Starting charge (%)
            <input id="ev-start-charge" type="number" min={5} max={100} step={1} required value={charge}
              disabled={preview.isPending} onChange={(event) => { setCharge(event.target.value); preview.reset(); }}
              className="h-10 w-32 rounded-md border border-line bg-surface px-2 text-body" />
          </label>
          <Button type="submit" disabled={!valid || preview.isPending}>
            {preview.isPending ? "Checking EV route…" : "Check EV route"}
          </Button>
        </form>
        {preview.error && <ErrorNote what="the EV route" error={preview.error} onRetry={calculate} />}
        {data && <div aria-live="polite" className="space-y-2">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <KeyValue label="Charge on arrival">{data.arrival_charge_pct}%</KeyValue>
            <KeyValue label="Energy for trip">{data.consumption_kwh} kWh</KeyValue>
            <KeyValue label="Route distance">{data.distance_km} km</KeyValue>
            <KeyValue label="Estimated delivery in">{data.travel_min + unloadMinutes} min</KeyValue>
            <KeyValue label="Charging time">{data.charging_min} min</KeyValue>
            <KeyValue label="Arrival reserve">{data.reserve_pct}%</KeyValue>
          </dl>
          <p className="text-meta text-muted">{data.battery_kwh} kWh demo battery. The delivery estimate includes driving, charging, and {unloadMinutes} min for unloading.</p>
          {data.stops.length > 0 ? (
            <ul className="list-inside list-disc text-meta text-ink-2" aria-label="Planned charging stops">
              {data.stops.map((stop, index) => <li key={index}>{stop.name ?? "Charging stop"} · {stop.charging_min} min</li>)}
            </ul>
          ) : <p className="text-meta text-ink-2">No charging stop needed for this trip.</p>}
        </div>}
      </div>
    </details>
  );
}
