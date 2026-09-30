// The shape of what is coming, while it comes: a section's table, the
// sidebar's rows. A slow light crosses each bar (.skeleton, .skeleton-dark
// in globals.css), so a wait reads as on its way rather than broken; it
// stands still under reduced motion. Widths differ row to row, as real
// cells do, so it does not read as a grid of identical boxes.

const WIDTHS = ["w-4/5", "w-3/5", "w-2/3", "w-1/2", "w-3/4", "w-2/5"];

/** A section's table while its rows load: its tools, its head band, a few rows. */
export function SectionSkeleton({ label }: { label?: string }) {
  return (
    <div role="status" aria-label={label ? `Loading ${label}` : "Loading the section"} className="space-y-4">
      <div className="overflow-hidden rounded-card bg-surface shadow-card">
        <div className="border-b border-line px-3 py-2.5">
          <div className="skeleton h-8 w-60 max-w-full rounded-control" />
        </div>
        <div className="p-1.5">
          <div className="flex h-9 items-center gap-4 rounded-lg bg-surface-subdued px-3">
            {[0, 1, 2, 3].map((c) => (
              <div key={c} className="flex-1">
                <div className="skeleton h-2.5 w-1/2" />
              </div>
            ))}
          </div>
          {[0, 1, 2, 3, 4, 5].map((r) => (
            <div key={r} className="flex h-11 items-center gap-4 border-b border-line px-3 last:border-b-0">
              {[0, 1, 2, 3].map((c) => (
                <div key={c} className="flex-1">
                  <div className={`skeleton h-3 ${WIDTHS[(r + c) % WIDTHS.length]}`} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The sidebar's sections while they load, in its dark frame. */
export function NavSkeleton() {
  return (
    <div role="status" aria-label="Loading your sections" className="space-y-1 px-2 py-1">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-2.5 py-2">
          <div className="skeleton-dark h-4 w-4 rounded" />
          <div className={`skeleton-dark h-3 ${WIDTHS[i]}`} />
        </div>
      ))}
    </div>
  );
}
