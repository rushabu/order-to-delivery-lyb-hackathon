import { Link } from "react-router";
import { CheckCircle, Hourglass, XCircle } from "@phosphor-icons/react";
import { useDecisions } from "../../api/queries";
import type { Decision } from "../../api/contract";
import { Card, EmptyState, ErrorNote, Loading, Skeleton } from "../../components/ui";
import { orderedOptions } from "../../components/OptionsTable";
import { clock, clockTz, duration as fmtDuration } from "../../lib/time";

/*
  Decision ledger (DESIGN.md 6.8, 7.2): one card per decision with the options considered, the option
  chosen, predicted and actual arrival, the simulated no-action arrival and the delay avoided.
*/
export function Ledger() {
  const decisions = useDecisions();
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      <h1 className="text-figure font-[750] tracking-[-0.025em]">Decision ledger</h1>
      <p className="mt-1 text-body text-muted">Every approved action, what it was predicted to do, and what happened. Times are IST.</p>
      {decisions.error && (
        <div className="mt-4">
          <ErrorNote what="the ledger" error={decisions.error} onRetry={() => decisions.refetch()} loadedAt={decisions.data ? decisions.dataUpdatedAt : undefined} />
        </div>
      )}
      <div className="mt-6 space-y-5">
        {decisions.isPending ? (
          <Loading label="Loading decisions">
            <Skeleton className="h-72 rounded-lg" />
          </Loading>
        ) : !decisions.data?.length ? (
          <Card>
            <EmptyState title="No decisions yet.">Approved actions appear here with their predicted and actual outcome.</EmptyState>
          </Card>
        ) : (
          decisions.data.map((d) => <LedgerCard key={d.id} d={d} />)
        )}
      </div>
    </div>
  );
}

function LedgerCard({ d }: { d: Decision }) {
  const o = d.outcome;
  const chosen = d.option_set?.options.find((x) => x.id === d.option_id);
  return (
    <Card as="article" aria-labelledby={`${d.id}-h`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 py-4">
        <h2 id={`${d.id}-h`} className="text-lead font-semibold">
          {d.id}:{" "}
          <Link to={`/coordinator/shipments/${d.shipment_id}`} className="link">
            {d.shipment_id}
          </Link>
        </h2>
        <p className="tnum text-meta text-muted">
          Approved {clockTz(d.decided_at)} by {d.decided_by}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-4">
        <Figure label="Predicted arrival" value={clock(d.predicted.chosen_eta)} />
        <Figure label="Actual arrival" value={o ? clock(o.actual_arrival) : "Not yet"} muted={!o} />
        <Figure label="With no action (simulated)" value={o?.counterfactual_no_action_arrival ? clock(o.counterfactual_no_action_arrival) : clock(d.predicted.no_action_eta)} note={o ? undefined : "predicted"} />
        <Figure label="Delay avoided" value={o && o.delay_avoided_min !== null ? `${o.delay_avoided_min} min` : "—"} strong />
      </div>

      <div className="space-y-4 p-5">
        <p className="text-body">
          <span className="font-semibold">Chosen:</span> {chosen?.label ?? d.option_type}
          {d.note ? <span className="text-ink-2"> Note: “{d.note}”</span> : null}
        </p>
        {o ? (
          <p className="tnum flex flex-wrap items-center gap-x-4 gap-y-1 text-body">
            <span className="inline-flex items-center gap-1.5 font-medium">
              {o.on_time_against_original_promise ? <CheckCircle size={18} weight="bold" aria-hidden className="text-low" /> : <XCircle size={18} weight="bold" aria-hidden className="text-high" />}
              {o.on_time_against_original_promise ? "On time against the original promise" : "Late against the original promise"}
            </span>
            <span className="text-ink-2">ETA error at decision time: {fmtDuration(o.eta_error_min)}</span>
            <span className="text-meta text-muted">Counterfactual: {o.counterfactual_kind === "SIMULATED" ? "simulation result" : "estimate"}</span>
          </p>
        ) : (
          <p className="inline-flex items-center gap-1.5 text-body text-ink-2">
            <Hourglass size={18} weight="bold" aria-hidden /> Outcome is recorded when the truck arrives.
          </p>
        )}

        {d.option_set && (
          <details className="group rounded-md border border-line">
            <summary className="cursor-pointer select-none px-4 py-2.5 text-body font-medium">Options considered ({d.option_set.options.length})</summary>
            <table className="tnum w-full border-t border-line text-body">
              <caption className="sr-only">Options considered for {d.id}</caption>
              <thead>
                <tr className="text-left text-meta text-muted">
                  <th scope="col" className="px-4 py-2 font-medium">Option</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Arrival</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Late by</th>
                </tr>
              </thead>
              <tbody>
                {orderedOptions(d.option_set).map((x) => (
                  <tr key={x.id} className="border-t border-line">
                    <th scope="row" className="px-4 py-2 text-left font-normal">
                      {x.label}
                      {x.id === d.option_id && <span className="ml-2 rounded-sm bg-accent-soft px-1.5 py-0.5 text-meta font-semibold text-accent-ink">Chosen</span>}
                      {x.id === d.option_set!.recommended_option_id && <span className="ml-2 text-meta text-muted">Recommended</span>}
                      {!x.feasible && <span className="block text-meta text-muted">Not available: {x.infeasible_reason}</span>}
                    </th>
                    <td className="py-2 pr-4">{x.feasible ? clock(x.projected_eta) : "—"}</td>
                    <td className="py-2 pr-4">{x.feasible ? (x.projected_late_min ? fmtDuration(x.projected_late_min) : "On time") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    </Card>
  );
}

function Figure({ label, value, note, muted, strong }: { label: string; value: string; note?: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="bg-surface px-5 py-4">
      <p className="text-meta text-muted">{label}</p>
      <p className={`wide tnum text-figure font-[800] ${muted ? "text-muted" : strong ? "text-accent-ink" : "text-ink"}`}>{value}</p>
      {note && <p className="text-meta text-muted">{note}</p>}
    </div>
  );
}
