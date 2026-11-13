import { useEffect, useRef, useState } from "react";
import { ArrowsClockwise, CheckCircle, Info } from "@phosphor-icons/react";
import { useApproveDecision, useDecisions, useOptions } from "../api/queries";
import { ApiError } from "../api/client";
import type { DecisionOption, ShipmentDetail } from "../api/contract";
import { clockTz } from "../lib/time";
import { Card, CardHeader, ErrorNote, Loading, Skeleton } from "./ui";
import { OptionsTable } from "./OptionsTable";
import { ApprovalDialog, type ApproveOutcome } from "./ApprovalDialog";
import { useToast } from "./Toasts";

const RESCHEDULE_ONLY =
  "No available action brings this shipment back on time. Recommended: agree a new delivery time and inform the customer now.";

/*
  Suggested actions for a shipment with an open alert, and the decision once one is made.
  Stale options (DESIGN.md 7.5): if the API answers OPTIONS_STALE, or the option set changes while
  the coordinator is looking at it, we say "The situation changed. Options refreshed." and reload.
*/
export function OptionsSection({ shipment }: { shipment: ShipmentDetail }) {
  const alertId = shipment.open_alert?.id ?? null;
  const options = useOptions(alertId);
  const decisions = useDecisions(shipment.id);
  const approve = useApproveDecision(shipment.id);
  const toast = useToast();
  const [chosen, setChosen] = useState<DecisionOption | null>(null);
  const [staleNotice, setStaleNotice] = useState(false);
  const lastSetId = useRef<string | null>(null);

  const set = options.data;
  // Compare only option sets fetched while this page is open; a cached set from an earlier visit
  // being replaced on arrival is not news to the coordinator.
  const fresh = options.isFetchedAfterMount;
  useEffect(() => {
    if (!set || !fresh) return;
    if (lastSetId.current && lastSetId.current !== set.id) {
      setStaleNotice(true);
      setChosen(null);
    }
    lastSetId.current = set.id;
  }, [set, fresh]);

  const latestDecision = decisions.data?.[0];

  if (!alertId) {
    if (!latestDecision) return null;
    return (
      <Card aria-labelledby="decision-h">
        <CardHeader title="Decision" id="decision-h" />
        <div className="flex items-start gap-3 p-5">
          <CheckCircle size={22} weight="bold" aria-hidden className="mt-0.5 shrink-0 text-low" />
          <div className="tnum text-body">
            <p className="font-semibold">
              {latestDecision.id}: {latestDecision.option_set?.options.find((o) => o.id === latestDecision.option_id)?.label ?? latestDecision.option_type}
            </p>
            <p className="text-ink-2">
              Approved {clockTz(latestDecision.decided_at)}. Predicted arrival {clockTz(latestDecision.predicted.chosen_eta)}; with no action {clockTz(latestDecision.predicted.no_action_eta)}.
            </p>
            {latestDecision.note && <p className="mt-1 text-ink-2">Note: {latestDecision.note}</p>}
          </div>
        </div>
      </Card>
    );
  }

  async function onConfirm({ decision_id, note }: { decision_id: string; note: string }): Promise<ApproveOutcome> {
    if (!set || !chosen) return { ok: false, error: new Error("No option selected") };
    try {
      const decision = await approve.mutateAsync({ decision_id, option_set_id: set.id, option_id: chosen.id, note: note || undefined });
      setChosen(null);
      toast({ title: `${decision.id} approved`, body: `${chosen.label}. The customer and the driver have been notified.` });
      return { ok: true };
    } catch (e) {
      if (e instanceof ApiError && (e.code === "OPTIONS_STALE" || e.code === "ALERT_ALREADY_DECIDED")) {
        setChosen(null);
        setStaleNotice(true);
        options.refetch();
        return { ok: true };
      }
      return { ok: false, error: e as Error };
    }
  }

  const recommended = set?.options.find((o) => o.id === set.recommended_option_id);

  return (
    <Card aria-labelledby="options-h">
      <CardHeader title="Suggested actions" id="options-h">
        {set && (
          <p className="tnum text-meta text-muted">
            Generated {clockTz(set.generated_at)}, valid until {clockTz(set.valid_until)}
          </p>
        )}
      </CardHeader>
      <div id="options" className="scroll-mt-4" />
      {staleNotice && (
        <div role="status" className="flex flex-wrap items-center gap-3 border-b border-line bg-medium-soft px-5 py-3 text-body text-medium">
          <ArrowsClockwise size={18} weight="bold" aria-hidden />
          <p className="flex-1 font-semibold">The situation changed. Options refreshed.</p>
          <button type="button" onClick={() => setStaleNotice(false)} className="rounded-sm text-meta font-medium underline">
            Dismiss
          </button>
        </div>
      )}
      {recommended?.type === "RESCHEDULE" && (recommended.projected_late_min ?? 0) > 0 && (
        <p className="flex items-start gap-2 border-b border-line px-5 py-3 text-body text-ink">
          <Info size={18} weight="bold" aria-hidden className="mt-0.5 shrink-0 text-accent-ink" />
          {RESCHEDULE_ONLY}
        </p>
      )}
      {options.isPending ? (
        <Loading label="Loading options">
          <div className="space-y-2 p-5">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        </Loading>
      ) : options.error && !set ? (
        <div className="p-5">
          <ErrorNote what="the options" error={options.error} onRetry={() => options.refetch()} />
        </div>
      ) : set ? (
        <OptionsTable set={set} onApprove={setChosen} disabled={approve.isPending} />
      ) : null}
      <ApprovalDialog open={!!chosen} option={chosen} set={set ?? null} shipment={shipment} onCancel={() => setChosen(null)} onConfirm={onConfirm} />
    </Card>
  );
}
