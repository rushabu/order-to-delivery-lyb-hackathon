import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, Navigate } from "react-router";
import { AnimatePresence, motion, useMotionValue, useMotionValueEvent, useScroll, useSpring, useTransform, type MotionValue } from "motion/react";
import { ArrowDown, Truck } from "@phosphor-icons/react";
import { homeFor, useSession } from "../auth/session";
import { FICTIONAL_NOTICE, Mark, ThemeToggle } from "../components/AppShell";
import { RiskBadge } from "../components/ui";
import type { RiskLevel } from "../api/contract";
import { easeOut, prefersReducedMotion } from "../lib/motion";

/*
  Public landing page. One orchestrated moment: the hero truck drives in and, as it passes km 50, the alert
  beside it turns from "on schedule" to "at risk". Below, scrolling replays the worked example in DESIGN.md 6.6
  (SHP-1001, Panvel to Pune): the truck follows the road with the scroll, and every number is the engine's own
  result for that fictional shipment, so the page shows the product rather than describing it.
*/

type Kind = "base" | "dwell" | "slow" | "accident" | "bypass";
interface Beat {
  clock: string;
  min: number; // minutes after 08:50
  km: number;
  onBypass?: boolean;
  accident?: boolean;
  risk: RiskLevel;
  title: string;
  body: string;
  factors: { label: string; min: number; kind: Kind }[];
  eta: string;
  arrived?: { actual: number; without: number };
}

const BEATS: Beat[] = [
  {
    clock: "08:50", min: 0, km: 33, risk: "LOW", title: "On schedule",
    body: "SHP-1001 left Plant X at 08:00 with 24 t of polypropylene. 117 km to go, promised by 11:45.",
    factors: [{ label: "Drive at normal speed", min: 130, kind: "base" }, { label: "Checkpoint", min: 15, kind: "dwell" }],
    eta: "11:15",
  },
  {
    clock: "09:15", min: 25, km: 50, risk: "MEDIUM", title: "At risk, before anyone calls",
    body: "The truck covered 10 km in 15 minutes. The engine carries that pace over the next 50 km and alerts the coordinator. Nobody has reported anything yet.",
    factors: [{ label: "Normal speed", min: 110, kind: "base" }, { label: "Checkpoint", min: 15, kind: "dwell" }, { label: "Slow traffic", min: 25, kind: "slow" }],
    eta: "11:45",
  },
  {
    clock: "09:30", min: 40, km: 60, accident: true, risk: "HIGH", title: "40 minutes late",
    body: "The driver reports an accident at km 75 in three taps. The ETA moves to 12:25, and the customer sees the new time and the reason within a minute.",
    factors: [{ label: "Normal speed", min: 100, kind: "base" }, { label: "Checkpoint", min: 15, kind: "dwell" }, { label: "Accident at km 75", min: 60, kind: "accident" }],
    eta: "12:25",
  },
  {
    clock: "09:31", min: 41, km: 66, accident: true, onBypass: true, risk: "MEDIUM", title: "Reroute approved",
    body: "The bypass leaves at km 66, before the accident: 16 km longer, ₹720 more, and back inside the promise. The coordinator approves, and the driver's screen shows the new turn straight away.",
    factors: [{ label: "To the exit", min: 9, kind: "slow" }, { label: "Bypass at normal speed", min: 120, kind: "bypass" }],
    eta: "11:39",
  },
  {
    clock: "11:43", min: 173, km: 150, accident: true, onBypass: true, risk: "LOW", title: "Delivered on time",
    body: "Arrived 11:43, two minutes inside the promise, with a delivery photo the customer can see. Replaying the road not taken gives 12:40: the ledger records 57 minutes of delay avoided.",
    factors: [],
    eta: "11:43",
    arrived: { actual: 173, without: 230 },
  },
];

