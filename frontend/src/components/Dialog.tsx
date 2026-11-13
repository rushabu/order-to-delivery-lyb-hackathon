import { useEffect, useRef, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";

/*
  Modal dialog on the native <dialog> element.
  - showModal() makes the rest of the page inert, so focus cannot leave the dialog into the page.
  - Escape closes it (native "cancel" event).
  - Focus moves to `initialFocus` (or the first control) on open and returns to whatever had focus
    before it opened, on close (DESIGN.md 7.6).
*/
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  initialFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
      const target = initialFocusRef?.current ?? dialog.querySelector<HTMLElement>("button, [href], input, textarea, select");
      target?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, initialFocusRef]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onNativeClose = () => {
      returnTo.current?.focus?.();
      returnTo.current = null;
    };
    dialog.addEventListener("close", onNativeClose);
    return () => dialog.removeEventListener("close", onNativeClose);
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      aria-describedby={description ? "dialog-desc" : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="ct-dialog m-auto w-[min(560px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] overflow-auto rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-[rgb(11_15_21/0.55)]"
    >
      {open && (
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <h2 id="dialog-title" className="text-heading font-semibold">
              {title}
            </h2>
            <button type="button" onClick={onClose} className="-m-2 rounded-md p-2 text-muted hover:bg-sunken hover:text-ink" aria-label="Close">
              <X size={20} weight="bold" aria-hidden />
            </button>
          </div>
          {description && (
            <div id="dialog-desc" className="mt-1 text-body text-muted">
              {description}
            </div>
          )}
          <div className="mt-5">{children}</div>
        </div>
      )}
    </dialog>
  );
}
