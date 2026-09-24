"use client";

// The globe of where a store's orders come from, in WebGL by cobe.
// Callers: src/components/Landing.tsx (Ask Luke).

import { useEffect, useRef } from "react";

/**
 * Where a store's orders come from, and the store they come to: Mumbai
 * in the middle, the rest arcing into it. The drawn store of the page.
 */
const ORDER_CITIES: Array<[number, number]> = [
  [19.076, 72.8777], // Mumbai, the store
  [28.6139, 77.209], // Delhi
  [12.9716, 77.5946], // Bengaluru
  [25.2048, 55.2708], // Dubai
  [51.5072, -0.1276], // London
  [1.3521, 103.8198], // Singapore
  [40.7128, -74.006], // New York
];

/**
 * A globe in WebGL, by cobe (about 6 KB, fetched only once the page is
 * running, so the first screen never waits on it). It turns slowly, a
 * drag spins it, and it stops drawing while it is off screen. With
 * reduced motion it is drawn once and left still; without WebGL, cobe
 * draws nothing and the section reads the same without it.
 */
export function OrdersGlobe({ className }: { className: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let globe: { update: (s: { phi?: number; width?: number; height?: number }) => void; destroy: () => void } | null = null;
    let frame = 0;
    let phi = 4.4;
    let spin = 0;
    let from: number | null = null;
    let seen = false;
    let gone = false;
    const px = () => Math.max(1, el.offsetWidth * 2);
    const draw = () => globe?.update({ phi: phi + spin });
    const tick = () => {
      frame = 0;
      if (from === null) phi += 0.0025;
      draw();
      if (seen && !still) frame = requestAnimationFrame(tick);
    };
    const run = () => {
      if (!frame && globe && seen && !still) frame = requestAnimationFrame(tick);
    };
    const look = new IntersectionObserver(([e]) => {
      seen = e.isIntersecting;
      run();
    });
    look.observe(el);
    const down = (e: PointerEvent) => {
      from = e.clientX - spin * 300;
      el.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      if (from === null) return;
      spin = (e.clientX - from) / 300;
      if (still) draw();
    };
    const up = () => {
      from = null;
      el.style.cursor = "";
    };
    const fit = () => globe?.update({ width: px(), height: px() });
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("resize", fit);
    const [home, ...rest] = ORDER_CITIES;
    import("cobe").then(({ default: createGlobe }) => {
      if (gone) return;
      globe = createGlobe(el, {
        devicePixelRatio: 2,
        width: px(),
        height: px(),
        phi,
        theta: 0.28,
        dark: 0,
        diffuse: 1.2,
        mapSamples: 16000,
        mapBrightness: 5,
        baseColor: [1, 1, 1],
        markerColor: [0.39, 0.4, 0.95],
        glowColor: [0.93, 0.93, 1],
        markers: ORDER_CITIES.map((location, i) => ({ location, size: i === 0 ? 0.1 : 0.05 })),
        arcs: rest.map((city) => ({ from: city, to: home })),
        arcColor: [0.39, 0.4, 0.95],
        arcWidth: 0.6,
        arcHeight: 0.28,
        markerElevation: 0.01,
      });
      draw();
      el.style.opacity = "1";
      run();
    });
    return () => {
      gone = true;
      cancelAnimationFrame(frame);
      look.disconnect();
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("resize", fit);
      globe?.destroy();
    };
  }, []);
  // cobe wraps the canvas in a div of its own, filling its parent, so
  // the placing is done on this box and the canvas only fills it.
  return (
    <div aria-hidden="true" className={`aspect-square ${className}`}>
      <canvas
        ref={canvas}
        className="h-full w-full cursor-grab touch-pan-y opacity-0 transition-opacity duration-1000"
      />
    </div>
  );
}
