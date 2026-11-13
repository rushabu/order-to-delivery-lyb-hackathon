import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowBendDownLeft, ChartBar, House, MagnifyingGlass, Moon, Notebook, PlusCircle, SignOut, SlidersHorizontal, Truck, WarningDiamond, type Icon } from "@phosphor-icons/react";
import { setSession, useSession } from "../auth/session";
import { useShipments } from "../api/queries";
import type { Role } from "../api/contract";
import { DEMO_MODE } from "../lib/env";
import { RISK_WORD } from "../lib/risk";
import { setTheme, useTheme } from "../lib/theme";
import { clock } from "../lib/time";

/*
  Jump anywhere with Ctrl+K (Cmd+K on a Mac): pages for the signed-in role, every shipment the API lets
  this user see, and two actions. Native <dialog> keeps focus inside; the list follows the ARIA combobox
  pattern (input owns a listbox, arrow keys move the active option, Enter opens it, Escape closes).
*/

interface Item {
  id: string;
  group: "Pages" | "Shipments" | "Actions";
  label: string;
  hint?: string;
  icon: Icon;
  run: () => void;
}

const PAGES: Record<Role, { label: string; to: string; icon: Icon }[]> = {
  COORDINATOR: [
    { label: "Attention queue", to: "/coordinator", icon: WarningDiamond },
    { label: "Performance dashboard", to: "/coordinator/dashboard", icon: ChartBar },
    { label: "Decision ledger", to: "/coordinator/ledger", icon: Notebook },
    { label: "New order", to: "/coordinator/orders/new", icon: PlusCircle },
    ...(DEMO_MODE ? [{ label: "Demo controls", to: "/coordinator/demo", icon: SlidersHorizontal }] : []),
  ],
  DRIVER: [
    { label: "My trip", to: "/driver", icon: Truck },
    { label: "Report a problem", to: "/driver/report", icon: WarningDiamond },
  ],
  CUSTOMER: [
    { label: "My deliveries", to: "/customer", icon: House },
    { label: "New order", to: "/customer/orders/new", icon: PlusCircle },
  ],
};

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return { open, setOpen };
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const SHORTCUT = isMac ? "⌘K" : "Ctrl K";

/** The button that opens the palette; looks like a search field so its purpose is obvious. */
export function PaletteTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      className="inline-flex h-10 min-w-0 items-center gap-2 rounded-md border border-line-strong bg-raised px-3 text-body text-muted transition-colors duration-150 hover:border-ink hover:text-ink"
    >
      <MagnifyingGlass size={16} weight="bold" aria-hidden />
      <span className="hidden sm:inline">Find a shipment or page</span>
      <span className="sr-only sm:hidden">Search</span>
      <kbd className="ml-6 hidden rounded-sm border border-line-strong px-1.5 text-meta font-semibold sm:inline">{SHORTCUT}</kbd>
    </button>
  );
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const session = useSession();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const theme = useTheme();
  const shipments = useShipments();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQ("");
      setActive(0);
      d.showModal();
      input.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!session) return [];
    const role = session.user.role;
    const go = (to: string) => () => navigate(to);
    const pages: Item[] = PAGES[role].map((p) => ({ id: `p:${p.to}`, group: "Pages", label: p.label, icon: p.icon, run: go(p.to) }));
    const ships: Item[] =
      role === "DRIVER"
        ? []
        : (shipments.data ?? []).map((s) => ({
            id: `s:${s.id}`,
            group: "Shipments",
            label: `${s.id} to ${s.customer_name}`,
            hint: s.current_eta ? `${RISK_WORD[s.current_eta.risk_level]}, ETA ${clock(s.current_eta.eta)}` : s.status.toLowerCase().replace(/_/g, " "),
            icon: Truck,
            run: go(role === "COORDINATOR" ? `/coordinator/shipments/${s.id}` : `/customer/shipments/${s.id}`),
          }));
    const actions: Item[] = [
      { id: "a:theme", group: "Actions", label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme", icon: Moon, run: () => setTheme(theme === "dark" ? "light" : "dark") },
      { id: "a:out", group: "Actions", label: "Sign out", icon: SignOut, run: () => { setSession(null); qc.clear(); } },
    ];
    const needle = q.trim().toLowerCase();
    return [...pages, ...ships, ...actions].filter((i) => !needle || `${i.label} ${i.hint ?? ""} ${i.group}`.toLowerCase().includes(needle));
  }, [session, shipments.data, q, theme, navigate, qc]);

  const choose = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(items[active]); }
  };

  useEffect(() => {
    document.getElementById(`cp-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  let lastGroup = "";
  return (
    <dialog
      ref={ref}
      aria-label="Find a shipment or page"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="ct-dialog mx-auto mt-[12vh] w-[min(620px,calc(100vw-32px))] overflow-hidden rounded-lg border border-line bg-surface p-0 text-ink shadow-[0_30px_80px_-20px_rgb(27_34_48/0.5)] backdrop:bg-[rgb(11_15_21/0.55)]"
    >
      {open && (
        <div>
          <div className="flex items-center gap-3 border-b border-line px-4">
            <MagnifyingGlass size={20} weight="bold" aria-hidden className="text-muted" />
            <input
              ref={input}
              value={q}
              onChange={(e) => { setQ(e.target.value); setActive(0); }}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-expanded="true"
              aria-controls="cp-list"
              aria-activedescendant={items[active] ? `cp-${active}` : undefined}
              aria-label="Search shipments, pages and actions"
              placeholder="Type a shipment, customer or page"
              className="h-14 flex-1 bg-transparent text-lead outline-none placeholder:text-muted focus-visible:shadow-none focus-visible:outline-none"
            />
            <kbd className="rounded-sm border border-line-strong px-1.5 text-meta text-muted">Esc</kbd>
          </div>
          <ul id="cp-list" role="listbox" className="max-h-[min(420px,60dvh)] overflow-y-auto p-2">
            {items.length === 0 && <li className="px-3 py-8 text-center text-body text-muted">Nothing matches "{q}". Try a shipment number such as SHP-1001.</li>}
            {items.map((it, n) => {
              const header = it.group !== lastGroup ? it.group : null;
              lastGroup = it.group;
              const on = n === active;
              return (
                <li key={it.id} role="presentation">
                  {header && <p className="px-3 pb-1 pt-3 text-meta font-semibold text-muted">{header}</p>}
                  <div
                    id={`cp-${n}`}
                    role="option"
                    aria-selected={on}
                    onMouseMove={() => setActive(n)}
                    onClick={() => choose(it)}
                    className={`relative flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 ${on ? "bg-accent-soft" : ""}`}
                  >
                    {on && <span aria-hidden className="absolute inset-y-2 left-0 w-1 rounded-full bg-accent" />}
                    <it.icon size={18} weight={on ? "fill" : "regular"} aria-hidden className="shrink-0 text-ink-2" />
                    <span className="min-w-0 flex-1 truncate text-body font-medium">{it.label}</span>
                    {it.hint && <span className="shrink-0 text-meta text-muted">{it.hint}</span>}
                    {on && <ArrowBendDownLeft size={16} aria-hidden className="shrink-0 text-muted" />}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="border-t border-line px-4 py-2 text-meta text-muted">Arrow keys to move, Enter to open, Esc to close.</p>
        </div>
      )}
    </dialog>
  );
}
