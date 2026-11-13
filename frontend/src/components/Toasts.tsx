import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bell, X } from "@phosphor-icons/react";
import { duration, easeOut } from "../lib/motion";

/*
  Toasts slide in at the bottom right and leave after 7 seconds.
  Every toast is also written to a polite live region so screen readers announce new alerts
  without interrupting (DESIGN.md 7.6). Toasts never hold information that is not also on the page
  or in the bell menu.
*/
interface Toast {
  id: number;
  title: string;
  body?: string;
}

const ToastContext = createContext<(t: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = nextId.current++;
      setToasts((list) => [...list.slice(-2), { ...t, id }]); // at most three on screen
      setAnnouncement(`${t.title}. ${t.body ?? ""}`);
      setTimeout(() => dismiss(id), 7000);
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[1000] flex flex-col items-end gap-2 sm:left-auto sm:right-4 sm:w-[380px]">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ duration: duration.base, ease: easeOut }}
              className="pointer-events-auto flex w-full items-start gap-3 rounded-lg border border-line-strong bg-surface p-4"
            >
              <Bell size={18} weight="bold" aria-hidden className="mt-0.5 shrink-0 text-accent-ink" />
              <div className="min-w-0 flex-1">
                <p className="text-body font-semibold text-ink">{t.title}</p>
                {t.body && <p className="mt-0.5 text-meta text-ink-2">{t.body}</p>}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss notification" className="-m-1 rounded-sm p-1 text-muted hover:text-ink">
                <X size={16} weight="bold" aria-hidden />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
