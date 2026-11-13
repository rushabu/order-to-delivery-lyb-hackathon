import { motion } from "motion/react";
import { Prohibit, Star } from "@phosphor-icons/react";
import type { DecisionOption, OptionSet } from "../api/contract";
import { clock, duration as fmtDuration, inr } from "../lib/time";
import { duration, easeOut } from "../lib/motion";
import { Button, RiskBadge } from "./ui";

/*
  Options table (DESIGN.md 6.7, 7.2). Shows what the API evaluated, as returned:
  - the recommended option first, marked with an icon and the word "Recommended";
  - infeasible options shown disabled with the API's reason;
  - rows stagger in on first appearance (recommended first).
  The client never ranks, filters or judges feasibility; it only moves the recommended row to the top.
*/
export function orderedOptions(set: OptionSet): DecisionOption[] {
  const rec = set.options.find((o) => o.id === set.recommended_option_id);
  return rec ? [rec, ...set.options.filter((o) => o.id !== rec.id)] : set.options;
}

export function OptionsTable({ set, onApprove, disabled }: { set: OptionSet; onApprove: (o: DecisionOption) => void; disabled?: boolean }) {
  const rows = orderedOptions(set);
  return (
    <div className="overflow-x-auto">
      <table className="tnum w-full min-w-[860px] text-body">
        <caption className="sr-only">
          Options for {set.shipment_id}, generated {clock(set.generated_at)} IST, valid until {clock(set.valid_until)} IST. Recommended option first.
        </caption>
        <thead>
          <tr className="border-b border-line text-left text-meta text-muted">
            <th scope="col" className="px-5 py-2 font-medium">Option</th>
            <th scope="col" className="py-2 pr-4 font-medium">Arrival (IST)</th>
            <th scope="col" className="py-2 pr-4 font-medium">Late by</th>
            <th scope="col" className="py-2 pr-4 font-medium">Risk after</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">Better by</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">Extra km</th>
            <th scope="col" className="py-2 pr-4 text-right font-medium">Extra cost</th>
            <th scope="col" className="py-2 pr-5 font-medium">
              <span className="sr-only">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o, i) => {
            const recommended = o.id === set.recommended_option_id;
            return (
              <motion.tr
                key={`${set.id}-${o.id}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: duration.base, ease: easeOut, delay: i * 0.06 }}
                className={`border-b border-line last:border-0 ${recommended ? "bg-accent-soft" : ""} ${o.feasible ? "" : "text-muted"}`}
              >
                <th scope="row" className={`px-5 py-3 text-left font-normal ${recommended ? "border-l-4 border-accent" : "border-l-4 border-transparent"}`}>
                  {recommended && (
                    <span className="mb-1 inline-flex items-center gap-1 text-meta font-semibold text-accent-ink">
                      <Star size={14} weight="fill" aria-hidden /> Recommended
                    </span>
                  )}
                  <span className={`block font-medium ${o.feasible ? "text-ink" : "text-muted"}`}>{o.label}</span>
                  {!o.feasible && (
                    <span className="mt-0.5 inline-flex items-start gap-1 text-meta text-ink-2">
                      <Prohibit size={14} weight="bold" aria-hidden className="mt-0.5 shrink-0" />
                      Not available: {o.infeasible_reason}
                    </span>
                  )}
                </th>
                <td className="py-3 pr-4 font-semibold">{o.feasible ? clock(o.projected_eta) : "—"}</td>
                <td className="py-3 pr-4">{o.feasible ? (o.projected_late_min ? fmtDuration(o.projected_late_min) : "On time") : "—"}</td>
                <td className="py-3 pr-4">{o.feasible && o.projected_risk_level ? <RiskBadge level={o.projected_risk_level} /> : "—"}</td>
                <td className="py-3 pr-4 text-right">{o.feasible ? (o.improvement_min ? `${o.improvement_min} min` : "0 min") : "—"}</td>
                <td className="py-3 pr-4 text-right">{o.feasible ? `+${o.added_km ?? 0} km` : "—"}</td>
                <td className="py-3 pr-4 text-right">{o.feasible ? inr(o.added_cost_inr ?? 0) : "—"}</td>
                <td className="py-3 pr-5 text-right">
                  {o.feasible ? (
                    <Button variant={recommended ? "primary" : "secondary"} size="sm" onClick={() => onApprove(o)} disabled={disabled}>
                      Approve<span className="sr-only">: {o.label}</span>
                    </Button>
                  ) : (
                    <span className="text-meta">Unavailable</span>
                  )}
                </td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