const SPAN = 250; // 08:50 to 13:00 on the time ribbon
const PROMISE = 175; // 11:45
const pct = (m: number) => `${(m / SPAN) * 100}%`;
const KIND_CLASS: Record<Kind, string> = {
  base: "bg-[#5b6679] text-white",
  dwell: "bg-[#8e98a8] text-[#1b2230]",
  slow: "bg-[#e07a2e] text-[#1b2230]",
  accident: "bg-[#e5483e] text-white",
  bypass: "bg-[#3fae8c] text-[#1b2230]",
};

/* Road geometry (viewBox 1000 x 230). RTE-01 runs km 0-150 along y = 90; the bypass leaves at km 66. */
const X = (km: number) => 40 + (km / 150) * 920;
const MAIN = `M ${X(0)} 90 L ${X(150)} 90`;
const BYPASS_CURVE = `C ${X(78)} 90, ${X(80)} 185, ${X(98)} 185 L ${X(128)} 185 C ${X(142)} 185, ${X(144)} 90, ${X(150)} 90`;
const BYPASS = `M ${X(66)} 90 ${BYPASS_CURVE}`;
/** The road the truck actually drove: the main road to the exit, then the bypass. */
const DRIVEN = `M ${X(0)} 90 L ${X(66)} 90 ${BYPASS_CURVE}`;
const STONES = [0, 40, 100, 150];

export function Landing() {
  const session = useSession();
  if (session) return <Navigate to={homeFor(session.user.role)} replace />;
  return (
    <div className="min-h-dvh overflow-x-clip">
      <Header />
      <main id="main">
        <Hero />
        <Story />
        <Roles />
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-3 px-5 py-6 text-meta text-muted sm:px-8">
          <p>{FICTIONAL_NOTICE} Numbers on this page are simulation results.</p>
          <p>LYB Mumbai Hackathon 2026, problem statement 3</p>
        </div>
      </footer>
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-[900] border-b border-line/70 bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-3 px-5 sm:px-8">
        <Link to="/" className="flex items-center gap-2.5 rounded-sm font-semibold">
          <Mark />
          <span className="wide hidden text-body tracking-tight sm:inline">Plant X Control Tower</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Link to="/login" className="btn-primary inline-flex h-10 items-center rounded-md bg-accent px-4 text-body font-semibold text-on-accent hover:bg-accent-hover">
            Sign in
          </Link>
        </div>
      </div>
    </header>
  );
}

/* ---------------- Hero: headline, the alert it is about, and the road ---------------- */

/** The truck takes this long to reach km 50; the alert turns as it gets there. */
const DRIVE_S = 2.4;
const DRIVE_DELAY_S = 0.4;

const line = (i: number) => ({
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.6, ease: easeOut, delay: 0.05 + i * 0.08 },
});

function Hero() {
  return (
    <section className="relative">
      <div className="mx-auto grid max-w-[1200px] grid-cols-1 gap-10 px-5 pb-10 pt-12 sm:px-8 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-end">
        <div>
          <h1 className="hero-type text-hero font-[800] tracking-[-0.035em] lg:text-[clamp(2.8rem,4.6vw,4.1rem)]">
            <motion.span {...line(0)} className="block">Catch the late truck</motion.span>
            <motion.span {...line(1)} className="block">at kilometre 50,</motion.span>
            <motion.span {...line(2)} className="block text-muted">not at the gate.</motion.span>
          </h1>
          <motion.p {...line(3)} className="mt-7 max-w-[54ch] text-lead text-ink-2">
            Every bulk polymer delivery from Plant X, tracked from the gate to the customer. The control tower predicts the arrival, gives the reason in minutes, and leaves the coordinator time to act while there is still road left.
          </motion.p>
          <motion.div {...line(4)} className="mt-8 flex flex-wrap items-center gap-3">
            <Link to="/login" className="btn-primary inline-flex h-12 items-center rounded-md bg-accent px-6 text-lead font-semibold text-on-accent hover:bg-accent-hover">
              Sign in
            </Link>
            <a href="#story" className="inline-flex h-12 items-center gap-2 rounded-md border border-line-strong px-5 text-lead font-medium text-ink transition-colors duration-150 hover:bg-surface">
              <ArrowDown size={18} weight="bold" aria-hidden /> Follow one delivery
            </a>
          </motion.div>
        </div>
        <HeroAlert />
      </div>
      <HeroRoad />
    </section>
  );
}

