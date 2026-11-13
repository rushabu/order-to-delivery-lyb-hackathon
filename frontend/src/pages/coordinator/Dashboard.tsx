import { useId, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useDelayCauses, useImpact, useOnTime } from "../../api/queries";
import type { DelayCauseRow, OnTimeRow } from "../../api/contract";
import { Card, CountUp, ErrorNote, Loading, Skeleton } from "../../components/ui";
import { CATEGORY_WORD } from "../../lib/risk";
import { inr } from "../../lib/time";
import { prefersReducedMotion } from "../../lib/motion";
import { token, useTheme } from "../../lib/theme";

/*
  Performance dashboard (DESIGN.md 7.2, 10.3): on-time % and delay minutes by cause, grouped by route
  or transporter, plus the impact indicators. Every chart has a "Show as table" toggle.
  Colour: one series per chart, so no hue encodes identity. On-time bars use the accent; delay bars are
  neutral ink, drawn as small multiples (one chart per route or transporter).
  Bars grow once on first view; never under reduced motion.
*/
type GroupBy = "route" | "transporter";

/** Chart colours come from the theme tokens and update when the theme changes. */
function useChartColors() {
  useTheme();
  return {
    INK: token("--chart-ink"),
    ACCENT: token("--accent-ink"),
    GRID: token("--line"),
    TEXT: token("--ink"),
    CURSOR: token("--sunken"),
    BORDER: token("--line-strong"),
    SURFACE: token("--raised"),
    AXIS: { fontSize: 13, fill: token("--muted"), fontFamily: "Archivo Variable" },
  };
}

/** Animate only the first time a chart mounts in this page view. */
function useGrowOnce() {
  const done = useRef(false);
  const animate = !done.current && !prefersReducedMotion();
  done.current = true;
  return animate;
}

