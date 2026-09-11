"use client";

// ─────────────────────────────────────────────────────────────
// Landing — Lovable-style: one big prompt box, dead simple.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser, savePendingPrompt } from "@/lib/auth";

const EXAMPLES = [
  "I lose track of which jobs are done and which are still pending",
  "I need to know what stock I have before I promise a delivery date",
  "My team keeps double-booking the same slot",
];

export default function Landing() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [prompt, setPrompt] = useState("");

  function startBuilding() {
    const text = prompt.trim();
    if (user) {
      if (text) savePendingPrompt(text);
      router.push("/dashboard");
    } else {
      if (text) savePendingPrompt(text);
      router.push("/signup");
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      {/* Nav */}
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6 sm:py-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 text-sm font-bold text-white">
            A
          </div>
          <span className="font-display text-base font-semibold tracking-tight">
            Warmluke
          </span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {!loading && user ? (
            <Link
              href="/dashboard"
              className="rounded-lg bg-white px-4 py-2 font-medium text-slate-900 transition-colors hover:bg-slate-200"
            >
              Go to dashboard →
            </Link>
          ) : (
            <>
              <Link href="/login" className="text-slate-300 transition-colors hover:text-white">
                Sign in
              </Link>
              <Link
                href="/signup"
                className="rounded-lg bg-white px-4 py-2 font-medium text-slate-900 transition-colors hover:bg-slate-200"
              >
                Start free
              </Link>
            </>
          )}
        </div>
      </header>

      {/* Hero */}
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center px-4 py-12 text-center sm:px-6 sm:py-16">
        <div className="mb-5 rounded-full border border-slate-800 bg-slate-900 px-4 py-1.5 text-xs text-slate-400">
          Build a business app by describing it — no code, no templates
        </div>
        <h1 className="font-display text-4xl font-bold leading-tight tracking-tight sm:text-6xl">
          Describe your business.
          <br />
          <span className="bg-gradient-to-r from-blue-400 to-cyan-300 bg-clip-text text-transparent">
            Get a working app.
          </span>
        </h1>
        <p className="mt-5 max-w-xl text-base text-slate-400">
          Describe the problem in your own words. It asks how you actually
          work, shows you the plan, then builds it live — and you can change
          anything by chatting. Your data stays yours, in your own workspace.
        </p>

        {/* The prompt box */}
        <div className="mt-10 w-full">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-2 shadow-2xl shadow-blue-500/5 focus-within:border-blue-500/50">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  startBuilding();
                }
              }}
              rows={3}
              placeholder="What problem are you trying to solve? e.g. “I keep losing track of which jobs are done and which are still pending”"
              className="w-full resize-none bg-transparent px-4 py-3 text-left text-base outline-none placeholder:text-slate-500"
            />
            <div className="flex items-center justify-between px-3 pb-1">
              <span className="text-xs text-slate-500">
                Free while in beta · nothing hardcoded
              </span>
              <button
                onClick={startBuilding}
                disabled={!prompt.trim()}
                className="rounded-xl bg-gradient-to-r from-blue-500 to-cyan-400 px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                Start building →
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {EXAMPLES.map((e) => (
              <button
                key={e}
                onClick={() => setPrompt(e)}
                className="rounded-full border border-slate-800 px-3.5 py-1.5 text-xs text-slate-400 transition-colors hover:border-slate-600 hover:text-slate-200"
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      </main>

      {/* How it works */}
      <section className="border-t border-slate-900 bg-slate-950">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:grid-cols-3 sm:px-6 sm:py-14">
          {[
            {
              step: "1",
              title: "Describe it",
              body: "One prompt builds your sections — products, orders, customers — with realistic demo data.",
            },
            {
              step: "2",
              title: "Chat to change it",
              body: "“Move Orders up”, “add a discount field”, “show total revenue”. Every change previews first.",
            },
            {
              step: "3",
              title: "Own your data",
              body: "Your workspace is isolated and versioned. Roll back anything, export your API later.",
            },
          ].map((s) => (
            <div key={s.step} className="rounded-2xl border border-slate-900 bg-slate-900/50 p-6">
              <div className="font-display text-sm font-semibold text-blue-400">
                Step {s.step}
              </div>
              <div className="font-display mt-2 text-lg font-semibold">{s.title}</div>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-slate-900 py-6 text-center text-xs text-slate-600">
        Warmluke — every app is generated, versioned, and reversible.
      </footer>
    </div>
  );
}
