import { type ReactNode } from "react";
import { NavLink, Navigate, Outlet, useLocation } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { ArrowsClockwise, ChartBar, ClockCountdown, Notebook, Moon, PlusCircle, SignOut, SlidersHorizontal, Sun, WarningDiamond, type Icon } from "@phosphor-icons/react";
import { homeFor, setSession, useSession } from "../auth/session";
import { useLiveUpdates, useStreamStatus } from "../api/stream";
import { useDemoState } from "../api/queries";
import type { Role } from "../api/contract";
import { ANY_MOCKS, DEMO_MODE } from "../lib/env";
import { duration, easeOut, fadeIn } from "../lib/motion";
import { setTheme, useTheme } from "../lib/theme";
import { clock } from "../lib/time";
import { NotificationBell } from "./NotificationBell";
import { CommandPalette, PaletteTrigger, useCommandPalette } from "./CommandPalette";
import { AssistantChat } from "./AssistantChat";

export const FICTIONAL_NOTICE = "Fictional demo data. Plant X is a fictional company.";

/** Redirects to /login without a session, and to the user's own home for another role's path (DESIGN.md 7.1). */
export function RequireRole({ role }: { role: Role }) {
  const session = useSession();
  if (!session) return <Navigate to="/login" replace />;
  if (session.user.role !== role) return <Navigate to={homeFor(session.user.role)} replace />;
  return role === "COORDINATOR" ? <CoordinatorShell /> : <SimpleShell role={role} />;
}

const COORD_NAV: { to: string; label: string; icon: Icon; end?: boolean }[] = [
  { to: "/coordinator", label: "Attention", icon: WarningDiamond, end: true },
  { to: "/coordinator/dashboard", label: "Performance", icon: ChartBar },
  { to: "/coordinator/ledger", label: "Decision ledger", icon: Notebook },
  { to: "/coordinator/orders/new", label: "New order", icon: PlusCircle },
  ...(DEMO_MODE ? [{ to: "/coordinator/demo", label: "Demo controls", icon: SlidersHorizontal }] : []),
];

function useSignOut() {
  const qc = useQueryClient();
  return () => {
    setSession(null);
    qc.clear();
  };
}

/** Main area that fades each new page in. The old page is not held for an exit, so navigation is never delayed. */
function Main({ narrow }: { narrow?: boolean }) {
  const location = useLocation();
  return (
    <motion.main
      key={location.pathname}
      id="main"
      tabIndex={-1}
      className={`flex-1 outline-none ${narrow ? "" : "min-w-0"}`}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.base, ease: easeOut }}
    >
      <Outlet />
    </motion.main>
  );
}

function SkipLink() {
  return (
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[2000] focus:rounded-md focus:bg-raised focus:px-4 focus:py-2">
      Skip to content
    </a>
  );
}

/* ---------------- Coordinator: dark rail + content ---------------- */

