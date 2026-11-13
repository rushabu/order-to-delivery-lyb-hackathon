import { useQuery } from "@tanstack/react-query";
import { Pause, Play, ArrowCounterClockwise } from "@phosphor-icons/react";
import { api } from "../../api/client";
import { useDemoCommand, useDemoState } from "../../api/queries";
import { Button, Card, CardHeader, ErrorNote, Loading, Skeleton } from "../../components/ui";
import { clockTz } from "../../lib/time";
import { ANY_MOCKS, isMocked } from "../../lib/env";
import { LiveRouteControls } from "./LiveRouteControls";

/* Demo controls (DESIGN.md 10.4): reset, start, pause and speed for the replay. Coordinator, demo mode only. */
const SPEEDS = [1, 60, 300, 600];
const STATUS_WORD: Record<string, string> = {
  IDLE: "Ready. Not started",
  RUNNING: "Running",
  PAUSED: "Paused",
  WAITING_FOR_PRESENTER: "Paused at a demo beat",
  FINISHED: "Finished",
};

export function DemoControls() {
  const state = useDemoState();
  const cmd = useDemoCommand();
  const d = state.data;
  const run = (path: string, body?: unknown) => cmd.mutate({ path, body });

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-6 sm:px-6">
      <h1 className="text-figure font-[750] tracking-[-0.025em]">Demo controls</h1>
      {!isMocked("/demo/live-route") && <LiveRouteControls />}
      {state.error && <ErrorNote what="the demo state" error={state.error} onRetry={() => state.refetch()} loadedAt={state.dataUpdatedAt || undefined} />}
      {cmd.error && <ErrorNote what="the demo command" error={cmd.error} onRetry={() => cmd.reset()} />}

      <Card aria-labelledby="clock-h">
        <CardHeader title="Replay clock" id="clock-h" />
        {!d ? (
          <Loading label="Loading demo state">
            <div className="p-5">
              <Skeleton className="h-10 w-48" />
            </div>
          </Loading>
        ) : (
          <div className="space-y-5 p-5">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
              <p className="tnum text-[3rem] font-semibold leading-none tracking-tight" aria-live="off">
                {clockTz(d.clock)}
              </p>
              <p className="text-lead text-ink-2" role="status">
                {STATUS_WORD[d.scenario_status] ?? d.scenario_status}
                {d.waiting_for ? `: ${d.waiting_for}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => run("/demo/reset")} disabled={cmd.isPending}>
                <ArrowCounterClockwise size={18} weight="bold" aria-hidden /> Reset to 08:50
              </Button>
              {d.scenario_status === "IDLE" ? (
                <Button variant="primary" onClick={() => run("/demo/scenarios/main/start")} disabled={cmd.isPending}>
                  <Play size={18} weight="bold" aria-hidden /> Start replay
                </Button>
              ) : d.paused ? (
                <Button variant="primary" onClick={() => run("/demo/clock", { paused: false, speed: d.speed })} disabled={cmd.isPending || d.scenario_status === "FINISHED"}>
                  <Play size={18} weight="bold" aria-hidden /> Resume
                </Button>
              ) : (
                <Button onClick={() => run("/demo/clock", { paused: true, speed: d.speed })} disabled={cmd.isPending}>
                  <Pause size={18} weight="bold" aria-hidden /> Pause
                </Button>
              )}
            </div>
            <fieldset>
              <legend className="text-meta font-medium text-muted">Speed</legend>
              <div className="mt-1 inline-flex rounded-md border border-line-strong">
                {SPEEDS.map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    aria-pressed={d.speed === sp}
                    onClick={() => run("/demo/clock", { paused: d.paused, speed: sp })}
                    className={`tnum h-10 min-w-16 px-3 text-body font-medium first:rounded-l-md last:rounded-r-md ${d.speed === sp ? "bg-accent text-on-accent" : "bg-surface text-ink-2 hover:bg-sunken"}`}
                  >
                    {sp}×
                  </button>
                ))}
              </div>
            </fieldset>
          </div>
        )}
      </Card>

      {ANY_MOCKS && isMocked("/demo/mock-controls") && <MockFailureControls />}
    </div>
  );
}

/* Mock only: switches that show the failure states in DESIGN.md 7.5 and 10.6 without a real outage. */
function MockFailureControls() {
  const controls = useQuery({
    queryKey: ["demo-state", "mock-controls"],
    queryFn: () => api<{ gps_paused: boolean; fail_driver_updates: boolean; drop_stream: boolean }>("/demo/mock-controls"),
  });
  const cmd = useDemoCommand();
  const c = controls.data;
  const toggles: { key: "gps_paused" | "fail_driver_updates" | "drop_stream"; label: string; help: string }[] = [
    { key: "gps_paused", label: "Stop positions from SHP-1001", help: "After 10 simulated minutes the marker greys out and confidence drops to Low; after 30 a tracking-lost alert is sent." },
    { key: "fail_driver_updates", label: "Fail driver updates", help: "Driver events fail with a network error and wait in the outbox, retrying with the same event id." },
    { key: "drop_stream", label: "Drop the live stream", help: "Screens show Reconnecting and refresh every 3 seconds." },
  ];
  return (
    <Card aria-labelledby="fail-h">
      <CardHeader title="Failure cases (mock API only)" id="fail-h" />
      <ul className="divide-y divide-line">
        {toggles.map((t) => (
          <li key={t.key} className="flex items-start gap-3 px-5 py-4">
            <input
              id={t.key}
              type="checkbox"
              className="mt-1 h-5 w-5 accent-[var(--color-accent)]"
              checked={!!c?.[t.key]}
              disabled={!c || cmd.isPending}
              onChange={(e) => cmd.mutate({ path: "/demo/mock-controls", body: { [t.key]: e.target.checked } })}
            />
            <label htmlFor={t.key} className="min-w-0">
              <span className="block text-body font-medium">{t.label}</span>
              <span className="block text-meta text-muted">{t.help}</span>
            </label>
          </li>
        ))}
      </ul>
    </Card>
  );
}
