"use client";

// The last net: the root layout itself broke, so nothing of the app's
// frame is left to draw inside. Plain markup and the stylesheet, and a
// way to try again.

import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body className="font-ui flex min-h-dvh items-center justify-center bg-canvas px-4 text-fg">
        <div className="w-full max-w-sm rounded-card bg-surface p-6 text-[13px] text-fg-muted shadow-card">
          <h1 className="text-lg font-semibold text-fg">Warmluke couldn’t load</h1>
          <p className="mt-1">Trying again usually works. If it keeps happening, tell us.</p>
          {error.digest && <p className="mt-2 font-mono text-[11px] text-fg-faint">Reference {error.digest}</p>}
          <button onClick={reset} className="mt-5 rounded-control bg-primary px-3 py-2 text-[13px] font-medium text-on-primary">
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
