// A bordered group of settings with a heading: how a long form is cut
// into parts a person can scan. The danger kind is for what cannot be
// undone, and is always the last group on the screen.

import type { ReactNode } from "react";

export function Group({
  title,
  description,
  children,
  danger = false,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <section className={`overflow-hidden rounded-card border ${danger ? "border-tone-critical" : "border-line"}`}>
      <header
        className={`border-b px-4 py-3 ${danger ? "border-tone-critical/70 bg-tone-critical/20" : "border-line bg-surface-subdued"}`}
      >
        <h3 className={`text-[13px] font-semibold ${danger ? "text-tone-critical-fg" : "text-fg"}`}>{title}</h3>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{description}</p>}
      </header>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}
