import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";
import type { DecisionOption, OptionSet, ShipmentDetail } from "../api/contract";
import { clockTz } from "../lib/time";
import { Button } from "./ui";
import { Dialog } from "./Dialog";

/*
  Approval confirmation (DESIGN.md 7.2): says what will change and who will be notified before the
  coordinator commits. One decision_id is created per opening, so a retried submit is idempotent.
  "Who will be notified" follows the DECISION_APPLIED recipients in DESIGN.md 8.
*/
export type ApproveOutcome = { ok: true } | { ok: false; error: ApiError | Error };

const ACTION_WORD: Record<DecisionOption["type"], string> = {
  REROUTE: "Approve reroute",
  RESCHEDULE: "Approve new delivery time",
  CONTINUE: "Approve continue",
  SPLIT_SHIPMENT: "Approve split",
};

export function whatChanges(o: DecisionOption, s: ShipmentDetail): string[] {
  const now = s.current_eta;
  switch (o.type) {
    case "REROUTE":
      return [
        `Route changes from ${s.active_route_id} to ${String(o.params?.alt_route_id ?? "the alternative")}.`,
        `Projected arrival ${clockTz(o.projected_eta)}${o.improvement_min ? `, ${o.improvement_min} min earlier than continuing` : ""}.`,
        `Adds ${o.added_km ?? 0} km and ₹${(o.added_cost_inr ?? 0).toLocaleString("en-IN")} (fictional rate).`,
      ];
    case "RESCHEDULE":
      return [
        `Agreed delivery time becomes ${clockTz(String(o.params?.new_agreed_delivery_by ?? ""))}. The original promise of ${clockTz(s.order.original_promised_by)} still counts for on-time reporting.`,
        `Arrival stays at about ${clockTz(o.projected_eta)}.`,
      ];
    case "CONTINUE":
      return [`No change to the route. Projected arrival ${clockTz(o.projected_eta ?? now?.eta)}.`, "The alert is marked decided and the shipment stays monitored."];
    case "SPLIT_SHIPMENT":
      return ["Part of the load ships now; a second shipment is created for the balance.", `Projected arrival ${clockTz(o.projected_eta)}.`];
  }
}

export function ApprovalDialog({
  open,
  option,
  set,
  shipment,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  option: DecisionOption | null;
  set: OptionSet | null;
  shipment: ShipmentDetail;
  onCancel: () => void;
  onConfirm: (args: { decision_id: string; note: string }) => Promise<ApproveOutcome>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decisionId = useRef<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  if (open && option && !decisionId.current) decisionId.current = crypto.randomUUID();

  // Whenever the dialog closes (cancel, success or stale options), forget the decision id and the note.
  useEffect(() => {
    if (!open) {
      decisionId.current = null;
      setNote("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  function close() {
    onCancel();
  }

  async function confirm() {
    if (!decisionId.current) return;
    setBusy(true);
    setError(null);
    const result = await onConfirm({ decision_id: decisionId.current, note });
    setBusy(false);
    if (result.ok) return;
    const e = result.error;
    if (e instanceof ApiError && e.status === 0) setError("Could not reach the server. Your approval was not recorded yet; try again.");
    else setError(e.message);
  }

  return (
    <Dialog
      open={open && !!option}
      onClose={close}
      title={option ? `${ACTION_WORD[option.type]} for ${shipment.id}?` : ""}
      description={option?.label}
      initialFocusRef={confirmRef}
    >
      {option && set && (
        <div className="space-y-5">
          <section aria-labelledby="changes-h">
            <h3 id="changes-h" className="text-meta font-semibold text-ink-2">
              What will change
            </h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-body">
              {whatChanges(option, shipment).map((line) => (
                <li key={line} className="tnum">
                  {line}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="notify-h">
            <h3 id="notify-h" className="text-meta font-semibold text-ink-2">
              Who will be notified
            </h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-body">
              <li>{shipment.customer_name}: the new estimate and the reason</li>
              <li>The driver of {shipment.id}{shipment.driver_name ? ` (${shipment.driver_name})` : ""}: the new instruction</li>
            </ul>
          </section>
          <div>
            <label htmlFor="decision-note" className="text-meta font-semibold text-ink-2">
              Note for the ledger <span className="font-normal text-muted">(optional)</span>
            </label>
            <textarea
              id="decision-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-body outline-none focus-visible:border-ink"
            />
          </div>
          {error && (
            <p role="alert" className="text-body font-medium text-high">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button ref={confirmRef} variant="primary" onClick={confirm} disabled={busy}>
              {busy ? "Approving…" : ACTION_WORD[option.type]}
            </Button>
          </div>
          <p className="tnum text-meta text-muted">
            Option set {set.id}, valid until {clockTz(set.valid_until)}.
          </p>
        </div>
      )}
    </Dialog>
  );
}
