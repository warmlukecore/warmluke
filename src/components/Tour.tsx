"use client";

// ─────────────────────────────────────────────────────────────
// Tour — a short look round the app, the first time it opens after
// onboarding.
//
// After the 21st.dev "Product Tour" (laziekiki): the page dims, a
// spotlight glides from one real thing to the next, and a card beside it
// says what it is. Here it is the browser's own modal <dialog>, so focus
// stays in the card, Escape leaves, and nothing behind it can be clicked
// by accident; and the motion is CSS, which stops under reduced motion.
//
// A stop names what it points at as a selector list; the first match on
// screen is the one lit. Nothing on screen (a phone, where the sidebar is
// a drawer, or the sidebar folded to a rail), and the card sits on its own.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { button, iconButton } from "@/components/ui/controls";

export type TourStop = { key: string; target?: string; title: string; body: string };

/** How a tour ended: gone to the end, or closed at a stop (1-based). */
export type TourEnd = { finished: boolean; reached: number; stop: string };

type Rect = { top: number; left: number; width: number; height: number };

const PAD = 6;
const GAP = 12;
const EDGE = 12;
/** Below this the card is a sheet along the bottom, as a phone's dialogs are. */
const PHONE = 640;

/** The first match that is on screen. */
function find(selector: string | undefined): HTMLElement | null {
  if (!selector) return null;
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth) return el;
  }
  return null;
}

export function Tour({ stops, onClose }: { stops: TourStop[]; onClose: (end: TourEnd) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  // Said once: a browser that closes the dialog itself would say it twice.
  const ended = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [at, setAt] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [size, setSize] = useState({ w: 320, h: 170 });
  const [vp, setVp] = useState({ w: 1024, h: 768 });
  const stop = stops[at];
  const last = at === stops.length - 1;
  // Strings, not the stop: the page builds its list afresh on every render.
  const target = stop?.target;
  const title = stop?.title;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  // Where the stop is, and again whenever the page moves under it.
  useEffect(() => {
    find(target)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const measure = () => {
      setVp({ w: window.innerWidth, h: window.innerHeight });
      const r = find(target)?.getBoundingClientRect();
      setRect(r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null);
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [target]);

  // The card's own size, for placing it, and Next ready for a key, at each stop.
  useLayoutEffect(() => {
    if (!title) return;
    const r = card.current?.getBoundingClientRect();
    if (r) setSize({ w: r.width, h: r.height });
    card.current?.querySelector<HTMLElement>("[data-tour-next]")?.focus();
  }, [title]);

  const end = useCallback(
    (finished: boolean) => {
      if (ended.current) return;
      ended.current = true;
      onClose({ finished, reached: at + 1, stop: stops[at]?.key ?? "" });
    },
    [at, stops, onClose]
  );
  const next = useCallback(() => (last ? end(true) : setAt((i) => i + 1)), [last, end]);
  const back = useCallback(() => setAt((i) => Math.max(0, i - 1)), []);

  if (!stop) return null;

  const phone = vp.w < PHONE;
  const spot = rect && {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };
  // Below it, else above, else to its right, else its left; centred with nothing to point at.
  let left = vp.w / 2 - size.w / 2;
  let top = vp.h / 2 - size.h / 2;
  if (spot && !phone) {
    const cx = spot.left + spot.width / 2;
    const cy = spot.top + spot.height / 2;
    if (spot.top + spot.height + GAP + size.h < vp.h) [left, top] = [cx - size.w / 2, spot.top + spot.height + GAP];
    else if (spot.top - GAP - size.h > 0) [left, top] = [cx - size.w / 2, spot.top - GAP - size.h];
    else if (spot.left + spot.width + GAP + size.w < vp.w)
      [left, top] = [spot.left + spot.width + GAP, cy - size.h / 2];
    else [left, top] = [spot.left - GAP - size.w, cy - size.h / 2];
  }
  left = Math.min(Math.max(EDGE, left), vp.w - EDGE - size.w);
  top = Math.min(Math.max(EDGE, top), vp.h - EDGE - size.h);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        end(false);
      }}
      onClose={() => end(false)}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") next();
        if (e.key === "ArrowLeft") back();
      }}
      className="wl-tour fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none bg-transparent p-0 outline-none"
    >
      {/* The page dimmed round what is lit: one shadow, so it can glide. */}
      <div
        aria-hidden
        className="pointer-events-none fixed rounded-card transition-[top,left,width,height] duration-300 ease-out motion-reduce:transition-none"
        style={
          spot
            ? { ...spot, boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.45), 0 0 0 2px var(--color-surface)" }
            : { top: "50%", left: "50%", width: 0, height: 0, boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.45)" }
        }
      />
      <div
        ref={card}
        className={`fixed rounded-card bg-surface p-4 text-fg shadow-dialog transition-[top,left] duration-300 ease-out motion-reduce:transition-none ${
          // A phone's sheet at the bottom, unless what it points at is down there.
          phone ? (spot && spot.top > vp.h / 2 ? "inset-x-3 top-3" : "inset-x-3 bottom-3") : "w-80"
        }`}
        style={phone ? undefined : { top, left }}
      >
        <div className="flex items-start gap-3">
          <h2 id={titleId} className="min-w-0 flex-1 text-[14px] leading-snug font-semibold">
            {stop.title}
          </h2>
          <button
            type="button"
            onClick={() => end(false)}
            aria-label="Close the tour"
            className={`${iconButton} -mt-1 -mr-1`}
          >
            <X aria-hidden size={15} strokeWidth={1.75} />
          </button>
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">{stop.body}</p>
        <div className="mt-4 flex items-center gap-2">
          <div className="flex flex-1 items-center gap-1.5" role="img" aria-label={`${at + 1} of ${stops.length}`}>
            {stops.map((s, i) => (
              <span
                key={s.title}
                className={`h-1.5 rounded-full transition-all duration-300 motion-reduce:transition-none ${
                  i === at ? "w-4 bg-fg" : "w-1.5 bg-line-strong"
                }`}
              />
            ))}
          </div>
          {at > 0 && (
            <button type="button" onClick={back} className={button("plain", "sm")}>
              <ArrowLeft aria-hidden size={13} strokeWidth={2} />
              Back
            </button>
          )}
          <button type="button" data-tour-next onClick={next} className={button("primary", "sm")}>
            {last ? "Done" : "Next"}
            {!last && <ArrowRight aria-hidden size={13} strokeWidth={2} />}
          </button>
        </div>
      </div>
    </dialog>
  );
}
