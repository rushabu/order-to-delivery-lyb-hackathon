import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { motion } from "motion/react";
import { ArrowLeft, CarProfile, CloudRain, Wrench, Prohibit, Package, Question } from "@phosphor-icons/react";
import type { DisruptionCategory } from "../../api/contract";
import { Button, EmptyState, Loading, Skeleton } from "../../components/ui";
import { duration, easeOut } from "../../lib/motion";
import { useCurrentTrip, useDriverOutbox } from "./useCurrentTrip";
import { Column } from "./DriverTrip";

/*
  Three-tap disruption report (DESIGN.md 7.3): category, expected delay, Send. No typing.
  "Not sure" sends no estimate, so the API applies the category default (DESIGN.md 6.3).
  The event goes through the outbox, so it is kept and retried if the network fails.
*/
const CATEGORIES: { value: DisruptionCategory; label: string; Icon: typeof CarProfile }[] = [
  { value: "ACCIDENT", label: "Accident", Icon: CarProfile },
  { value: "BREAKDOWN", label: "Breakdown", Icon: Wrench },
  { value: "WEATHER", label: "Weather", Icon: CloudRain },
  { value: "ROAD_CLOSURE", label: "Road closed", Icon: Prohibit },
  { value: "LOADING_DELAY", label: "Loading delay", Icon: Package },
  { value: "OTHER", label: "Other", Icon: Question },
];
const DELAYS: { value: number | null; label: string }[] = [
  { value: 30, label: "30 min" },
  { value: 60, label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: null, label: "Not sure" },
];

export function DriverReport() {
  const { list, detail } = useCurrentTrip();
  const { outbox } = useDriverOutbox();
  const navigate = useNavigate();
  const [category, setCategory] = useState<(typeof CATEGORIES)[number] | null>(null);
  const [delay, setDelay] = useState<(typeof DELAYS)[number] | null>(null);
  const s = detail.data;
  const step = !category ? 1 : !delay ? 2 : 3;

  if (list.isPending || (list.data?.length && detail.isPending)) {
    return (
      <Loading label="Loading your trip">
        <Column>
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-64" />
        </Column>
      </Loading>
    );
  }
  if (!s) {
    return (
      <Column>
        <EmptyState title="No trip assigned." />
      </Column>
    );
  }

  function send() {
    if (!s || !category || !delay) return;
    const payload: Record<string, unknown> = { disruption_id: crypto.randomUUID(), category: category.value };
    if (delay.value !== null) payload.expected_delay_min = delay.value;
    outbox.enqueue(s.id, "DISRUPTION_REPORTED", payload, `Problem report (${category.label})`);
    navigate("/driver");
  }

  function back() {
    if (delay) setDelay(null);
    else if (category) setCategory(null);
    else navigate("/driver");
  }

  return (
    <Column>
      <div className="flex items-center gap-2">
        <button type="button" onClick={back} className="-ml-2 inline-flex h-11 min-w-11 items-center gap-1.5 rounded-md px-2 text-body font-medium text-ink-2 hover:bg-sunken">
          <ArrowLeft size={20} weight="bold" aria-hidden /> Back
        </button>
        <p className="ml-auto text-meta text-muted" aria-live="polite">
          Step {step} of 3
        </p>
      </div>

      {/* Entry-only animation: the previous step is removed at once, so it can never be tapped by mistake. */}
        {step === 1 && (
          <Step key="1" title="What is the problem?">
            <div className="grid grid-cols-2 gap-3">
              {CATEGORIES.map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setCategory(CATEGORIES.find((c) => c.value === value)!)}
                  className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border-2 border-line-strong bg-surface p-3 text-lead font-semibold text-ink active:scale-[0.98] hover:border-ink"
                >
                  <Icon size={32} weight="bold" aria-hidden />
                  {label}
                </button>
              ))}
            </div>
          </Step>
        )}
        {step === 2 && (
          <Step key="2" title="How long will it hold you up?" subtitle={category!.label}>
            <div className="grid gap-3">
              {DELAYS.map((d) => (
                <button
                  key={d.label}
                  type="button"
                  onClick={() => setDelay(d)}
                  className="min-h-16 rounded-lg border-2 border-line-strong bg-surface px-5 text-left text-heading font-semibold text-ink active:scale-[0.98] hover:border-ink"
                >
                  {d.label}
                </button>
              ))}
            </div>
          </Step>
        )}
        {step === 3 && (
          <Step key="3" title="Send this report?">
            <dl className="rounded-lg border border-line bg-surface p-4 text-lead">
              <div className="flex justify-between gap-4 py-1">
                <dt className="text-muted">Problem</dt>
                <dd className="font-semibold">{category!.label}</dd>
              </div>
              <div className="flex justify-between gap-4 py-1">
                <dt className="text-muted">Expected delay</dt>
                <dd className="font-semibold">{delay!.label}</dd>
              </div>
              <div className="flex justify-between gap-4 py-1">
                <dt className="text-muted">Trip</dt>
                <dd className="font-semibold">{s.id}</dd>
              </div>
            </dl>
            <Button variant="primary" size="xl" className="mt-4 min-h-20 text-driver" onClick={send}>
              Send
            </Button>
            <Link to="/driver" className="mt-3 flex min-h-12 items-center justify-center rounded-md text-body font-medium text-ink-2 hover:bg-sunken">
              Cancel
            </Link>
          </Step>
        )}
    </Column>
  );
}

function Step({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  // Move focus to each new step's question so keyboard and screen reader users follow along.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <motion.section
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: duration.base, ease: easeOut }}
      aria-labelledby="step-h"
    >
      {subtitle && <p className="text-meta font-medium text-muted">{subtitle}</p>}
      <h1 id="step-h" ref={heading} tabIndex={-1} className="mb-4 text-heading font-semibold outline-none">
        {title}
      </h1>
      {children}
    </motion.section>
  );
}
