import { motion } from "motion/react";
import type { EtaFactor, EtaSnapshot } from "../api/contract";
import { duration, easeOut } from "../lib/motion";
import { clock, clockTz, duration as fmtDuration } from "../lib/time";
import { ConfidenceTag, CrossFade, RiskBadge } from "./ui";

/*
  ETA panel (DESIGN.md 7.2, 7.4). Shows the API's snapshot as it is: ETA, window, promise, risk,
  confidence, headline and each factor in minutes with their total. Nothing here is calculated
  except adding up the listed minutes for the total row, which the API guarantees equals the ETA.
  When a new snapshot arrives the time cross-fades and every factor row that is new or changed
  is highlighted briefly, so viewers can see which factor moved the ETA.
*/
export function EtaPanel({
  snapshot,
  previous,
  audience = "coordinator",
  headingId,
}: {
  snapshot: EtaSnapshot;
  previous?: EtaSnapshot | null;
  audience?: "coordinator" | "customer" | "driver";
  headingId?: string;
}) {
  const total = snapshot.factors.reduce((s, f) => s + f.minutes, 0);
  const changed = (code: string, minutes: number) => {
    if (!previous || previous.id === snapshot.id) return false;
    const before = previous.factors.find((f) => f.code === code);
    return !before || before.minutes !== minutes;
  };
  const late = snapshot.slack_min < 0;
  const stale = snapshot.confidence === "LOW";

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p id={headingId} className="text-meta font-medium text-muted">
            {audience === "customer" ? "Expected delivery" : "Estimated arrival"}
          </p>
          <CrossFade value={snapshot.eta} className="mt-0.5">
            {(eta) => (
              <span className="wide tnum text-[2.5rem] font-[800] leading-none tracking-[-0.03em] text-ink">
                {clock(eta)} <span className="text-lead font-medium text-muted">IST</span>
              </span>
            )}
          </CrossFade>
          <p className="tnum mt-1 text-meta text-ink-2">
            Likely between {clock(snapshot.eta_window.earliest)} and {clockTz(snapshot.eta_window.latest)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <RiskBadge level={snapshot.risk_level} size="lg" />
          <ConfidenceTag confidence={snapshot.confidence} />
        </div>
      </div>

      <dl className="tnum mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-body">
        <div>
          <dt className="text-meta text-muted">Promised by</dt>
          <dd className="font-medium">{clockTz(snapshot.promised_by)}</dd>
        </div>
        <div>
          <dt className="text-meta text-muted">Against the promise</dt>
          <dd className={`font-medium ${late ? "text-high" : "text-ink"}`}>
            {snapshot.slack_min === 0 ? "Exactly on time" : `${fmtDuration(snapshot.slack_min)} ${late ? "late" : "early"}`}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-lead font-medium text-ink">{snapshot.headline}</p>

      <FactorBar snapshot={snapshot} />

      <table className="tnum mt-3 w-full text-body">
        <caption className="sr-only">
          {audience === "customer" ? "Why this ETA" : "ETA factors"}, in minutes from {clockTz(snapshot.computed_at)}
        </caption>
        <thead>
          <tr className="border-b border-line text-meta text-muted">
            <th scope="col" className="py-1.5 text-left font-medium">
              {audience === "customer" ? "What adds time" : "Factor"}
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Minutes
            </th>
          </tr>
        </thead>
        <tbody>
          {snapshot.factors.map((f) => (
            <tr key={`${snapshot.id}-${f.code}`} className={`border-b border-line ${changed(f.code, f.minutes) ? "row-changed" : ""}`}>
              <th scope="row" className="py-2 pr-3 text-left font-normal text-ink-2">
                <span className="flex items-start gap-2">
                  <span aria-hidden className={`mt-[7px] h-2.5 w-2.5 shrink-0 rounded-[3px] ${segmentClass(f)}`} />
                  {f.label}
                </span>
              </th>
              <td className="py-2 text-right font-medium text-ink">{f.minutes}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" className="pt-2 text-left font-semibold">
              Total from {clockTz(snapshot.computed_at)}
            </th>
            <td className="pt-2 text-right font-semibold">{total}</td>
          </tr>
        </tfoot>
      </table>

      {audience === "coordinator" && (
        <p className="tnum mt-3 text-meta text-muted">
          Risk score {snapshot.risk_score} of 100 (a ranking, not a probability). Margin ±{snapshot.margin_min} min.
          {stale ? ` No position for ${snapshot.position_age_min} min.` : ""}
        </p>
      )}
    </div>
  );
}

/*
  Where the minutes come from: one segment per factor, sized by its minutes (the API's numbers).
  Driving and planned stops are neutral; slow traffic uses the "at risk" tone and reported problems
  the "delayed" tone. Colour is a reading aid only: every segment is named in the table below.
  Segments grow in from the left whenever a new snapshot arrives (transform only).
*/
export function segmentClass(f: EtaFactor): string {
  if (f.code === "BASE_TRAVEL") return "bg-ink-2";
  if (f.code === "DWELL") return "bg-line-strong";
  if (f.code === "CONGESTION") return "bg-medium";
  if (f.code === "STALE_POSITION" || f.minutes === 0) return "bg-line";
  return "bg-high";
}

function FactorBar({ snapshot }: { snapshot: EtaSnapshot }) {
  const parts = snapshot.factors.filter((f) => f.minutes > 0);
  if (!parts.length) return null;
  return (
    <div aria-hidden className="mt-4 flex h-3 w-full gap-[3px] overflow-hidden rounded-full">
      {parts.map((f, i) => (
        <motion.span
          key={`${snapshot.id}-${f.code}`}
          className={`h-full origin-left first:rounded-l-full last:rounded-r-full ${segmentClass(f)}`}
          style={{ flexGrow: f.minutes, flexBasis: 0, minWidth: 6 }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: duration.slow * 2, ease: easeOut, delay: i * 0.08 }}
        />
      ))}
    </div>
  );
}
