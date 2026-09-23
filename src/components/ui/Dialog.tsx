"use client";

// One dialog for the whole app, so no two open at different widths or
// with their close button somewhere else. It is the browser's own modal
// <dialog>: focus stays inside it, Escape closes it, and it sits above
// every drawer and panel without a z-index to get wrong. On a phone it
// rises from the bottom as a sheet.
//
// It opens when it mounts and is gone when it unmounts — the screens
// already decide that with `{open && <Dialog …/>}`.

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { iconButton } from "@/components/ui/controls";

export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  tall = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Buttons along the bottom, outside the part that scrolls. */
  footer?: ReactNode;
  /** The full height from the start, so switching between tabs inside does not resize it. */
  tall?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // A drag that starts inside — selecting text in a field — and ends
  // over the backdrop is not a click on the backdrop.
  const downOnBackdrop = useRef(false);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const d = ref.current;
    if (!d || d.open) return;
    d.showModal();
    // Focus the field that asked for it, or the dialog itself — never
    // the close button, and never a keyboard popping up on a phone for
    // a dialog that is mostly read.
    const wanted = d.querySelector<HTMLElement>("[data-autofocus]");
    (wanted ?? d).focus();
  }, []);

  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      aria-labelledby={titleId}
      // Escape: the page decides, by unmounting it.
      onCancel={(e) => {
        e.preventDefault();
        close.current();
      }}
      // A browser that closes it anyway (a second Escape) still tells the page.
      onClose={() => close.current()}
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) close.current();
        downOnBackdrop.current = false;
      }}
      // m-auto puts back the browser's centring, which the CSS reset takes away.
      className={`wl-dialog m-auto w-[35rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-card bg-surface p-0 text-fg shadow-dialog outline-none max-sm:mb-0 max-sm:w-full max-sm:max-w-full max-sm:rounded-b-none ${
        tall ? "h-[min(40rem,88dvh)]" : ""
      } max-h-[min(44rem,88dvh)]`}
    >
      <div className={`flex flex-col ${tall ? "h-full" : "max-h-[inherit]"}`}>
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[15px] leading-6 font-semibold text-fg">
              {title}
            </h2>
            {description && <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{description}</p>}
          </div>
          <button onClick={() => close.current()} aria-label="Close" className={`${iconButton} -mt-0.5 -mr-1.5`}>
            <X aria-hidden size={16} strokeWidth={1.75} />
          </button>
        </header>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex shrink-0 items-center gap-2 border-t border-line bg-surface-subdued px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </dialog>
  );
}
