import { CloudLightning, CloudRain, Sun } from "@phosphor-icons/react";
import { useRouteWeather } from "../api/queries";
import type { WeatherLevel } from "../api/contract";
import { Card, CardHeader, ErrorNote, Loading, Skeleton } from "./ui";

/*
  Live weather along each route (Open-Meteo, via GET /weather/routes). Level is always icon plus word.
  In demo mode it is an advisory; in live mode the backend also adds it to ETAs (database/README.md).
*/
const LEVEL: Record<WeatherLevel, { word: string; tone: string; Icon: typeof Sun }> = {
  CLEAR: { word: "Clear", tone: "text-low", Icon: Sun },
  MODERATE: { word: "Moderate", tone: "text-medium", Icon: CloudRain },
  SEVERE: { word: "Severe", tone: "text-high", Icon: CloudLightning },
};

function localTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
}

export function WeatherPanel({ routeId }: { routeId?: string } = {}) {
  const q = useRouteWeather();
  const d = q.data;
  const routes = d?.routes.filter((route) => !routeId || route.route_id === routeId);
  return (
    <Card aria-labelledby="weather-h">
      <CardHeader title="Route weather, next 3 hours" id="weather-h">
        {d && <span className="text-meta text-muted">{d.mode === "LIVE" ? "Live: adds to ETAs" : "Advisory: demo ETAs unchanged"}</span>}
      </CardHeader>
      {q.isPending ? (
        <Loading label="Loading route weather">
          <div className="space-y-2 p-5">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        </Loading>
      ) : q.error ? (
        <div className="p-4">
          <ErrorNote what="route weather" error={q.error} onRetry={() => q.refetch()} />
        </div>
      ) : d && d.status === "UNAVAILABLE" ? (
        <p className="px-5 py-4 text-body text-muted">Weather service unavailable right now{d.error ? ` (${d.error})` : ""}. Nothing else is affected.</p>
      ) : routeId && !routes?.length ? (
        <p className="px-5 py-4 text-body text-muted">Forecast unavailable for this route.</p>
      ) : (
        <ul className="divide-y divide-line">
          {routes?.map((r) => {
            const { word, tone, Icon } = LEVEL[r.level];
            return (
              <li key={r.route_id} className="grid grid-cols-[auto_1fr_auto] items-start gap-3 px-5 py-3">
                <Icon size={20} weight="bold" className={tone} aria-hidden />
                <div className="min-w-0">
                  <p className="text-body font-medium text-ink">
                    {r.route_name} <span className="text-meta text-muted">({r.route_id})</span>
                  </p>
                  <p className="text-meta text-muted">
                    {r.worst ? `Near km ${Math.round(r.worst.km)}: ${r.worst.reasons.join(", ")}` : "No rain, low visibility or strong wind forecast"}
                  </p>
                </div>
                <p className="text-right text-meta">
                  <span className={`font-semibold ${tone}`}>{word}</span>
                  {r.suggested_delay_min > 0 && <span className="block text-muted">+{r.suggested_delay_min} min</span>}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {d?.fetched_at && (
        <p className="border-t border-line px-5 py-2 text-meta text-muted">
          {d.source}. Updated {localTime(d.fetched_at)} IST (real time).
        </p>
      )}
    </Card>
  );
}
