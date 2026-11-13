import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { animate } from "motion/react";
import { ArrowClockwise, CheckCircle, Circle, WarningCircle, WarningOctagon, CellSignalSlash } from "@phosphor-icons/react";
import type { Confidence, RiskLevel, ShipmentStatus } from "../api/contract";
import { CONFIDENCE_WORD, RISK_WORD, STATUS_WORD } from "../lib/risk";
import { clockTz } from "../lib/time";

/* ---------------- Button ---------------- */

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg" | "xl";

const VARIANT: Record<Variant, string> = {
  primary: "btn-primary bg-accent text-on-accent hover:bg-accent-hover border border-accent hover:border-accent-hover disabled:bg-sunken disabled:border-line-strong disabled:text-ink-2",
  secondary: "bg-surface text-ink border border-line-strong hover:bg-sunken disabled:text-muted",
  ghost: "bg-transparent text-ink-2 border border-transparent hover:bg-sunken disabled:text-muted",
};
const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-meta",
  md: "h-10 px-4 text-body",
  lg: "h-12 px-5 text-lead",
  xl: "min-h-16 px-6 text-heading w-full", // driver screen: one large target
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }>(
  function Button({ variant = "secondary", size = "md", className = "", ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={`inline-flex items-center justify-center gap-2 rounded-md font-medium transition-[background-color,border-color,transform] duration-150 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
        {...rest}
      />
    );
  },
);

/* ---------------- Risk badge: always icon + word (DESIGN.md 7.6) ---------------- */

/* A risk marker, not a pill: coloured word and icon behind a short signal bar, like a road-edge marker. */
const RISK_STYLE: Record<RiskLevel, string> = {
  LOW: "text-low",
  MEDIUM: "text-medium",
  HIGH: "text-high",
};

export function RiskIcon({ level, size = 18 }: { level: RiskLevel; size?: number }) {
  if (level === "HIGH") return <WarningOctagon size={size} weight="bold" aria-hidden />;
  if (level === "MEDIUM") return <WarningCircle size={size} weight="bold" aria-hidden />;
  return <CheckCircle size={size} weight="bold" aria-hidden />;
}

export function RiskBadge({ level, size = "md" }: { level: RiskLevel; size?: "md" | "lg" }) {
  return (
    <CrossFade value={level} shift="6px" className={`align-middle ${size === "lg" ? "text-lead" : "text-meta"}`}>
      {(l) => (
        <span className={`inline-flex items-center gap-1.5 whitespace-nowrap border-l-[3px] border-current pl-2 font-semibold ${size === "lg" ? "py-0.5" : ""} ${RISK_STYLE[l as RiskLevel]}`}>
          <RiskIcon level={l as RiskLevel} size={size === "lg" ? 20 : 16} />
          {RISK_WORD[l as RiskLevel]}
        </span>
      )}
    </CrossFade>
  );
}

/**
  Cross-fades a changing value: the new value fades in while the old one fades out on top.
  The old copy is aria-hidden and removed after 300 ms, so only the current value is ever read out.
  Plain CSS (see .xf in index.css), so a hidden window never accumulates stale copies.
*/
export function CrossFade<T extends string | number>({
  value,
  children,
  className = "",
  shift = "0px",
}: {
  value: T;
  children: (v: T) => ReactNode;
  className?: string;
  shift?: string;
}) {
  const [previous, setPrevious] = useState<{ v: T; n: number } | null>(null);
  const last = useRef(value);
  const count = useRef(0);
  useEffect(() => {
    if (last.current === value) return;
    count.current += 1;
    setPrevious({ v: last.current, n: count.current });
    last.current = value;
    const t = setTimeout(() => setPrevious(null), 320);
    return () => clearTimeout(t);
  }, [value]);
  return (
    <span className={`xf ${className}`} style={{ ["--xf-shift" as string]: shift }}>
      {previous && (
        <span key={`out-${previous.n}`} className="xf-out" aria-hidden>
          {children(previous.v)}
        </span>
      )}
      <span key={`in-${count.current}`} className={count.current ? "xf-in" : ""}>
        {children(value)}
      </span>
    </span>
  );
}

export function StatusTag({ status }: { status: ShipmentStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-meta font-medium text-ink-2">
      <Circle size={8} weight="fill" aria-hidden className="text-muted" />
      {STATUS_WORD[status]}
    </span>
  );
}

export function ConfidenceTag({ confidence }: { confidence: Confidence }) {
  const low = confidence === "LOW";
  return (
    <span className={`inline-flex items-center gap-1 text-meta ${low ? "font-semibold text-medium" : "text-muted"}`}>
      {low && <CellSignalSlash size={14} weight="bold" aria-hidden />}
      Confidence: {CONFIDENCE_WORD[confidence]}
    </span>
  );
}

/* ---------------- Surfaces ---------------- */

export function Card({ children, className = "", as: As = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" | "aside"; "aria-labelledby"?: string; "aria-label"?: string }) {
  return (
    <As className={`rounded-lg border border-line bg-surface ${className}`} {...rest}>
      {children}
    </As>
  );
}

export function CardHeader({ title, id, children }: { title: string; id?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
      <h2 id={id} className="text-body font-semibold text-ink">
        {title}
      </h2>
      {children}
    </div>
  );
}

/* ---------------- States (DESIGN.md 7.5) ---------------- */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

/** Wraps skeletons so screen readers hear one "Loading" instead of nothing. */
export function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-label={label} aria-busy="true">
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-lead font-medium text-ink">{title}</p>
      {children && <div className="mt-1 text-body text-muted">{children}</div>}
    </div>
  );
}

/** Inline error with Retry. When older data is still on screen, says when it was loaded. */
export function ErrorNote({ what, error, onRetry, loadedAt }: { what: string; error: unknown; onRetry: () => void; loadedAt?: number }) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-high/30 bg-high-soft px-4 py-3 text-body text-high">
      <WarningOctagon size={18} weight="bold" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">Could not load {what}.</span> {message}.
        {loadedAt ? <span className="text-ink-2"> Showing data loaded at {clockTz(new Date(loadedAt).toISOString())}.</span> : null}
      </p>
      <Button size="sm" onClick={onRetry}>
        <ArrowClockwise size={14} weight="bold" aria-hidden /> Retry
      </Button>
    </div>
  );
}

/* ---------------- Small text helpers ---------------- */

export function Meta({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`text-meta text-muted ${className}`}>{children}</span>;
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-meta text-muted">{label}</dt>
      <dd className="tnum break-words text-body font-medium text-ink">{children}</dd>
    </div>
  );
}

/**
  Counts a whole number up from its previous value (from 0 on first show). Writes straight to the DOM,
  not React state, so it never re-renders the tree. Reduced motion shows the final number at once.
*/
export function CountUp({ value, className = "" }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A hidden tab never runs animation frames, so it would freeze mid-count: show the value at once.
    if (document.hidden || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = String(value);
      from.current = value;
      return;
    }
    const controls = animate(from.current, value, {
      duration: 0.8,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => {
        from.current = v; // an interrupted count resumes from what is on screen
        el.textContent = String(Math.round(v));
      },
    });
    return () => controls.stop();
  }, [value]);
  return (
    <span ref={ref} className={`tnum ${className}`}>
      {value}
    </span>
  );
}
