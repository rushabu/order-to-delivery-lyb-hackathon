import { useState } from "react";
import { Link } from "react-router";
import type { LiveDemoArea, LiveShipmentDraft } from "../../api/contract";
import { useGenerateLiveShipment, useLiveRouteState, useStartLiveShipment } from "../../api/queries";
import { Button, Card, CardHeader, ErrorNote, KeyValue, StatusTag } from "../../components/ui";
import { EvRoutePreview } from "./EvRoutePreview";

const cargoWeight = (tonnes: number) => tonnes < 1 ? `${Math.round(tonnes * 1000)} kg` : `${tonnes} t`;

export function LiveRouteControls() {
  const state = useLiveRouteState();
  const generate = useGenerateLiveShipment();
  const start = useStartLiveShipment();
  const [selection, setSelection] = useState<LiveShipmentDraft>();
  const [seedInput, setSeedInput] = useState("");
  const [area, setArea] = useState<LiveDemoArea>("mumbai");
  const presets = state.data?.presets ?? [];
  const draft = selection ?? presets[0];
  const source = draft && (draft.preset_id !== null ? { preset_id: draft.preset_id } : { seed: draft.seed!, area: draft.area });
  const seed = seedInput === "" ? undefined : Number(seedInput);
  const seedValid = seed === undefined || (Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff);
  const busy = start.isPending || generate.isPending;

  function preview() {
    start.reset();
    generate.mutate({ area, seed }, { onSuccess: setSelection });
  }

  function launch() {
    if (!source) return;
    const requestId = start.isError ? start.variables?.request_id : undefined;
    start.mutate({ request_id: requestId ?? crypto.randomUUID(), ...source });
  }

  return (
    <Card aria-labelledby="live-route-h">
      <CardHeader title="Live routing demo" id="live-route-h" />
      <div className="space-y-4 p-5">
        <p className="text-body text-ink-2">Start a fictional shipment with live traffic and a simulated vehicle that moves at real-time pace.</p>
        {state.isPending && <p className="text-meta text-muted">Checking routing setup…</p>}
        {state.error && <ErrorNote what="routing setup" error={state.error} onRetry={() => state.refetch()} />}
        {draft && <>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="grid gap-1 text-meta font-medium" htmlFor="live-preset">
              Shipment preset
              <select id="live-preset" value={draft.preset_id ?? ""} disabled={busy} className="h-10 rounded-md border border-line bg-surface px-2 text-body"
                onChange={(event) => { setSelection(presets.find((item) => item.preset_id === event.target.value)); start.reset(); generate.reset(); }}>
                {draft.seed !== null && <option value="" disabled>Generated shipment</option>}
                {presets.map((item) => <option key={item.preset_id} value={item.preset_id!}>{item.lane} · {cargoWeight(item.quantity_t)}</option>)}
              </select>
            </label>
            <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (seedValid && !busy) preview(); }}>
              <label className="grid gap-1 text-meta font-medium" htmlFor="live-area">
                Generator area
                <select id="live-area" value={area} disabled={busy} onChange={(event) => setArea(event.target.value as LiveDemoArea)}
                  className="h-10 rounded-md border border-line bg-surface px-2 text-body">
                  <option value="mumbai">Mumbai</option>
                  <option value="regional">Regional</option>
                </select>
              </label>
              <label className="grid gap-1 text-meta font-medium" htmlFor="live-seed">
                Seed (optional)
                <input id="live-seed" type="number" min={0} max={0xffffffff} step={1} placeholder="Random" value={seedInput} disabled={busy}
                  onChange={(event) => setSeedInput(event.target.value)} className="h-10 w-32 rounded-md border border-line bg-surface px-2 text-body" />
              </label>
              <Button type="submit" disabled={!seedValid || busy}>{generate.isPending ? "Generating…" : "Generate shipment"}</Button>
            </form>
          </div>
          <div className="rounded-md border border-line bg-raised p-3">
            <p className="text-body font-semibold">{draft.lane} {draft.seed !== null && <span className="text-meta font-normal text-muted">· Seed {draft.seed}</span>}</p>
            <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <KeyValue label="Customer">{draft.customer_name}</KeyValue>
              <KeyValue label="Cargo">{cargoWeight(draft.quantity_t)} {draft.product}</KeyValue>
              <KeyValue label="Truck">{draft.vehicle.label} · {draft.gross_t} t gross</KeyValue>
              <KeyValue label="Planned stop">{draft.stop_min} min</KeyValue>
              <KeyValue label="Promise buffer">{draft.promise_buffer_min} min</KeyValue>
            </dl>
          </div>
          {generate.error && <ErrorNote what="the shipment preview" error={generate.error} onRetry={preview} />}
          {start.error && <ErrorNote what="the truck route" error={start.error} onRetry={() => { if (start.variables) start.mutate(start.variables); }} />}
          {state.data?.configured ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" disabled={busy || state.data.available_drivers === 0} onClick={launch}>
                {start.isPending ? "Calculating truck route…" : "Start live shipment"}
              </Button>
              <p className="text-meta text-muted">Demo drivers available · {state.data.available_drivers}</p>
            </div>
          ) : <p className="text-meta text-muted">Set TOMTOM_API_KEY on the API server and restart it to start a live shipment.</p>}
          {state.data?.configured && draft.area === "mumbai" && source && (
            <EvRoutePreview key={draft.preset_id ?? draft.seed} source={source} unloadMinutes={draft.stop_min} />
          )}
        </>}
        {state.data && !presets.length && <p className="text-meta text-muted">Start the API with the full database seed to use live routing.</p>}
        {!!state.data?.shipments.length && <ul className="divide-y divide-line border-t border-line">
          {state.data.shipments.map((trip) => (
            <li key={trip.shipment_id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div>
                <Link className="link text-body font-semibold" to={`/coordinator/shipments/${trip.shipment_id}`}>{trip.draft.lane}</Link>
                <p className="text-meta text-muted">{cargoWeight(trip.draft.quantity_t)} {trip.draft.product} · {trip.driver_name}{trip.draft.seed !== null && ` · Seed ${trip.draft.seed}`}</p>
              </div>
              <StatusTag status={trip.status} />
            </li>
          ))}
        </ul>}
      </div>
    </Card>
  );
}