/** What the coordinator sees for SHP-1001, before and after the truck passes km 50. */
function HeroAlert() {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (prefersReducedMotion()) return setLate(true);
    const t = window.setTimeout(() => setLate(true), (DRIVE_DELAY_S + DRIVE_S * 0.8) * 1000);
    return () => window.clearTimeout(t);
  }, []);
  const s = late
    ? { clock: "09:15", risk: "MEDIUM" as RiskLevel, eta: "11:45", why: "10 km in the last 15 minutes. At this pace it reaches the customer just on the promise. Coordinator alerted; nobody has called yet." }
    : { clock: "08:50", risk: "LOW" as RiskLevel, eta: "11:15", why: "117 km to go at normal speed, one checkpoint. 30 minutes inside the promise." };
  return (
    <motion.aside
      aria-label="Example alert for shipment SHP-1001"
      aria-live="polite"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: easeOut, delay: 0.35 }}
      className="rounded-lg border border-line-strong bg-surface p-5 lg:mb-2"
    >
      <div className="flex items-baseline justify-between gap-3 text-meta text-muted">
        <span>SHP-1001, Panvel to Pune</span>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={s.clock} className="tnum" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            {s.clock} IST
          </motion.span>
        </AnimatePresence>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={s.risk} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.35, ease: easeOut }}>
          <div className="mt-3 flex items-end justify-between gap-3">
            <p className="leading-none">
              <span className="block text-meta text-muted">ETA</span>
              <span className="wide tnum text-[2.6rem] font-[800] tracking-[-0.03em] text-ink">{s.eta}</span>
            </p>
            <RiskBadge level={s.risk} />
          </div>
          <p className="mt-3 border-t border-line pt-3 text-body text-ink-2">{s.why}</p>
        </motion.div>
      </AnimatePresence>
    </motion.aside>
  );
}

/** Left offset of km on the hero road, to scale: 6% margin each side. */
const heroLeft = (km: number) => `calc(6% + ${(km / 150) * 88}%)`;

function HeroRoad() {
  return (
    <div aria-hidden className="relative h-[150px] sm:h-[190px]">
      <svg viewBox="0 0 1200 190" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
        <rect x="0" y="62" width="1200" height="76" fill="var(--road)" />
        <rect x="0" y="68" width="1200" height="3" fill="#ffc531" />
        <rect x="0" y="129" width="1200" height="3" fill="#ffc531" />
        <line x1="0" y1="100" x2="1200" y2="100" stroke="#ffffff" strokeOpacity="0.85" strokeWidth="4" strokeDasharray="36 28" className="lane-flow" />
      </svg>
      {/* Kilometre stones, to scale along the 150 km road */}
      <div className="absolute inset-x-0 top-0 h-[62px]">
        {STONES.map((km, i) => (
          <motion.div
            key={km}
            className="absolute bottom-0 -translate-x-1/2"
            style={{ left: heroLeft(km) }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: easeOut, delay: 0.25 + i * 0.1 }}
          >
            <KmStone km={km} />
          </motion.div>
        ))}
      </div>
      {/* The truck drives in, eases off as it reaches km 50, and idles there */}
      <motion.div
        className="absolute top-[calc(50%-11px)] -translate-x-1/2 sm:top-[calc(50%-13px)]"
        initial={{ left: "-10%" }}
        animate={{ left: heroLeft(50) }}
        transition={{ duration: DRIVE_S, ease: [0.25, 0.8, 0.3, 1], delay: DRIVE_DELAY_S }}
      >
        <motion.span
          className="inline-flex h-[22px] items-center gap-1 rounded-full bg-accent px-2.5 text-[11px] font-bold text-on-accent shadow-[0_6px_18px_-6px_rgb(255_197_49/0.9)] sm:h-[26px] sm:text-[12px]"
          animate={{ y: [0, -1, 0] }}
          transition={{ duration: 0.9, ease: "easeInOut", repeat: Infinity, delay: DRIVE_DELAY_S + DRIVE_S }}
        >
          <Truck size={14} weight="fill" />
          SHP-1001
        </motion.span>
      </motion.div>
    </div>
  );
}

