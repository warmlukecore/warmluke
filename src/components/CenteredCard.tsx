// One card in the middle of the page, with the mark above it: the
// screens a person passes through on the way somewhere — connecting a
// store, opening an invite, letting their own AI in.

import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/ui/Logo";

export function CenteredCard({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="font-ui flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <Link
        href="/"
        className="mb-6 flex items-center gap-2.5 rounded-control focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Logo className="h-6" priority />
        <span className="text-[15px] font-semibold text-fg">Warmluke</span>
      </Link>
      <div
        className={`w-full ${wide ? "max-w-md" : "max-w-sm"} rounded-card bg-surface p-6 text-[13px] leading-relaxed text-fg-muted shadow-card`}
      >
        {children}
      </div>
    </div>
  );
}