function CoordinatorShell() {
  const session = useSession()!;
  const location = useLocation();
  const qc = useQueryClient();
  useLiveUpdates(qc, session.token);
  const signOut = useSignOut();
  const palette = useCommandPalette();

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[236px_1fr]">
      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
      <SkipLink />
      {/* Rail (desktop) */}
      <aside className="sticky top-0 hidden h-dvh flex-col bg-rail text-rail-ink md:flex">
        <NavLink to="/coordinator" className="flex items-center gap-2.5 px-5 pb-6 pt-5 font-semibold tracking-tight text-[#f2f7fb]">
          <Mark />
          <span className="leading-tight">
            Plant X
            <span className="block text-meta font-normal text-rail-muted">Control tower</span>
          </span>
        </NavLink>
        <nav aria-label="Main" className="flex-1 px-3">
          <ul className="space-y-1">
            {COORD_NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={n.end} className="group relative flex h-10 items-center gap-3 rounded-md px-3 text-body font-medium">
                  {({ isActive: exact }) => {
                    // Shipment pages belong to Attention.
                    const isActive = exact || (n.to === "/coordinator" && location.pathname.startsWith("/coordinator/shipments"));
                    return (
                    <>
                      {isActive && (
                        <motion.span
                          layoutId="rail-active"
                          className="absolute inset-0 rounded-md bg-rail-2"
                          transition={{ duration: duration.slow, ease: easeOut }}
                          aria-hidden
                        />
                      )}
                      {isActive && <motion.span layoutId="rail-bar" className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-rail-accent" aria-hidden />}
                      <n.icon size={18} weight={isActive ? "fill" : "regular"} aria-hidden className={`relative ${isActive ? "text-rail-accent" : "text-rail-muted group-hover:text-rail-ink"}`} />
                      <span className={`relative ${isActive ? "text-[#f2f7fb]" : "text-rail-ink group-hover:text-[#f2f7fb]"}`}>{n.label}</span>
                    </>
                    );
                  }}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="space-y-3 border-t border-rail-2 px-5 py-4">
          <div>
            <p className="text-body font-medium text-[#f2f7fb]">{session.user.name}</p>
            <p className="text-meta text-rail-muted">Logistics coordinator</p>
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle dark />
            <button type="button" onClick={signOut} className="inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-meta font-medium text-rail-ink hover:bg-rail-2">
              <SignOut size={16} aria-hidden /> Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        {/* Mobile header with horizontal nav */}
        <header className="bg-rail text-rail-ink md:hidden">
          <div className="flex h-14 items-center gap-2 px-4">
            <Mark />
            <span className="font-semibold text-[#f2f7fb]">Plant X</span>
            <div className="ml-auto flex items-center gap-1">
              <ThemeToggle dark />
              <button type="button" onClick={signOut} aria-label="Sign out" className="inline-flex h-10 w-10 items-center justify-center rounded-md hover:bg-rail-2">
                <SignOut size={18} aria-hidden />
              </button>
            </div>
          </div>
          <nav aria-label="Main" className="no-scrollbar flex gap-1 overflow-x-auto px-2 pb-2">
            {COORD_NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `whitespace-nowrap rounded-md px-3 py-2 text-meta font-medium ${isActive ? "bg-rail-2 text-rail-accent" : "text-rail-ink"}`}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </header>

        {/* Status bar: replay clock, live status, notifications */}
        <div className="sticky top-0 z-[800] flex h-14 items-center justify-end gap-2 border-b border-line bg-canvas/90 px-4 backdrop-blur-sm sm:px-6">
          <PaletteTrigger onOpen={() => palette.setOpen(true)} />
          {DEMO_MODE ? <ReplayClock /> : <span className="mr-auto" />}
          <StreamIndicator />
          <AssistantChat role="COORDINATOR" />
          <NotificationBell />
        </div>
        <Main />
        <Footer />
      </div>
    </div>
  );
}

/** The replay's simulated time, always visible to the coordinator during the demo. */
function ReplayClock() {
  const { data } = useDemoState();
  if (!data) return null;
  const running = data.scenario_status === "RUNNING";
  return (
    <NavLink to="/coordinator/demo" className="mr-auto inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-meta hover:border-line-strong" aria-label={`Replay clock ${clock(data.clock)} IST, ${data.scenario_status.toLowerCase().replace(/_/g, " ")}`}>
      <ClockCountdown size={16} weight="bold" aria-hidden className={running ? "text-accent-ink" : "text-muted"} />
      <span className="tnum font-mono text-body font-semibold text-ink">{clock(data.clock)}</span>
      <span className="text-muted">IST</span>
      <span className="hidden text-muted sm:inline">{running ? `Replay at ${data.speed}x` : data.scenario_status === "IDLE" ? "Replay not started" : "Replay paused"}</span>
    </NavLink>
  );
}

/* ---------------- Driver and customer: slim top bar ---------------- */

function SimpleShell({ role }: { role: Role }) {
  const session = useSession()!;
  const qc = useQueryClient();
  useLiveUpdates(qc, session.token);
  const signOut = useSignOut();
  const narrow = role === "DRIVER";
  const palette = useCommandPalette();
  return (
    <div className="flex min-h-dvh flex-col">
      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
      <SkipLink />
      <header className="sticky top-0 z-[800] border-b border-line bg-canvas/90 backdrop-blur-sm">
        <div className={`mx-auto flex h-14 items-center gap-2 px-4 ${narrow ? "max-w-xl" : "max-w-[1100px] sm:px-6"}`}>
          <NavLink to={homeFor(role)} className="flex items-center gap-2 rounded-sm font-semibold tracking-tight">
            <Mark />
            <span className={narrow ? "sr-only sm:not-sr-only" : "whitespace-nowrap max-[480px]:sr-only"}>Plant X</span>
          </NavLink>
          <span className="border-l border-line-strong pl-2 text-meta font-medium text-muted">{role === "DRIVER" ? "Driver" : "Customer"}</span>
          <div className="ml-auto flex items-center gap-1">
            {!narrow && (
              <span className="max-[400px]:hidden">
                <PaletteTrigger onOpen={() => palette.setOpen(true)} />
              </span>
            )}
            <StreamIndicator />
            <AssistantChat role={role} />
            <NotificationBell />
            {!narrow && <span className="hidden px-2 text-meta text-muted lg:inline">{session.user.name}</span>}
            <ThemeToggle />
            <button type="button" onClick={signOut} aria-label="Sign out" className="inline-flex h-11 w-11 items-center justify-center rounded-md text-ink-2 hover:bg-sunken">
              <SignOut size={18} aria-hidden />
            </button>
          </div>
        </div>
      </header>
      <Main narrow />
      <Footer narrow={narrow} />
    </div>
  );
}

/* ---------------- Shared pieces ---------------- */

export function ThemeToggle({ dark = false }: { dark?: boolean }) {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} theme`}
      className={`relative inline-flex h-10 w-10 items-center justify-center overflow-hidden rounded-md ${dark ? "text-rail-ink hover:bg-rail-2" : "text-ink-2 hover:bg-sunken"}`}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={theme}
          initial={{ opacity: 0, rotate: -60, scale: 0.7 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={{ opacity: 0, rotate: 60, scale: 0.7 }}
          transition={{ duration: duration.base, ease: easeOut }}
          className="inline-flex"
        >
          {theme === "dark" ? <Sun size={18} aria-hidden /> : <Moon size={18} aria-hidden />}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

export function Footer({ children, narrow }: { children?: ReactNode; narrow?: boolean }) {
  return (
    <footer className="border-t border-line">
      <div className={`mx-auto flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-meta text-muted sm:px-6 ${narrow ? "max-w-xl" : "max-w-[1440px]"}`}>
        <p>{FICTIONAL_NOTICE}</p>
        {ANY_MOCKS && <p>Data from the in-browser mock API.</p>}
        {children}
      </div>
    </footer>
  );
}

/** "Reconnecting" appears only when the live stream is down; data then refreshes every 3 seconds. */
function StreamIndicator() {
  const status = useStreamStatus();
  return (
    <AnimatePresence>
      {status === "reconnecting" && (
        <motion.span key="reconnecting" {...fadeIn} role="status" className="inline-flex items-center gap-1.5 rounded-sm bg-medium-soft px-2 py-1 text-meta font-semibold text-medium">
          <ArrowsClockwise size={14} weight="bold" aria-hidden />
          Reconnecting
          <span className="sr-only">. Live updates paused; refreshing every 3 seconds.</span>
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** Product mark: an Indian kilometre stone (white body, yellow cap) with a lane dash. Reads on light and dark. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M5 30.5V14.5a11 11 0 0 1 22 0v16z" fill="#fbfcfc" stroke="#1b2230" strokeWidth="1.6" />
      <path d="M5.8 14.5a10.2 10.2 0 0 1 20.4 0z" fill="#ffc531" />
      <path d="M5 14.5h22" stroke="#1b2230" strokeWidth="1.6" />
      <path d="M10.5 22.5h4M17.5 22.5h4" stroke="#1b2230" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}