function KmStone({ km }: { km: number }) {
  return (
    <div className="flex w-11 flex-col items-center overflow-hidden rounded-t-full border border-line-strong bg-raised shadow-sm">
      <span className="block h-4 w-full bg-accent" />
      <span className="tnum px-1 pb-1 pt-0.5 text-[12px] font-semibold leading-none text-ink">
        {km}
        <span className="block text-[9px] font-medium text-muted">km</span>
      </span>
    </div>
  );
}

/* ---------------- Story: scroll replays the worked example ---------------- */

/** Distance along the DRIVEN path at a given km on the main road (it is straight up to the exit). */
const alongMain = (km: number) => X(km) - X(0);

function Story() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end end"] });
  // A little give, so the truck rolls to a stop instead of halting with the scroll wheel.
  const smooth = useSpring(scrollYProgress, { stiffness: 140, damping: 30, mass: 0.4 });
  const total = useRef(alongMain(150) + 120); // replaced by the real path length on mount
  const n = BEATS.length;
  // Each step's text appears the moment the truck reaches that step's place; in between, the truck drives.
  const centers = BEATS.map((_, k) => k / n);
  const dist = useTransform(smooth, (p) => {
    const stops = BEATS.map((b, k) => (k === n - 1 ? total.current : alongMain(b.km)));
    if (p <= centers[0]) return stops[0];
    for (let k = 0; k < n - 1; k++) {
      if (p <= centers[k + 1]) {
        const t = (p - centers[k]) / (centers[k + 1] - centers[k]);
        return stops[k] + (stops[k + 1] - stops[k]) * t;
      }
    }
    return stops[n - 1];
  });
  const [i, setI] = useState(0);
  useMotionValueEvent(smooth, "change", (p) => setI(Math.min(n - 1, Math.max(0, Math.floor(p * n)))));
  const b = BEATS[i];

  return (
    <section id="story" aria-labelledby="story-h" className="relative bg-rail text-rail-ink" style={{ ["--low" as string]: "#7fd3b7", ["--medium" as string]: "#ffb37a", ["--high" as string]: "#ff9b92" }}>
      <div ref={ref} style={{ height: `${n * 90}vh` }}>
        <div className="sticky top-16 flex min-h-[calc(100dvh-4rem)] flex-col justify-center py-10">
          <div className="mx-auto w-full max-w-[1200px] px-5 sm:px-8">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="story-h" className="text-heading font-semibold text-[#f4f6f9]">
                One delivery, Panvel to Pune
              </h2>
              <BeatDots i={i} />
            </div>

            <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-start">
              <div aria-live="polite">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.3, ease: easeOut }}>
                    <p className="wide tnum text-[clamp(3.5rem,8vw,6.5rem)] font-[800] leading-none tracking-[-0.04em] text-[#f4f6f9]">{b.clock}</p>
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <RiskBadge level={b.risk} size="lg" />
                      <span className="text-lead font-semibold text-[#f4f6f9]">{b.title}</span>
                    </div>
                    <p className="mt-4 max-w-[46ch] text-lead text-rail-ink">{b.body}</p>
                  </motion.div>
                </AnimatePresence>
              </div>

              <div className="space-y-6">
                <StoryRoad b={b} dist={dist} total={total} />
                <Ribbon b={b} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function BeatDots({ i }: { i: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label={`Step ${i + 1} of ${BEATS.length}`}>
      {BEATS.map((b, n) => (
        <li key={b.clock}>
          <motion.span
            className="block h-1.5 rounded-full"
            initial={false}
            animate={{ width: n === i ? 28 : 10, backgroundColor: n <= i ? "#ffc531" : "#465163" }}
            transition={{ duration: 0.3, ease: easeOut }}
          />
        </li>
      ))}
    </ol>
  );
}