export function Dashboard() {
  const [groupBy, setGroupBy] = useState<GroupBy>("route");
  const onTime = useOnTime(groupBy);
  const causes = useDelayCauses(groupBy);
  const impact = useImpact();

  return (
    <div className="mx-auto max-w-[1440px] space-y-5 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-figure font-[750] tracking-[-0.025em]">Performance</h1>
          <p className="mt-1 text-body text-muted">Delivered shipments, measured against the original promise. Fictional history plus today's replay.</p>
        </div>
        <fieldset>
          <legend className="sr-only">Group by</legend>
          <div className="inline-flex rounded-md border border-line-strong" role="radiogroup" aria-label="Group by">
            {(["route", "transporter"] as GroupBy[]).map((g) => (
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={groupBy === g}
                onClick={() => setGroupBy(g)}
                className={`h-10 px-4 text-body font-medium first:rounded-l-md last:rounded-r-md ${groupBy === g ? "bg-accent text-on-accent" : "bg-surface text-ink-2 hover:bg-sunken"}`}
              >
                By {g}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <ImpactPanel q={impact} />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <ChartCard title={`On-time delivery by ${groupBy}`} q={onTime} table={(rows) => <OnTimeTable rows={rows} groupBy={groupBy} />}>
          {(rows) => <OnTimeChart rows={rows} />}
        </ChartCard>
        <ChartCard title={`Delay minutes by cause, by ${groupBy}`} q={causes} table={(rows) => <CausesTable rows={rows} groupBy={groupBy} />}>
          {(rows) => <CausesCharts rows={rows} />}
        </ChartCard>
      </div>
    </div>
  );
}

/* ---------------- Impact (DESIGN.md 10.3) ---------------- */

function ImpactPanel({ q }: { q: ReturnType<typeof useImpact> }) {
  const m = q.data;
  return (
    <Card aria-labelledby="impact-h">
      <div className="border-b border-line px-5 py-3">
        <h2 id="impact-h" className="text-body font-semibold">
          Impact of early warning and decisions
        </h2>
      </div>
      {q.isPending ? (
        <Loading label="Loading impact">
          <div className="grid grid-cols-1 gap-px p-5 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </div>
        </Loading>
      ) : q.error && !m ? (
        <div className="p-5">
          <ErrorNote what="impact figures" error={q.error} onRetry={() => q.refetch()} />
        </div>
      ) : m ? (
        <>
          <dl className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <Tile label="Warning lead time (median)" value={m.warning_lead_time_median_min !== null ? `${m.warning_lead_time_median_min} min` : "—"} note="How long before the promised time the coordinator was warned. Without the tower, lateness is found out after it happens." headline />
            <Tile label="Delay avoided by decisions" value={m.delay_avoided_total_min !== null ? `${m.delay_avoided_total_min} min` : "After arrival"} note="Simulated no-action arrival minus actual arrival" />
            <Tile label="On-time delivery" value={m.on_time_pct_with_decisions !== null ? `${m.on_time_pct_with_decisions}%` : "—"} note={m.on_time_pct_without_decisions !== null ? `${m.on_time_pct_without_decisions}% without the decisions (simulated)` : undefined} />
            <Tile label="Cost of lateness avoided" value={m.cost_of_lateness_avoided_inr !== null ? inr(m.cost_of_lateness_avoided_inr) : "After arrival"} note="Modelled estimate" />
          </dl>
          <div className="border-t border-line px-5 py-3 text-meta text-muted">
            <p className="tnum">
              ETA error at decision time: {m.eta_error_mean_min !== null ? `${m.eta_error_mean_min} min mean` : "after arrival"}. Alert precision{" "}
              {m.alert_precision !== null ? `${Math.round(m.alert_precision * 100)}%` : "—"}, recall {m.alert_recall !== null ? `${Math.round(m.alert_recall * 100)}%` : "—"}.
            </p>
            <details className="mt-1">
              <summary className="cursor-pointer font-medium text-ink-2">Assumptions</summary>
              <ul className="mt-1 list-disc pl-5">
                {m.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </details>
          </div>
        </>
      ) : null}
    </Card>
  );
}

function Tile({ label, value, note, headline }: { label: string; value: string; note?: string; headline?: boolean }) {
  const pending = value === "After arrival";
  return (
    <div className={`rounded-md px-5 py-4 ${headline ? "bg-rail text-rail-ink" : "bg-raised"}`}>
      <dt className={`text-meta ${headline ? "text-rail-muted" : "text-muted"}`}>{label}</dt>
      <dd className={`tnum mt-1 wide font-[800] tracking-[-0.03em] ${headline ? "text-[2.75rem] leading-none text-[#f2f7fb]" : "text-figure text-ink"}`}>
        {pending ? (
          <span className="text-lead font-semibold not-italic text-muted [font-stretch:100%]">Shown after delivery</span>
        ) : /^\d+/.test(value) ? (
          <>
            <CountUp value={parseInt(value, 10)} />
            {value.replace(/^\d+/, "")}
          </>
        ) : (
          value
        )}
      </dd>
      {note && <dd className={`mt-2 text-meta ${headline ? "text-rail-ink" : "text-ink-2"}`}>{note}</dd>}
    </div>
  );
}

/* ---------------- Chart card with table alternative ---------------- */

function ChartCard<T>({
  title,
  q,
  children,
  table,
}: {
  title: string;
  q: { data?: T[]; isPending: boolean; error: unknown; refetch: () => void; dataUpdatedAt: number };
  children: (rows: T[]) => React.ReactNode;
  table: (rows: T[]) => React.ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  return (
    <Card aria-labelledby={id}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
        <h2 id={id} className="text-body font-semibold">
          {title}
        </h2>
        <button type="button" aria-pressed={asTable} onClick={() => setAsTable((t) => !t)} className="h-9 rounded-md border border-line-strong px-3 text-meta font-medium text-ink-2 hover:bg-sunken">
          {asTable ? "Show as chart" : "Show as table"}
        </button>
      </div>
      <div className="p-5">
        {q.error ? <ErrorNote what={title.toLowerCase()} error={q.error} onRetry={q.refetch} loadedAt={q.data ? q.dataUpdatedAt : undefined} /> : null}
        {q.isPending ? (
          <Loading label={`Loading ${title}`}>
            <div className="space-y-3">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          </Loading>
        ) : q.data ? (
          asTable ? (
            table(q.data)
          ) : (
            <>
              {children(q.data)}
              {/* The chart is drawn for sighted readers; screen readers get the same numbers as a table. */}
              <div className="sr-only">{table(q.data)}</div>
            </>
          )
        ) : null}
      </div>
    </Card>
  );
}

/* ---------------- On-time ---------------- */

function OnTimeChart({ rows }: { rows: OnTimeRow[] }) {
  const animate = useGrowOnce();
  const { ACCENT, GRID, TEXT, CURSOR, AXIS } = useChartColors();
  const data = rows.map((r) => ({ ...r, label: `${r.on_time_pct}%` }));
  return (
    <div aria-hidden className="h-[180px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 56, top: 4, bottom: 4 }} barCategoryGap={18}>
          <CartesianGrid horizontal={false} stroke={GRID} />
          <XAxis type="number" domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={AXIS} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="group_name" width={170} tick={{ ...AXIS, fill: TEXT }} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ fill: CURSOR }} content={<OnTimeTip />} />
          <Bar dataKey="on_time_pct" fill={ACCENT} radius={[0, 6, 6, 0]} isAnimationActive={animate} animationDuration={600} animationEasing="ease-out">
            <LabelList dataKey="label" position="right" style={{ ...AXIS, fill: TEXT, fontWeight: 600 }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function OnTimeTip({ active, payload }: { active?: boolean; payload?: { payload: OnTimeRow }[] }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className="tnum rounded-md border border-line-strong bg-surface px-3 py-2 text-meta">
      <p className="font-semibold text-ink">{r.group_name}</p>
      <p className="text-ink-2">
        {r.on_time} of {r.delivered} on time ({r.on_time_pct}%)
      </p>
    </div>
  );
}

function OnTimeTable({ rows, groupBy }: { rows: OnTimeRow[]; groupBy: GroupBy }) {
  return (
    <table className="tnum w-full text-body">
      <caption className="sr-only">On-time delivery by {groupBy}</caption>
      <thead>
        <tr className="border-b border-line text-left text-meta text-muted">
          <th scope="col" className="py-2 font-medium capitalize">{groupBy}</th>
          <th scope="col" className="py-2 text-right font-medium">Delivered</th>
          <th scope="col" className="py-2 text-right font-medium">On time</th>
          <th scope="col" className="py-2 text-right font-medium">On-time %</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.group_id} className="border-b border-line last:border-0">
            <th scope="row" className="py-2 text-left font-medium">{r.group_name}</th>
            <td className="py-2 text-right">{r.delivered}</td>
            <td className="py-2 text-right">{r.on_time}</td>
            <td className="py-2 text-right font-semibold">{r.on_time_pct}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------------- Delay causes (small multiples) ---------------- */

const CAUSE_ORDER = ["CONGESTION", "ACCIDENT", "BREAKDOWN", "WEATHER", "ROAD_CLOSURE", "LOADING_DELAY", "OTHER"];
const causeList = (r: DelayCauseRow) =>
  CAUSE_ORDER.filter((c) => r.minutes_by_cause[c] !== undefined).map((c) => ({ cause: CATEGORY_WORD[c] ?? c, minutes: r.minutes_by_cause[c] ?? 0 }));

function CausesCharts({ rows }: { rows: DelayCauseRow[] }) {
  const animate = useGrowOnce();
  const { INK, TEXT, CURSOR, BORDER, SURFACE, AXIS } = useChartColors();
  const max = Math.max(1, ...rows.flatMap((r) => Object.values(r.minutes_by_cause).map((v) => v ?? 0)));
  return (
    <div aria-hidden className="grid grid-cols-1 gap-6 sm:grid-cols-2">
      {rows.map((r) => {
        const data = causeList(r);
        const total = data.reduce((s, d) => s + d.minutes, 0);
        return (
          <div key={r.group_id}>
            <p className="text-body font-semibold">{r.group_name}</p>
            <p className="tnum text-meta text-muted">{total} min in total</p>
            <div className="mt-2 h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} layout="vertical" margin={{ left: 0, right: 40, top: 0, bottom: 0 }} barCategoryGap={6}>
                  <XAxis type="number" hide domain={[0, max]} />
                  <YAxis type="category" dataKey="cause" width={104} tick={{ ...AXIS, fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: CURSOR }} formatter={(v) => [`${v} min`, "Delay"]} contentStyle={{ border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 13, background: SURFACE, color: TEXT }} />
                  <Bar dataKey="minutes" fill={INK} radius={[0, 6, 6, 0]} isAnimationActive={animate} animationDuration={600} animationEasing="ease-out">
                    <LabelList dataKey="minutes" position="right" style={{ ...AXIS, fontSize: 12, fill: TEXT }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CausesTable({ rows, groupBy }: { rows: DelayCauseRow[]; groupBy: GroupBy }) {
  const causes = CAUSE_ORDER.filter((c) => rows.some((r) => r.minutes_by_cause[c] !== undefined));
  return (
    <div className="overflow-x-auto">
      <table className="tnum w-full min-w-[560px] text-body">
        <caption className="sr-only">Delay minutes by cause, by {groupBy}</caption>
        <thead>
          <tr className="border-b border-line text-left text-meta text-muted">
            <th scope="col" className="py-2 font-medium capitalize">{groupBy}</th>
            {causes.map((c) => (
              <th key={c} scope="col" className="py-2 text-right font-medium">
                {CATEGORY_WORD[c] ?? c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.group_id} className="border-b border-line last:border-0">
              <th scope="row" className="py-2 text-left font-medium">{r.group_name}</th>
              {causes.map((c) => (
                <td key={c} className="py-2 text-right">
                  {r.minutes_by_cause[c] ?? 0}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
