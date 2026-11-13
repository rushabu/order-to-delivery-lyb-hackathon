import { useState } from "react";
import { ChatCircleDots, CheckCircle, PauseCircle, Phone, ShieldCheck, Warning } from "@phosphor-icons/react";
import type { ShipmentDetail } from "../api/contract";
import {
  documentUrl, useCheckins, useDocuments, useDriverContact, useDriving, useRequestCheckin, useTripLog,
  useVerifyDocument, type DocumentMeta, type LogEntry,
} from "../api/ops";
import { fmtDur, useDocumentUrl } from "../pages/driver/TripTools";
import { clock } from "../lib/time";
import { Button, Card, CardHeader, EmptyState, ErrorNote } from "./ui";

/* Coordinator: the driver, the paperwork and everything that happened on the trip. */

const STOP_WORD = { BREAK: "on a rest break", FUEL: "at a fuel stop", CHARGING: "charging", OTHER: "stopped", UNPLANNED: "stopped, reason not given" } as const;

/** Opens a stored file in a new tab or saves it, using the session token (files are not public URLs). */
export async function openDocument(d: DocumentMeta, save = false) {
  const url = await documentUrl(d.id);
  const a = document.createElement("a");
  a.href = url;
  if (save) a.download = d.file_name;
  else a.target = "_blank";
  a.rel = "noopener";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/* ---------------- Driver: call, check in, stop, driving time ---------------- */

export function DriverCard({ s }: { s: ShipmentDetail }) {
  const contact = useDriverContact(s.id);
  const checkins = useCheckins(s.id);
  const driving = useDriving(s.id);
  const ask = useRequestCheckin(s.id);
  const [msg, setMsg] = useState("");
  const [composing, setComposing] = useState(false);
  const last = checkins.data?.[0];
  const d = driving.data;
  const phone = contact.data?.phone;
  const first = (contact.data?.name ?? s.driver_name ?? "driver").split(" ")[0];

  return (
    <Card aria-labelledby="drv-h">
      <CardHeader title="Driver" id="drv-h" />
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-lead font-semibold">{contact.data?.name ?? s.driver_name ?? "Not assigned"}</p>
          {phone && <p className="tnum text-body text-ink-2">{phone}</p>}
        </div>

        {/* Live status: stopped or driving, and time to the next break */}
        {s.status === "IN_TRANSIT" && d && (
          <p className={`flex items-start gap-2 text-body ${d.on_stop?.kind === "UNPLANNED" || d.overdue ? "text-high" : "text-ink-2"}`}>
            {d.on_stop && <PauseCircle size={18} weight="fill" aria-hidden className="mt-0.5 shrink-0" />}
            {d.on_stop
              ? `Now ${STOP_WORD[d.on_stop.kind]} since ${clock(d.on_stop.started_at)}${d.on_stop.at_km !== null ? `, km ${Math.round(d.on_stop.at_km)}` : ""}.`
              : d.overdue
                ? `Break overdue: driving ${fmtDur(d.driving_min_since_break)} without a ${d.break_min} min break.`
                : `Driving ${fmtDur(d.driving_min_since_break)} since the last break.${d.break_due_at ? ` Break due by ${clock(d.break_due_at)}.` : ""}`}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {phone ? (
            <a href={`tel:${phone.replace(/\s+/g, "")}`} className="btn-primary inline-flex h-11 flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-accent px-4 text-body font-semibold text-on-accent transition-colors hover:bg-accent-hover">
              <Phone size={18} weight="fill" aria-hidden /> Call {first}
            </a>
          ) : (
            <Button disabled>No phone number</Button>
          )}
          <Button onClick={() => setComposing((v) => !v)} aria-expanded={composing} disabled={!s.driver_name || s.status === "DELIVERED"} className="h-11 flex-1 whitespace-nowrap">
            <ChatCircleDots size={18} weight="bold" aria-hidden /> Ask to check in
          </Button>
        </div>

        {composing && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              ask.mutate(msg.trim(), { onSuccess: () => { setComposing(false); setMsg(""); } });
            }}
          >
            <div>
              <label htmlFor="ci-msg" className="block text-meta font-semibold text-ink-2">
                Message to {first} (optional)
              </label>
              <input id="ci-msg" maxLength={200} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Are you and the load all right?" className="ct-underline-input" />
            </div>
            <Button type="submit" variant="primary" disabled={ask.isPending}>
              {ask.isPending ? "Sending…" : "Send check-in request"}
            </Button>
            {ask.error && <ErrorNote what="the check-in request" error={ask.error} onRetry={() => ask.reset()} />}
          </form>
        )}

        {last && (
          <p className="flex items-start gap-2 border-t border-line pt-3 text-body">
            {!last.responded_at ? (
              <span className="text-ink-2">Check-in asked at {clock(last.requested_at)}. Waiting for {first}.</span>
            ) : last.response === "OK" ? (
              <>
                <CheckCircle size={18} weight="fill" aria-hidden className="mt-0.5 shrink-0 text-low" />
                <span>Checked in at {clock(last.responded_at)}: all right.</span>
              </>
            ) : (
              <>
                <Warning size={18} weight="fill" aria-hidden className="mt-0.5 shrink-0 text-high" />
                <span className="text-high">
                  Problem reported at {clock(last.responded_at)}
                  {last.response_note ? `: "${last.response_note}"` : ""}. Call {first}.
                </span>
              </>
            )}
          </p>
        )}
      </div>
    </Card>
  );
}

