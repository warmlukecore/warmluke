"use client";

// ─────────────────────────────────────────────────────────────
// When the connection drops, and when it comes back.
//
// Offline, a small panel says so and that nothing is lost, with a game to
// pass the wait (Luke hopping parcels, like the browser's own dinosaur).
// It does not cover the page: what is already on screen stays readable.
// The browser's online event is only a hint, so the way back is confirmed
// by asking this site for something small; until that answers, the panel
// stays.
//
// Back online, it says so for a moment, and the screens that re-read
// their data when a tab comes back into view (the app shell, the
// overview) are told to, by the same event, so what they show is current.
// Supabase's own connections reconnect by themselves.
//
// Callers: src/app/layout.tsx.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, WifiOff, Wifi } from "lucide-react";

/** How often to look for the way back while offline. */
const RETRY_MS = 5000;

/** Whether this site answers: the icon, built once, is the cheapest thing it serves. */
async function reachable(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`/icon?ping=${Date.now()}`, { method: "HEAD", cache: "no-store", signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export function ConnectionWatch() {
  const [offline, setOffline] = useState(false);
  const [back, setBack] = useState(false);
  const [small, setSmall] = useState(false);

  const recovered = useCallback(() => {
    setOffline(false);
    setSmall(false);
    setBack(true);
    // The screens that refresh on coming back into view, told to.
    document.dispatchEvent(new Event("visibilitychange"));
    setTimeout(() => setBack(false), 3500);
  }, []);

  useEffect(() => {
    if (!navigator.onLine) setOffline(true);
    const down = () => setOffline(true);
    const up = async () => {
      if (await reachable()) recovered();
    };
    window.addEventListener("offline", down);
    window.addEventListener("online", up);
    return () => {
      window.removeEventListener("offline", down);
      window.removeEventListener("online", up);
    };
  }, [recovered]);

  // While offline, keep looking: the online event does not always come.
  useEffect(() => {
    if (!offline) return;
    const t = setInterval(async () => {
      if (navigator.onLine && (await reachable())) recovered();
    }, RETRY_MS);
    return () => clearInterval(t);
  }, [offline, recovered]);

  if (back) {
    return (
      <div
        role="status"
        className="font-ui pop fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full bg-primary px-4 py-2 text-[13px] whitespace-nowrap text-on-primary shadow-popover"
      >
        <Wifi aria-hidden size={15} strokeWidth={1.75} />
        Back online. Everything is up to date.
      </div>
    );
  }
  if (!offline) return null;

  if (small) {
    return (
      <button
        onClick={() => setSmall(false)}
        className="font-ui pop fixed right-4 bottom-4 z-[60] flex items-center gap-2 rounded-full bg-surface px-3.5 py-2 text-[13px] text-fg shadow-popover"
      >
        <WifiOff aria-hidden size={15} strokeWidth={1.75} className="text-signal-attention" />
        Offline
      </button>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="font-ui pop fixed inset-x-3 bottom-3 z-[60] mx-auto max-w-sm rounded-card bg-surface p-4 text-fg shadow-popover sm:right-4 sm:left-auto sm:mx-0"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-tone-attention text-tone-attention-fg">
          <WifiOff aria-hidden size={16} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">You’re offline</div>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
            Nothing you did is lost. This carries on by itself the moment you’re back.
          </p>
        </div>
        <button
          onClick={() => setSmall(true)}
          aria-label="Make this smaller"
          className="-mt-1 -mr-1 rounded-control p-1.5 text-fg-faint hover:bg-surface-hover hover:text-fg"
        >
          <Minus aria-hidden size={15} strokeWidth={1.75} />
        </button>
      </div>
      <Hop />
    </div>
  );
}

/**
 * Luke hops parcels while the wait goes on. Space, a tap or a click
 * jumps; the parcels come faster the longer it runs. The best score is
 * kept in this browser.
 */
function Hop() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(0);
  const [phase, setPhase] = useState<"ready" | "running" | "over">("ready");
  const jumpRef = useRef<() => void>(() => {});

  useEffect(() => {
    try {
      setBest(Number(localStorage.getItem("wl-hop-best") ?? 0) || 0);
    } catch {
      // A private window keeps no best; the game still plays.
    }
  }, []);

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const css = getComputedStyle(document.documentElement);
    const luke = css.getPropertyValue("--color-luke").trim() || "hsl(243 75% 59%)";
    const lukeLight = css.getPropertyValue("--color-luke-light").trim() || "hsl(246 100% 75%)";
    const parcel = css.getPropertyValue("--color-signal-attention").trim() || "hsl(33 96% 50%)";
    const ground = css.getPropertyValue("--color-line-strong").trim() || "hsl(0 0% 80%)";
    const W = c.width;
    const H = c.height;
    const FLOOR = H - 14;
    const R = 11;
    let y = FLOOR - R;
    let vy = 0;
    let t = 0;
    let speed = 3.2;
    let points = 0;
    let raf = 0;
    let alive = false;
    let parcels: Array<{ x: number; w: number; h: number }> = [];
    let next = 70;

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = ground;
      ctx.fillRect(0, FLOOR, W, 1.5);
      // Luke: an orb with two eyes, the way the app draws him.
      const g = ctx.createRadialGradient(34, y - 4, 2, 36, y, R);
      g.addColorStop(0, lukeLight);
      g.addColorStop(1, luke);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(36, y, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillRect(32, y - 3, 2.2, 5);
      ctx.fillRect(38, y - 3, 2.2, 5);
      for (const p of parcels) {
        ctx.fillStyle = parcel;
        ctx.fillRect(p.x, FLOOR - p.h, p.w, p.h);
        ctx.fillStyle = "rgb(255 255 255 / 0.5)";
        ctx.fillRect(p.x + p.w / 2 - 1, FLOOR - p.h, 2, p.h);
      }
    };

    const step = () => {
      t++;
      vy += 0.55;
      y = Math.min(FLOOR - R, y + vy);
      if (--next <= 0) {
        parcels.push({ x: W, w: 12 + Math.random() * 10, h: 12 + Math.random() * 16 });
        next = 55 + Math.random() * 60;
      }
      for (const p of parcels) p.x -= speed;
      parcels = parcels.filter((p) => p.x + p.w > 0);
      if (t % 6 === 0) setScore(++points);
      speed = 3.2 + points / 120;
      const hit = parcels.some((p) => 36 + R - 3 > p.x && 36 - R + 3 < p.x + p.w && y + R - 2 > FLOOR - p.h);
      draw();
      if (hit) {
        alive = false;
        setPhase("over");
        setBest((b) => {
          const nb = Math.max(b, points);
          try {
            localStorage.setItem("wl-hop-best", String(nb));
          } catch {
            // Not kept, still played.
          }
          return nb;
        });
        return;
      }
      raf = requestAnimationFrame(step);
    };

    const start = () => {
      parcels = [];
      next = 70;
      points = 0;
      speed = 3.2;
      y = FLOOR - R;
      vy = 0;
      setScore(0);
      setPhase("running");
      alive = true;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(step);
    };

    jumpRef.current = () => {
      if (!alive) return start();
      if (y >= FLOOR - R - 0.5) vy = -8.6;
    };

    const key = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== "ArrowUp") return;
      // Only when nothing else on the page is being typed into or pressed.
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON" || el.isContentEditable)
      )
        return;
      e.preventDefault();
      jumpRef.current();
    };
    window.addEventListener("keydown", key);
    draw();
    return () => {
      window.removeEventListener("keydown", key);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="mt-3">
      <canvas
        ref={canvas}
        width={320}
        height={96}
        onPointerDown={() => jumpRef.current()}
        role="img"
        aria-label="A game: Luke hops over parcels. Press space or tap to jump."
        className="h-24 w-full cursor-pointer touch-none rounded-lg bg-surface-subdued"
      />
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-fg-faint tabular-nums">
        <span>
          {phase === "ready" ? "Tap or press space to play" : phase === "over" ? "Tap to go again" : "Tap to jump"}
        </span>
        <span>
          {score} · best {best}
        </span>
      </div>
    </div>
  );
}
