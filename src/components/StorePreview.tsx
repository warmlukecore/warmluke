"use client";

// ─────────────────────────────────────────────────────────────
// A glimpse of the app, on the first screen: the frame it stands in.
//
// The app itself is src/components/StorePreviewApp.tsx. Until the page's
// script has run and the box is measured, a skeleton in the app's own
// shape holds its place, drawn by the server, so the first paint already
// shows where the app will be and nothing moves when it lands. (It is not
// loaded lazily: its own code is a few kilobytes, and a second round trip
// only made the glimpse arrive later.)
//
// That needs the box's height before any script runs, so the height is a
// fixed share of the width (the aspect classes below, and RATIO), and the
// app is drawn at the visitor's own screen width at that share, then
// zoomed into the column. The app's breakpoints read the window, not this
// box, so drawn at any other width its layout would be chosen for a screen
// it is not on: a phone sees the phone app, a laptop the laptop's.
//
// Light or dark, as the app can be: the switch in its header works on the
// glimpse alone and starts light for every visitor, neither reading nor
// changing the theme a signed-in person chose. The clock is the visitor's.
//
// Drawn only in the browser: the greeting and the dates are the visitor's
// today, which the server rendering the page cannot know.
//
// Callers: src/app/page.tsx.
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import type { Theme } from "@/lib/theme";
import GlimpseApp from "@/components/StorePreviewApp";

/** The app's own switch: its sidebar docks at lg. Tablets start at sm. */
const APP_DOCKS_AT = 1024;
const TABLET_FROM = 640;
/** The widest the laptop app is drawn, so a wide monitor's glimpse is not zoomed into words too small to read. */
const MAX_W = 1440;
/** Height over width, per layout: the same shares the box's aspect classes say, so the two cannot disagree. */
const RATIO = { phone: 700 / 390, tablet: 9 / 10, laptop: 820 / 1440 };

type Drawn = { w: number; h: number; narrow: boolean };
function drawnFor(): Drawn {
  const vw = window.innerWidth;
  if (vw >= APP_DOCKS_AT) {
    const w = Math.min(MAX_W, vw);
    return { w, h: Math.round(w * RATIO.laptop), narrow: false };
  }
  return { w: vw, h: Math.round(vw * (vw < TABLET_FROM ? RATIO.phone : RATIO.tablet)), narrow: true };
}

/**
 * The app's shape, before the app: the dark frame, its sidebar and Luke's
 * panel on a laptop, the canvas with its figures, chart and lists. Pure
 * markup, so it is on the first paint.
 */
function Skeleton() {
  const bar = "rounded bg-frame-raised";
  const block = "rounded-lg bg-surface motion-safe:animate-pulse";
  return (
    <div aria-hidden="true" className="absolute inset-0 flex bg-frame lg:gap-[0.55%] lg:p-[0.55%] lg:pl-0">
      <div className="hidden w-[16.7%] shrink-0 flex-col gap-[2.5%] p-[1.1%] lg:flex">
        <div className={`${bar} h-[3.5%] w-3/4`} />
        <div className={`${bar} h-[3.5%] w-full`} />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={`${bar} h-[3%] w-2/3 opacity-60`} />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-[3%] bg-canvas p-[4%] lg:rounded-xl lg:p-[1.8%]">
        <div className="h-[4%] w-1/3 rounded bg-surface-hover" />
        <div className="grid h-[16%] grid-cols-2 gap-[3%] lg:grid-cols-4 lg:gap-[1.5%]">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={block} />
          ))}
        </div>
        <div className={`${block} h-[26%]`} />
        <div className="grid flex-1 gap-[1.5%] lg:grid-cols-2">
          <div className={block} />
          <div className={`${block} hidden lg:block`} />
        </div>
      </div>
      <div className="hidden w-[26.4%] shrink-0 flex-col items-center justify-center gap-[2.5%] rounded-xl bg-surface lg:flex">
        <div className="aspect-square w-[14%] rounded-full bg-luke-pale motion-safe:animate-pulse" />
        <div className="h-[2.5%] w-1/2 rounded bg-surface-hover" />
        <div className="h-[2%] w-2/3 rounded bg-surface-hover opacity-70" />
      </div>
    </div>
  );
}

export function StorePreview() {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const [now, setNow] = useState(0);
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    setNow(Date.now());
    // Often enough that "synced" and the greeting turn over on time.
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const el = box.current;
    // The column and the window change together when a window is
    // resized or a phone turned, and either changes what is drawn.
    const measure = () => {
      if (el) setWidth(el.clientWidth);
      setDrawn(drawnFor());
    };
    const ro = new ResizeObserver(measure);
    if (el) ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      clearInterval(tick);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return (
    <section
      aria-label="A glimpse of Warmluke, on a sample store"
      // Open at the bottom, standing on the first screen's edge: a window
      // coming up out of the page, not a card floating above it.
      className="rounded-t-2xl px-2 pt-2 md:px-3 md:pt-3"
      style={{
        background: "rgb(255 255 255 / 0.55)",
        border: "1px solid rgb(255 255 255 / 0.6)",
        borderBottom: "none",
        boxShadow: "var(--shadow-dashboard)",
      }}
    >
      {/* The bottom fades out: this is a look in, not the whole app. */}
      <div
        ref={box}
        data-theme={theme}
        className="relative aspect-[390/700] overflow-hidden rounded-t-xl text-left [mask-image:linear-gradient(to_bottom,black_80%,transparent)] sm:aspect-[10/9] lg:aspect-[1440/820]"
      >
        <Skeleton />
        {width && drawn ? (
          <div
            className="rise absolute top-0 left-0 [--rise-after:0s] [--rise-for:0.4s] [--rise-from:0px]"
            style={{ width: drawn.w, height: drawn.h, zoom: width / drawn.w }}
          >
            <GlimpseApp now={now} narrow={drawn.narrow} theme={theme} onTheme={setTheme} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