function StoryRoad({ b, dist, total }: { b: Beat; dist: MotionValue<number>; total: React.RefObject<number> }) {
  const showBypass = !!b.onBypass;
  const pathRef = useRef<SVGPathElement>(null);
  const x = useMotionValue(X(BEATS[0].km));
  const y = useMotionValue(90);
  const rotate = useMotionValue(0);
  const driven = useMotionValue(0);

  /** Puts the truck on the road at distance d, facing the way the road runs there. */
  const place = (d: number) => {
    const path = pathRef.current;
    if (!path || typeof path.getPointAtLength !== "function") return;
    const len = total.current;
    const at = Math.max(0, Math.min(len, d));
    const p = path.getPointAtLength(at);
    const q = path.getPointAtLength(Math.min(len, at + 2));
    x.set(p.x);
    y.set(p.y);
    if (q.x !== p.x || q.y !== p.y) rotate.set((Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI);
    driven.set(at / len);
  };
  useLayoutEffect(() => {
    const path = pathRef.current;
    if (path && typeof path.getTotalLength === "function") total.current = path.getTotalLength();
    place(dist.get());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useMotionValueEvent(dist, "change", place);

  return (
    <svg viewBox="0 0 1000 230" className="w-full" role="img" aria-label={`Route RTE-01 with the truck at km ${b.km}${showBypass ? ", rerouted onto the bypass" : ""}`}>
      <path d={MAIN} stroke="#0b0f15" strokeWidth="30" strokeLinecap="round" fill="none" />
      <path d={MAIN} stroke="#ffffff" strokeOpacity="0.55" strokeWidth="2.5" strokeDasharray="14 12" fill="none" />
      <motion.path d={BYPASS} stroke="#0b0f15" strokeWidth="26" strokeLinecap="round" fill="none" initial={false} animate={{ pathLength: showBypass ? 1 : 0, opacity: showBypass ? 1 : 0 }} transition={{ duration: 0.9, ease: easeOut }} />
      <motion.path d={BYPASS} stroke="#ffffff" strokeOpacity="0.4" strokeWidth="2" strokeDasharray="10 10" fill="none" initial={false} animate={{ opacity: showBypass ? 1 : 0 }} transition={{ duration: 0.6, delay: 0.4 }} />
      {/* The road actually driven, painted in marker yellow as the truck covers it */}
      <path ref={pathRef} d={DRIVEN} stroke="none" fill="none" />
      <motion.path d={DRIVEN} stroke="#ffc531" strokeWidth="4" strokeLinecap="round" fill="none" style={{ pathLength: driven }} />
      {STONES.map((km) => (
        <g key={km} transform={`translate(${X(km)}, 36) scale(1.5)`}>
          <path d="M -14 22 L -14 4 A 14 14 0 0 1 14 4 L 14 22 Z" fill="#fbfcfc" />
          <path d="M -14 4 A 14 14 0 0 1 14 4 L 14 6 L -14 6 Z" fill="#ffc531" />
          <text y="18" textAnchor="middle" fontSize="11" fontWeight="700" fill="#1b2230">{km}</text>
        </g>
      ))}
      <text x={X(100)} y="140" textAnchor="middle" fontSize="22" fill="#97a2b3">checkpoint</text>
      <AnimatePresence>
        {b.accident && (
          <motion.g key="acc" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4, ease: easeOut }}>
            <circle cx={X(75)} cy="90" r="17" fill="#e5483e" className="pulse-ring" style={{ transformOrigin: `${X(75)}px 90px` }} />
            <circle cx={X(75)} cy="90" r="15" fill="#e5483e" />
            <text x={X(75)} y="96" textAnchor="middle" fontSize="16" fontWeight="800" fill="#fff">!</text>
            <text x={X(75)} y="58" textAnchor="middle" fontSize="22" fill="#ff9b92">accident, km 75</text>
          </motion.g>
        )}
      </AnimatePresence>
      <text x={X(0)} y="140" fontSize="22" fill="#97a2b3">Plant X, Panvel</text>
      <text x={X(150) - 34} y="58" textAnchor="end" fontSize="22" fill="#97a2b3">Customer, Pune</text>
      <AnimatePresence>
        {showBypass && (
          <motion.text key="byp" x={X(113)} y="224" textAnchor="middle" fontSize="22" fill="#ffc531" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4, delay: 0.5 }}>
            bypass RTE-01B, +16 km
          </motion.text>
        )}
      </AnimatePresence>
      {/* The truck: a marker-yellow cab that turns with the road */}
      <motion.g style={{ x, y, rotate }}>
        <rect x="-30" y="-14" width="60" height="28" rx="14" fill="#ffc531" />
        <path d="M -13 7 h 13 v -11 h 6 l 6 7 v 4" stroke="#1b2230" strokeWidth="2.2" fill="none" strokeLinejoin="round" />
      </motion.g>
    </svg>
  );
}

