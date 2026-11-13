import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { LayoutGroup, motion } from "motion/react";
import { ArrowRight, Bell } from "@phosphor-icons/react";
import { useShipments } from "../../api/queries";
import { useRoutes } from "../../api/useShipmentRoutes";
import type { RiskLevel, ShipmentSummary } from "../../api/contract";
import { Button, CountUp, CrossFade, EmptyState, ErrorNote, Loading, RiskIcon, Skeleton, StatusTag } from "../../components/ui";
import { ShipmentMap, type MapMarker, type MapRoute } from "../../components/ShipmentMap";
import { RiskCell, isStale, positionText } from "../../components/ShipmentParts";
import { WeatherPanel } from "../../components/WeatherPanel";
import { RISK_WORD } from "../../lib/risk";
import { clock } from "../../lib/time";
import { duration, easeOut } from "../../lib/motion";

/*
  Attention queue (DESIGN.md 7.2). A summary strip counts shipments by the API's risk level; the list
  keeps the API's order (risk score, highest first); the map shows active shipments and focuses on the
  selected row. When a risk level changes the row slides to its new place (layout animation).
*/
const ACTIVE = new Set(["PLANNED", "DISPATCHED", "IN_TRANSIT", "ARRIVED"]);

export function AttentionQueue() {
  const shipments = useShipments();
  const [selected, setSelected] = useState<string | null>(null);
  const list = useMemo(() => (shipments.data ?? []).filter((s) => ACTIVE.has(s.status)), [shipments.data]);
  const needs = list.filter((s) => s.open_alert);
  const others = list.filter((s) => !s.open_alert);
  const routes = useRoutes(list.map((s) => s.active_route_id));

  const mapRoutes: MapRoute[] = list
    .filter((s) => s.last_position)
    .map((s) => routes[s.active_route_id])
    .filter((r, i, arr): r is NonNullable<typeof r> => !!r && arr.findIndex((x) => x?.id === r.id) === i)
    .map((route) => ({ route, style: "active" as const }));
  const markers: MapMarker[] = list
    .filter((s) => s.last_position)
    .map((s) => ({
      id: s.id,
      lat: s.last_position!.lat,
      lng: s.last_position!.lng,
      label: isStale(s.current_eta) ? `${s.id}, last seen ${clock(s.last_position!.occurred_at)}` : s.id,
      stale: isStale(s.current_eta),
      emphasis: s.id === selected || (!selected && !!s.open_alert),
    }));
  const focus = selected ? list.find((s) => s.id === selected) : undefined;
  const count = (level: RiskLevel) => list.filter((s) => s.current_eta?.risk_level === level).length;

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 lg:py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-figure font-[750] tracking-[-0.025em]">Attention</h1>
          <p className="mt-1 text-body text-muted">Active shipments, most at risk first. Times are IST.</p>
        </div>
      </div>

      {/* One strip: how the active fleet splits by risk, plus open alerts */}
      <RiskStrip high={count("HIGH")} medium={count("MEDIUM")} low={count("LOW")} alerts={needs.length} />

      {shipments.error && (
        <div className="mt-4">
          <ErrorNote what="shipments" error={shipments.error} onRetry={() => shipments.refetch()} loadedAt={shipments.data ? shipments.dataUpdatedAt : undefined} />
        </div>
      )}

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="space-y-6 xl:col-span-7">
          {shipments.isPending ? (
            <QueueSkeleton />
          ) : (
            <LayoutGroup>
              <Group id="needs-h" title="Needs a decision" count={needs.length}>
                {needs.length ? <Rows rows={needs} routes={routes} selected={selected} onSelect={setSelected} /> : <EmptyState title="No shipments need attention." />}
              </Group>
              <Group id="others-h" title="Running normally" count={others.length}>
                {others.length ? <Rows rows={others} routes={routes} selected={selected} onSelect={setSelected} /> : <EmptyState title="No other active shipments." />}
              </Group>
            </LayoutGroup>
          )}
          <WeatherPanel />
        </div>

        <div className="xl:col-span-5">
          <div className="xl:sticky xl:top-20">
            <div className="flex items-center justify-between pb-2">
              <h2 className="text-body font-semibold">Map</h2>
              {selected && (
                <button type="button" onClick={() => setSelected(null)} className="rounded-sm text-meta font-medium text-accent-ink">
                  Show all shipments
                </button>
              )}
            </div>
            <ShipmentMap
              label="Map of active shipments. Positions are listed in the queue."
              routes={mapRoutes}
              markers={markers}
              focusRouteIds={focus ? [focus.active_route_id] : undefined}
              className="h-[360px] xl:h-[calc(100dvh-220px)] xl:min-h-[440px]"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function RiskStrip({ high, medium, low, alerts }: { high: number; medium: number; low: number; alerts: number }) {
  const total = high + medium + low;
  const parts = [
    { level: "HIGH" as RiskLevel, n: high, bar: "bg-high", text: "text-high" },
    { level: "MEDIUM" as RiskLevel, n: medium, bar: "bg-medium", text: "text-medium" },
    { level: "LOW" as RiskLevel, n: low, bar: "bg-low", text: "text-low" },
  ];
  return (
    <section aria-label="Active shipments by risk" className="mt-6 rounded-lg border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <dl className="flex flex-wrap items-end gap-x-8 gap-y-3">
          {parts.map((p) => (
            <div key={p.level}>
              <dt className={`flex items-center gap-1.5 text-meta font-semibold ${p.text}`}>
                <RiskIcon level={p.level} size={16} />
                {RISK_WORD[p.level]}
              </dt>
              <dd className="mt-0.5">
                <CountUp value={p.n} className="wide text-[2rem] font-[800] leading-none tracking-[-0.03em] text-ink" />
              </dd>
            </div>
          ))}
        </dl>
        <div className="ml-auto flex items-center gap-2 text-body">
          <Bell size={16} weight="bold" aria-hidden className="text-ink-2" />
          <span className="tnum font-semibold text-ink">{alerts}</span>
          <span className="text-ink-2">open {alerts === 1 ? "alert" : "alerts"}</span>
        </div>
      </div>
      {/* Proportion bar: the same three numbers, as shares of the active fleet */}
      <div aria-hidden className="mt-4 flex h-2 gap-0.5 overflow-hidden rounded-full bg-sunken">
        {total > 0 && parts.filter((p) => p.n > 0).map((p) => <span key={p.level} className={p.bar} style={{ width: `${(p.n / total) * 100}%` }} />)}
      </div>
    </section>
  );
}

function Group({ id, title, count, children }: { id: string; title: string; count: number; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="pb-2 text-body font-semibold">
        {title} <span className="tnum font-normal text-muted">{count}</span>
      </h2>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">{children}</div>
    </section>
  );
}

function Rows({ rows, routes, selected, onSelect }: { rows: ShipmentSummary[]; routes: ReturnType<typeof useRoutes>; selected: string | null; onSelect: (id: string) => void }) {
  const navigate = useNavigate();
  return (
    <ul>
      {rows.map((s) => {
        const eta = s.current_eta;
        const isSel = selected === s.id;
        const late = (eta?.slack_min ?? 0) < 0;
        return (
          <motion.li
            key={s.id}
            layout="position"
            layoutId={`row-${s.id}`}
            transition={{ duration: duration.slow, ease: easeOut }}
            className={`relative border-b border-line transition-colors duration-200 last:border-0 ${isSel ? "bg-accent-soft/60" : "hover:bg-raised"}`}
          >
            {isSel && <motion.span layoutId="queue-selected" aria-hidden className="absolute inset-y-0 left-0 w-1 bg-accent" transition={{ duration: duration.base, ease: easeOut }} />}
            <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:gap-4 sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <RiskCell eta={eta} />
                  <button type="button" onClick={() => onSelect(s.id)} aria-pressed={isSel} className="min-w-0 rounded-sm text-left">
                    <span title={s.id} className="inline-block max-w-[18ch] truncate align-bottom text-lead font-semibold tracking-tight text-ink">{s.id}</span>
                    <span className="sr-only">. Show on map</span>
                  </button>
                  <StatusTag status={s.status} />
                </div>
                <p className="mt-1 truncate text-meta text-ink-2">{s.customer_name}</p>
                {eta?.headline !== "On schedule" && <p className="mt-2 text-body text-ink">{eta?.headline ?? "No estimate yet."}</p>}
                <p className="tnum mt-1 text-meta text-muted">{positionText({ ...s, current_eta: eta }, routes[s.active_route_id])}</p>
              </div>
              <div className="flex shrink-0 flex-row items-end justify-between gap-3 border-t border-dashed border-line pt-3 sm:flex-col sm:border-0 sm:pt-0 sm:text-right">
                {eta && (
                  <div className="tnum leading-tight sm:text-right">
                    <span className="sr-only">ETA </span>
                    <CrossFade value={eta.eta}>{(v) => <span className={`wide text-heading font-[800] ${late ? "text-high" : "text-ink"}`}>{clock(v)}</span>}</CrossFade>
                    <span className="block text-meta text-muted">promised {clock(eta.promised_by)}</span>
                    <Slack min={eta.slack_min} />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  {s.open_alert && (
                    <Button variant="primary" size="sm" onClick={() => navigate(`/coordinator/shipments/${s.id}#options`)}>
                      Review options
                    </Button>
                  )}
                  <Link to={`/coordinator/shipments/${s.id}`} aria-label={`Open ${s.id}`} className="ct-go inline-flex items-center gap-1 rounded-sm px-1 py-1 text-meta font-semibold text-ink-2 hover:text-ink">
                    Open <ArrowRight size={13} weight="bold" aria-hidden />
                  </Link>
                </div>
              </div>
            </div>
          </motion.li>
        );
      })}
    </ul>
  );
}

function QueueSkeleton() {
  return (
    <Loading label="Loading shipments">
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-4 border-b border-line px-5 py-4 last:border-0">
            <Skeleton className="h-6 w-24" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-4 w-3/4" />
            </div>
            <Skeleton className="h-8 w-16" />
          </div>
        ))}
      </div>
    </Loading>
  );
}

/** Minutes to spare against the promise, or minutes late: the number a coordinator scans for. */
function Slack({ min }: { min: number }) {
  const late = min < 0;
  return (
    <span className={`tnum mt-0.5 block text-meta font-semibold ${late ? "text-high" : "text-low"}`}>
      {late ? `${-min} min late` : `${min} min spare`}
    </span>
  );
}
