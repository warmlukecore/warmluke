"use client";

// A screen that broke: said plainly, with a way to try again.
//
// Next shows this in place of any page whose rendering threw, and keeps
// the rest of the app where it was. The reference is Next's digest of the
// error, the thing to quote so it can be found in the server's log; the
// error's own words stay out of the page, where they would mean nothing
// to the person reading it and might say more than they should.

import { useEffect } from "react";
import Link from "next/link";
import { CenteredCard } from "@/components/CenteredCard";
import { button } from "@/components/ui/controls";

export default function ScreenError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return (
    <CenteredCard>
      <h1 className="text-lg font-semibold text-fg">
        {offline ? "This screen needs the internet" : "Something went wrong on this screen"}
      </h1>
      <p className="mt-1">
        {offline
          ? "You’re offline. Try again once you’re back; nothing you did is lost."
          : "Trying again usually works. If it keeps happening, tell us what you were doing."}
      </p>
      {error.digest && <p className="mt-2 font-mono text-[11px] text-fg-faint">Reference {error.digest}</p>}
      <div className="mt-5 flex gap-2">
        <button onClick={reset} className={button("primary")}>
          Try again
        </button>
        <Link href="/dashboard" className={button("secondary")}>
          Go to my apps
        </Link>
      </div>
    </CenteredCard>
  );
}
