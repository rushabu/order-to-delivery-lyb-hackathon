import type { EtaSnapshot } from "../api/contract";
import { clock } from "../lib/time";
import { RiskBadge } from "./ui";

/* ETA history, newest first (GET /shipments/:id/eta-history). Times in IST, stated in the column headers. */
export function EtaHistory({ snapshots }: { snapshots: EtaSnapshot[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="tnum w-full min-w-[560px] text-body">
        <caption className="sr-only">ETA history, newest first. Times are IST.</caption>
        <thead>
          <tr className="border-b border-line text-left text-meta text-muted">
            <th scope="col" className="px-5 py-2 font-medium">At (IST)</th>
            <th scope="col" className="py-2 pr-4 font-medium">ETA (IST)</th>
            <th scope="col" className="py-2 pr-4 font-medium">Risk</th>
            <th scope="col" className="py-2 pr-5 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody>
          {snapshots.map((s, i) => (
            <tr key={s.id} className={`border-b border-line last:border-0 ${i === 0 ? "bg-sunken/60" : ""}`}>
              <td className="px-5 py-2.5 text-ink-2">{clock(s.computed_at)}</td>
              <td className="py-2.5 pr-4 font-semibold">{clock(s.eta)}</td>
              <td className="py-2.5 pr-4">
                <RiskBadge level={s.risk_level} />
              </td>
              <td className="py-2.5 pr-5 text-ink-2">{s.headline}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
