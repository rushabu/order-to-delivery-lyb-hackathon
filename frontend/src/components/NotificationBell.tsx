import { useEffect, useId, useRef, useState } from "react";
import { Bell } from "@phosphor-icons/react";
import { useNavigate } from "react-router";
import { useSession } from "../auth/session";
import { useMarkRead, useNotifications } from "../api/queries";
import { dateTimeTz } from "../lib/time";
import { CrossFade } from "./ui";
import { useToast } from "./Toasts";

/*
  Bell with unread count and a menu of the user's notifications (DESIGN.md 8).
  New notifications that arrive after the page loaded also appear as a toast and are announced.
*/
export function NotificationBell({ align = "right" }: { align?: "left" | "right" }) {
  const { data } = useNotifications();
  const markRead = useMarkRead();
  const toast = useToast();
  const navigate = useNavigate();
  const role = useSession()?.user.role;
  /** Where a notification about this shipment leads, for this role. */
  const target = (id: string | null) =>
    !id ? null : role === "COORDINATOR" ? `/coordinator/shipments/${id}` : role === "CUSTOMER" ? `/customer/shipments/${id}` : role === "DRIVER" ? `/driver?trip=${id}` : null;
  const [open, setOpen] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const menuId = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!data) return;
    if (seen.current === null) {
      seen.current = new Set(data.map((n) => n.id));
      return;
    }
    for (const n of [...data].reverse()) {
      if (!seen.current.has(n.id)) {
        seen.current.add(n.id);
        if (!n.read_at) toast({ title: n.title, body: n.body });
      }
    }
  }, [data, toast]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = data?.filter((n) => !n.read_at).length ?? 0;

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`Notifications, ${unread} unread`}
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-md px-2 text-ink-2 hover:bg-sunken"
      >
        <Bell size={20} weight="bold" aria-hidden />
        <CrossFade value={unread} shift="8px" className="h-5 min-w-5 overflow-hidden">
          {(n) => (
            <span className={`tnum inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 text-meta font-semibold ${n ? "bg-accent text-on-accent" : "bg-sunken text-muted"}`}>{n}</span>
          )}
        </CrossFade>
      </button>
      {open && (
        <div id={menuId} className={`absolute z-[900] mt-2 w-[min(400px,calc(100vw-32px))] rounded-lg border border-line-strong bg-surface ${align === "right" ? "right-0" : "left-0"}`}>
          <h2 className="border-b border-line px-4 py-3 text-body font-semibold">Notifications</h2>
          {!data?.length ? (
            <p className="px-4 py-6 text-body text-muted">No notifications yet.</p>
          ) : (
            <ul className="max-h-[60dvh] overflow-auto">
              {data.map((n) => (
                <li key={n.id} className="border-b border-line last:border-0">
                  <button
                    type="button"
                    onClick={() => {
                      if (!n.read_at) markRead.mutate(n.id);
                      const to = target(n.shipment_id);
                      if (to) {
                        setOpen(false);
                        navigate(to);
                      }
                    }}
                    className="flex w-full gap-3 px-4 py-3 text-left hover:bg-sunken"
                  >
                    <span aria-hidden className={`mt-2 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-accent"}`} />
                    <span className="min-w-0">
                      <span className="block text-body font-medium text-ink">
                        {n.title}
                        {!n.read_at && <span className="sr-only"> (unread)</span>}
                      </span>
                      <span className="block text-meta text-ink-2">{n.body}</span>
                      <span className="tnum block text-meta text-muted">{dateTimeTz(n.created_at)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
