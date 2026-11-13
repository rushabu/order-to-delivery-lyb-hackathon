import { useEffect, useRef, useState } from "react";
import { Camera, CheckCircle, Coffee, GasPump, Lightning, PauseCircle, Phone, Play, Warning } from "@phosphor-icons/react";
import type { ShipmentDetail } from "../../api/contract";
import { compressPhoto, documentUrl, useAnswerCheckin, useCheckins, useDocuments, useDriving, useEndStop, useStartStop, useUploadDocument, type StopKind } from "../../api/ops";
import { Button, ErrorNote } from "../../components/ui";
import { clock } from "../../lib/time";

export const fmtDur = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`);
const STOP_LABEL: Record<StopKind, string> = { BREAK: "Rest break", FUEL: "Fuel stop", CHARGING: "Charging stop", OTHER: "Stop", UNPLANNED: "Stopped" };

/* ---------------- Check-in request from the coordinator ---------------- */

export function CheckinBanner({ s }: { s: ShipmentDetail }) {
  const checkins = useCheckins(s.id);
  const answer = useAnswerCheckin(s.id);
  const [problem, setProblem] = useState(false);
  const [note, setNote] = useState("");
  const open = checkins.data?.find((c) => !c.responded_at);
  if (!open) return null;
  const send = (response: "OK" | "PROBLEM") =>
    answer.mutate({ checkinId: open.id, response, note: response === "PROBLEM" ? note : undefined }, { onSuccess: () => { setProblem(false); setNote(""); } });
  return (
    <section role="alert" aria-labelledby="ci-h" className="border-l-4 border-accent bg-accent-soft p-4">
      <h2 id="ci-h" className="flex items-center gap-2 text-lead font-semibold text-ink">
        <Phone size={20} weight="fill" aria-hidden /> {open.requested_by_name} asks you to check in
      </h2>
      <p className="mt-1 text-body text-ink-2">{open.message ?? "Confirm that you and the load are all right."}</p>
      <p className="tnum mt-1 text-meta text-muted">Asked at {clock(open.requested_at)}</p>
      {answer.error && (
        <div className="mt-2">
          <ErrorNote what="your answer" error={answer.error} onRetry={() => answer.reset()} />
        </div>
      )}
      {!problem ? (
        <div className="mt-3 grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
          <Button variant="primary" size="lg" disabled={answer.isPending} onClick={() => send("OK")}>
            <CheckCircle size={20} weight="bold" aria-hidden /> I'm all right
          </Button>
          <Button size="lg" disabled={answer.isPending} onClick={() => setProblem(true)}>
            <Warning size={20} weight="bold" aria-hidden /> I have a problem
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <label htmlFor="ci-note" className="block text-meta font-semibold text-ink-2">
            What is wrong? (optional)
          </label>
          <textarea id="ci-note" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-md border border-line-strong bg-raised px-3 py-2 text-body outline-none focus-visible:border-ink" />
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Button variant="primary" size="lg" disabled={answer.isPending} onClick={() => send("PROBLEM")}>
              Send to {open.requested_by_name.split(" ")[0]}
            </Button>
            <Button size="lg" onClick={() => setProblem(false)}>
              Back
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------------- Driving time and stops ---------------- */

export function DrivingPanel({ s }: { s: ShipmentDetail }) {
  const driving = useDriving(s.id);
  const start = useStartStop(s.id);
  const end = useEndStop(s.id);
  const d = driving.data;
  if (s.status !== "IN_TRANSIT" || !d) return null;
  const stop = d.on_stop;
  const err = start.error ?? end.error;
  const resetErr = () => {
    start.reset();
    end.reset();
  };

  if (stop) {
    return (
      <section aria-labelledby="stop-h" className="rounded-lg border-2 border-ink bg-surface p-4">
        <h2 id="stop-h" className="flex items-center gap-2 text-lead font-semibold">
          <PauseCircle size={22} weight="fill" aria-hidden /> {STOP_LABEL[stop.kind]}
        </h2>
        <p className="tnum mt-1 text-body text-ink-2">
          Since {clock(stop.started_at)}. {stop.source === "DETECTED" ? "Plant X saw the truck stop. Tap Drive on when you move, or tell Plant X why you stopped." : "Plant X has been told."}
        </p>
        {err && (
          <div className="mt-2">
            <ErrorNote what="the stop" error={err} onRetry={resetErr} />
          </div>
        )}
        <Button variant="primary" size="xl" className="mt-3" disabled={end.isPending} onClick={() => end.mutate(stop.id)}>
          <Play size={22} weight="fill" aria-hidden /> Drive on
        </Button>
        {stop.source === "DETECTED" && <StopReasons onPick={(k) => start.mutate(k)} busy={start.isPending} />}
      </section>
    );
  }

  const pct = Math.min(100, (d.driving_min_since_break / d.limit_min) * 100);
  const near = d.limit_min - d.driving_min_since_break <= 30;
  return (
    <section aria-labelledby="drive-h" className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="drive-h" className="text-meta font-semibold text-muted">
          Driving since your last break
        </h2>
        <p className={`tnum text-body font-semibold ${d.overdue ? "text-high" : near ? "text-medium" : "text-ink"}`}>{fmtDur(d.driving_min_since_break)}</p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-label="Driving time used before a break is due" aria-valuemin={0} aria-valuemax={d.limit_min} aria-valuenow={d.driving_min_since_break}>
        <div className={`h-full ${d.overdue ? "bg-high" : near ? "bg-medium" : "bg-accent"}`} style={{ width: `${pct}%` }} />
      </div>
      <p className={`tnum mt-2 text-meta ${d.overdue ? "font-semibold text-high" : "text-ink-2"}`}>
        {d.overdue
          ? `Break overdue. Stop for ${d.break_min} min when it is safe.`
          : d.break_due_at
            ? `Take a ${d.break_min} min break by ${clock(d.break_due_at)} (at most ${fmtDur(d.limit_min)} of driving).`
            : ""}
      </p>
      {err && (
        <div className="mt-2">
          <ErrorNote what="the stop" error={err} onRetry={resetErr} />
        </div>
      )}
      <StopReasons onPick={(k) => start.mutate(k)} busy={start.isPending} />
    </section>
  );
}

function StopReasons({ onPick, busy }: { onPick: (k: Exclude<StopKind, "UNPLANNED">) => void; busy: boolean }) {
  const items: { k: Exclude<StopKind, "UNPLANNED">; label: string; icon: typeof Coffee }[] = [
    { k: "BREAK", label: "Rest break", icon: Coffee },
    { k: "FUEL", label: "Fuel", icon: GasPump },
    { k: "CHARGING", label: "Charging", icon: Lightning },
    { k: "OTHER", label: "Other stop", icon: PauseCircle },
  ];
  return (
    <div className="mt-3">
      <p className="text-meta text-muted">Stopping? Tell Plant X why:</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {items.map((i) => (
          <Button key={i.k} size="lg" disabled={busy} onClick={() => onPick(i.k)} className="justify-start">
            <i.icon size={18} weight="bold" aria-hidden /> {i.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Delivery photo (on arrival) ---------------- */

export function useHasDeliveryPhoto(id: string) {
  const docs = useDocuments(id);
  return docs.data?.some((d) => d.kind === "DELIVERY_PHOTO") ?? false;
}

/** Loads a stored file as an object URL for display, and releases it when no longer shown. */
export function useDocumentUrl(docId: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!docId) return setUrl(null);
    let made: string | null = null;
    let live = true;
    documentUrl(docId)
      .then((u) => {
        made = u;
        if (live) setUrl(u);
        else URL.revokeObjectURL(u);
      })
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [docId]);
  return url;
}

export function DeliveryPhoto({ s }: { s: ShipmentDetail }) {
  const docs = useDocuments(s.id);
  const upload = useUploadDocument(s.id);
  const input = useRef<HTMLInputElement>(null);
  const photo = docs.data?.find((d) => d.kind === "DELIVERY_PHOTO");
  const preview = useDocumentUrl(photo?.id);
  const [localError, setLocalError] = useState<string | null>(null);

  if (s.status !== "ARRIVED" && s.status !== "DELIVERED") return null;

  async function pick(f: File | undefined) {
    if (input.current) input.current.value = "";
    if (!f) return;
    setLocalError(null);
    try {
      const small = await compressPhoto(f);
      await upload.mutateAsync({ kind: "DELIVERY_PHOTO", file: small, fileName: `delivery-${s.id}.jpg` });
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "The photo could not be sent.");
    }
  }

  return (
    <section aria-labelledby="pod-h" className={`rounded-lg bg-surface p-4 ${photo ? "border border-line" : "border-2 border-ink"}`}>
      <h2 id="pod-h" className="text-lead font-semibold">
        {photo ? "Delivery photo sent" : "Take the delivery photo"}
      </h2>
      <p className="mt-1 text-body text-ink-2">
        {photo
          ? photo.verified_at
            ? `Verified by ${photo.verified_by_name} at ${clock(photo.verified_at)}.`
            : "Plant X and the customer can see it. Waiting for Plant X to verify."
          : "Photograph the unloaded goods at the receiving point. Plant X and the customer will see it."}
      </p>
      {preview && <img src={preview} alt="Delivery photo you sent" className="mt-3 max-h-64 w-full rounded-md border border-line object-cover" />}
      {(localError || upload.error) && <p role="alert" className="mt-3 border-l-4 border-high bg-high-soft px-3 py-2 text-body text-high">{localError ?? (upload.error as Error).message}</p>}
      <Button variant={photo ? "secondary" : "primary"} size="xl" className="mt-3" disabled={upload.isPending} onClick={() => input.current?.click()}>
        <Camera size={22} weight="bold" aria-hidden /> {upload.isPending ? "Sending photo…" : photo ? "Retake photo" : "Take photo"}
      </Button>
      <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void pick(e.target.files?.[0])} />
    </section>
  );
}
