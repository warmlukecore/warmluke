// Luke's face: an orb in Luke's colour, lit from inside, with two eyes
// that blink. While Luke works, the eyes look from side to side and the
// glow breathes (state="thinking"). The look lives in globals.css
// (.luke-orb, .luke-eye) and stops under reduced motion.
//
// A grain over the orb keeps the gradient from banding; it is an SVG
// filter, so it costs no image.

import { useId } from "react";

const SIZES = {
  xs: { box: "h-5 w-5", eye: "h-1.5 w-[3px]", gap: "gap-[3px]", grain: false },
  sm: { box: "h-7 w-7", eye: "h-2 w-1", gap: "gap-1", grain: true },
  lg: { box: "h-12 w-12", eye: "h-2.5 w-1.5", gap: "gap-2.5", grain: true },
} as const;

export function LukeMark({
  size = "sm",
  state = "idle",
}: {
  size?: keyof typeof SIZES;
  state?: "idle" | "thinking";
}) {
  const s = SIZES[size];
  const grain = `luke-grain-${useId().replace(/\W/g, "")}`;
  return (
    <span
      aria-hidden
      data-state={state}
      className={`luke-orb relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full ${s.box}`}
    >
      {s.grain && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-20 mix-blend-overlay">
          <filter id={grain}>
            <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch" />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter={`url(#${grain})`} />
        </svg>
      )}
      {/* The shine, top left, where the light is. */}
      <span
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 30% 24%, rgb(255 255 255 / 0.75) 0%, rgb(255 255 255 / 0.1) 50%, transparent 70%)",
        }}
      />
      <span className={`luke-eyes relative flex -translate-y-px items-center ${s.gap}`}>
        <span className={`luke-eye rounded-full ${s.eye}`} />
        <span className={`luke-eye rounded-full ${s.eye}`} />
      </span>
    </span>
  );
}