function Ribbon({ b }: { b: Beat }) {
  let at = b.min;
  return (
    <div>
      <div className="flex items-baseline justify-between text-meta text-rail-muted">
        <span>08:50</span>
        <span>{b.arrived ? "Actual arrival against the road not taken" : "ETA, built from named minutes"}</span>
        <span>13:00</span>
      </div>
      <div className="relative mt-2 h-12 rounded-md bg-rail-2">
        <motion.div className="absolute inset-y-0 left-0 rounded-l-md bg-[repeating-linear-gradient(135deg,transparent_0_6px,rgb(255_255_255/0.06)_6px_12px)]" initial={false} animate={{ width: pct(b.min) }} transition={{ duration: 0.6, ease: easeOut }} />
        {b.factors.map((f) => {
          const left = at;
          at += f.min;
          return (
            <motion.div
              key={f.kind + f.label}
              initial={{ opacity: 0, left: pct(left), width: 0 }}
              animate={{ opacity: 1, left: pct(left), width: pct(f.min) }}
              transition={{ duration: 0.6, ease: easeOut }}
              className={`absolute inset-y-1 flex items-center overflow-hidden rounded-sm px-2 text-[12px] font-semibold ${KIND_CLASS[f.kind]}`}
              title={`${f.label}: ${f.min} min`}
            >
              <span className="truncate">{f.min >= 40 ? `${f.label} ${f.min}` : f.min}</span>
            </motion.div>
          );
        })}
        {b.arrived && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5 }} className="absolute inset-y-1 flex items-center justify-center rounded-sm border-2 border-dashed border-[#3fae8c] text-[12px] font-semibold text-[#f4f6f9]" style={{ left: pct(b.arrived.actual), width: pct(b.arrived.without - b.arrived.actual) }}>
            57 min avoided
          </motion.div>
        )}
        <div className="absolute -inset-y-2 w-0.5 bg-[#f4f6f9]" style={{ left: pct(PROMISE) }} aria-hidden />
      </div>
      <div className="relative mt-2 h-5 text-meta">
        <span className="absolute -translate-x-1/2 whitespace-nowrap text-[#f4f6f9]" style={{ left: pct(PROMISE) }}>
          promised 11:45
        </span>
      </div>
      <p className="mt-3 text-lead text-[#f4f6f9]">
        {b.arrived ? "Arrived " : "ETA "}
        <span className="wide tnum font-[800]">{b.eta}</span>
        {b.arrived && <span className="text-rail-muted">. Without the reroute, 12:40.</span>}
      </p>
    </div>
  );
}

