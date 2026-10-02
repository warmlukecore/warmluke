"use client";

// The edge a panel is resized by: the drag cursor over a strip as wide
// as the gap between panels, and a grip in its middle that is always
// faintly there, brighter under the pointer and in Luke's colour while
// dragged. Under the pointer the whole edge lights in Luke's colour too,
// with a soft glow that follows it up and down, so the place to take
// hold of reads before anyone has to find the cursor change. It was a 6px strip whose only mark was a 1px line on hover,
// so nobody found it. A separator to assistive tech: arrow keys resize
// (Shift for bigger steps), double-click and Enter put it back.
//
// Callers: src/components/AppShell.tsx (the sidebar), ChatPanel (Luke).

export function ResizeHandle({
  edge,
  label,
  width,
  min,
  max,
  dragging,
  onPointerDown,
  onReset,
  onNudge,
}: {
  /** Which side of its panel it sits on: the sidebar's right edge, Luke's left. */
  edge: "left" | "right";
  label: string;
  width: number;
  min: number;
  max: number;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onReset: () => void;
  onNudge: (delta: number) => void;
}) {
  // The side that grows the panel: away from it.
  const grow = edge === "left" ? "ArrowRight" : "ArrowLeft";
  const shrink = edge === "left" ? "ArrowLeft" : "ArrowRight";
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      // Where the glow sits: set on the element, so following the pointer re-renders nothing.
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty("--grip-y", `${e.clientY - r.top}px`);
      }}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        if (e.key === grow) onNudge(step);
        else if (e.key === shrink) onNudge(-step);
        else if (e.key === "Enter") onReset();
        else return;
        e.preventDefault();
      }}
      className={`group/resize absolute inset-y-0 z-50 hidden w-3 cursor-col-resize touch-none outline-none lg:block ${
        edge === "left" ? "-right-2" : "-left-2"
      }`}
    >
      <span
        aria-hidden
        className={`absolute inset-y-3 left-1/2 w-px -translate-x-1/2 rounded-full transition-colors duration-150 motion-reduce:transition-none ${
          dragging ? "bg-luke-light/70" : "bg-transparent group-hover/resize:bg-luke-light/45"
        }`}
      />
      <span
        aria-hidden
        style={{ top: "var(--grip-y, 50%)" }}
        className={`pointer-events-none absolute left-1/2 h-28 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-luke-light blur-[6px] transition-opacity duration-200 motion-reduce:transition-none ${
          dragging ? "opacity-60" : "opacity-0 group-hover/resize:opacity-50"
        }`}
      />
      <span
        aria-hidden
        className={`absolute top-1/2 left-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-150 ${
          dragging
            ? "bg-luke-light"
            : "bg-frame-line group-hover/resize:bg-frame-fg-muted group-focus-visible/resize:bg-luke-light"
        }`}
      />
    </div>
  );
}