/* ---------------- Delivery proof (the invoice is InvoiceCard) ---------------- */

export function DocumentsCard({ s }: { s: ShipmentDetail }) {
  const docs = useDocuments(s.id);
  const verify = useVerifyDocument(s.id);
  const photo = docs.data?.find((d) => d.kind === "DELIVERY_PHOTO");
  const thumb = useDocumentUrl(photo?.id);

  return (
    <Card aria-labelledby="docs-h">
      <CardHeader title="Delivery photo" id="docs-h" />
      <div>
        <div className="p-5">
          {photo ? (
            <div className="mt-3 space-y-3">
              {thumb && (
                <button type="button" onClick={() => void openDocument(photo)} className="block w-full overflow-hidden rounded-md border border-line" aria-label="Open the delivery photo full size">
                  <img src={thumb} alt={`Delivery photo for ${s.id}`} className="max-h-56 w-full object-cover transition-transform duration-300 hover:scale-[1.02]" />
                </button>
              )}
              <p className="tnum text-meta text-muted">
                From {photo.uploaded_by_name} at {clock(photo.uploaded_at)}
              </p>
              {photo.verified_at ? (
                <p className="flex items-center gap-2 text-body text-low">
                  <ShieldCheck size={18} weight="fill" aria-hidden /> Verified by {photo.verified_by_name} at {clock(photo.verified_at)}. The customer was told.
                </p>
              ) : (
                <Button variant="primary" disabled={verify.isPending} onClick={() => verify.mutate(photo.id)}>
                  <ShieldCheck size={18} weight="bold" aria-hidden /> {verify.isPending ? "Verifying…" : "Verify delivery"}
                </Button>
              )}
              {verify.error && <ErrorNote what="the verification" error={verify.error} onRetry={() => verify.reset()} />}
            </div>
          ) : (
            <p className="mt-1 text-body text-muted">The driver takes it on arrival. It appears here for you to verify.</p>
          )}
        </div>

      </div>
    </Card>
  );
}

/* ---------------- Trip log ---------------- */

const LOG_MARK: Record<LogEntry["kind"], string> = {
  MILESTONE: "bg-ink",
  DISRUPTION: "bg-high",
  ALERT: "bg-medium",
  DECISION: "bg-accent-ink",
  STOP: "bg-line-strong",
  CHECKIN: "bg-accent",
  DOCUMENT: "bg-low",
};
const LOG_WORD: Record<LogEntry["kind"], string> = { MILESTONE: "Status", DISRUPTION: "Report", ALERT: "Alert", DECISION: "Decision", STOP: "Stop", CHECKIN: "Check-in", DOCUMENT: "Paperwork" };

export function TripLog({ s }: { s: ShipmentDetail }) {
  const log = useTripLog(s.id);
  const [all, setAll] = useState(false);
  const rows = log.data ?? [];
  const shown = all ? rows : rows.slice(0, 8);
  return (
    <Card aria-labelledby="log-h">
      <CardHeader title="Trip log" id="log-h">
        <span className="text-meta text-muted">Everything on this trip, newest first</span>
      </CardHeader>
      {log.error && !log.data ? (
        <div className="p-5">
          <ErrorNote what="the trip log" error={log.error} onRetry={() => log.refetch()} />
        </div>
      ) : !rows.length ? (
        <EmptyState title="Nothing logged yet." />
      ) : (
        <>
          <ol className="px-5 py-3">
            {shown.map((e, i) => (
              <li key={`${e.at}-${i}`} className="grid grid-cols-[48px_14px_minmax(0,1fr)] gap-x-3 py-2.5">
                <span className="tnum pt-0.5 text-meta text-muted">{clock(e.at)}</span>
                <span aria-hidden className="relative flex justify-center">
                  <span className={`relative z-[1] mt-1.5 h-2.5 w-2.5 rounded-full ${LOG_MARK[e.kind]}`} />
                  {i < shown.length - 1 && <span className="absolute bottom-[-14px] top-4 w-px bg-line" />}
                </span>
                <div className="min-w-0">
                  <p className="text-body">
                    <span className="sr-only">{LOG_WORD[e.kind]}: </span>
                    <span className="font-medium text-ink">{e.title}</span>
                  </p>
                  {e.detail && <p className="break-words text-meta text-ink-2">{e.detail}</p>}
                  {e.by && <p className="text-meta text-muted">{e.by}</p>}
                </div>
              </li>
            ))}
          </ol>
          {rows.length > 8 && (
            <div className="border-t border-line px-5 py-3">
              <button type="button" onClick={() => setAll((v) => !v)} aria-expanded={all} className="text-body font-semibold text-accent-ink hover:underline">
                {all ? "Show the latest 8" : `Show all ${rows.length} entries`}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