/* ---------------- Roles: what each person does with it ---------------- */

const ROLES: { name: string; does: string; points: string[] }[] = [
  {
    name: "Coordinator",
    does: "Act on the trucks that will be late.",
    points: [
      "A queue ranked by delay risk, with the reason in minutes.",
      "Reroute, split the load or agree a new time. Nothing changes until you approve.",
      "New orders ride a truck already going, or go to a named driver.",
      "Call or check in with a driver; every stop, photo and invoice in one trip log.",
    ],
  },
  {
    name: "Driver",
    does: "One trip at a time, on the phone.",
    points: [
      "A licence scan and a spoken check before the shift. Nothing from either is kept.",
      "New trips arrive with the route map, alerts ahead and safety points.",
      "Report a problem in three taps; rest breaks are counted.",
      "A delivery photo at the gate closes the trip.",
    ],
  },
  {
    name: "Customer",
    does: "Your orders, and why they move.",
    points: [
      "Time and kilometres to go, early or late, and the plain reason.",
      "Told as soon as the plan changes, not after the fact.",
      "The delivery photo, confirmed by Plant X, and the invoice to download.",
      "Ask \"Where is my order?\" and get an answer in plain words.",
    ],
  },
];

const FACTS = [
  { k: "Live roads", v: "Routes, traffic and incidents from TomTom, refreshed while the truck moves." },
  { k: "Rules you can read", v: "ETA and delay risk come from published rules, not a black box. Each minute has a name." },
  { k: "AI where it helps", v: "Only for the chat and the licence reader. Every decision stays with a person." },
];

function Roles() {
  return (
    <section aria-labelledby="roles-h" className="mx-auto max-w-[1200px] px-5 py-20 sm:px-8">
      <h2 id="roles-h" className="wide max-w-[20ch] text-[clamp(1.8rem,3.4vw,2.6rem)] font-[750] leading-[1.05] tracking-[-0.025em]">
        Three people, one shared view of the road.
      </h2>
      <div className="mt-10 grid grid-cols-1 md:grid-cols-3">
        {ROLES.map((r, n) => (
          <motion.div
            key={r.name}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ duration: 0.5, ease: easeOut, delay: n * 0.08 }}
            className={`py-6 md:px-8 ${n === 0 ? "md:pl-0" : "border-t border-dashed border-line-strong md:border-l md:border-t-0"}`}
          >
            <h3 className="wide text-heading font-[800]">{r.name}</h3>
            <p className="mt-1 text-lead font-medium text-ink">{r.does}</p>
            <ul className="mt-4 space-y-2.5">
              {r.points.map((p) => (
                <li key={p} className="max-w-[38ch] border-l-[3px] border-accent pl-3 text-body text-ink-2">
                  {p}
                </li>
              ))}
            </ul>
          </motion.div>
        ))}
      </div>

      <dl className="mt-14 grid grid-cols-1 gap-6 border-t border-line pt-8 sm:grid-cols-3">
        {FACTS.map((f) => (
          <div key={f.k}>
            <dt className="text-body font-semibold text-ink">{f.k}</dt>
            <dd className="mt-1 max-w-[36ch] text-body text-muted">{f.v}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-12 flex flex-wrap items-center gap-4 rounded-lg bg-road px-6 py-6 sm:px-8">
        <p className="wide flex-1 text-heading font-semibold text-[#f4f6f9]">Each role signs in to its own view.</p>
        <Link to="/login" className="btn-primary inline-flex h-12 items-center rounded-md bg-accent px-6 text-lead font-semibold text-on-accent hover:bg-accent-hover">
          Sign in
        </Link>
      </div>
    </section>
  );
}
