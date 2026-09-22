"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { takePendingPrompt } from "@/lib/auth";

export default function Signup() {
  const router = useRouter();
  // An invite link lands here when signed out; it has to survive the
  // detour, or the invited person arrives at a dashboard with nothing
  // in it and no way back to the app they were sent to.
  const [next, setNext] = useState<string | null>(null);
  useEffect(() => {
    setNext(new URLSearchParams(window.location.search).get("next"));
  }, []);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signUp({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    // Autoconfirm is on: the session exists immediately.
    if (next?.startsWith("/")) {
      router.replace(next);
    } else if (takePendingPrompt()) {
      router.replace("/dashboard?build=1");
    } else {
      router.replace("/dashboard");
    }
  }

  return (
    <div className="font-ui flex min-h-screen items-center justify-center bg-white px-6 text-ink">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
          <Image
            src="/images/logowarmluke.png"
            alt=""
            width={32}
            height={32}
            priority
            className="h-8 w-8 rounded-lg object-cover"
          />
          <span className="font-serif text-base font-semibold">Warmluke</span>
        </Link>

        <div className="rounded-2xl border border-hair bg-white p-6 shadow-[0_2px_24px_rgb(0_0_0/0.05)]">
          <h1 className="font-serif text-xl font-semibold">Start building free</h1>
          <p className="mt-1 text-sm text-quiet">
            Your own workspace, isolated and versioned.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="text-xs font-medium text-quiet">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-xl border border-hair bg-white px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                placeholder="you@company.com"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-quiet">Password</label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-xl border border-hair bg-white px-3 py-2.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                placeholder="At least 8 characters"
              />
            </div>
            {error && (
              <div className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-full bg-ink py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Creating account…" : "Create account"}
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-neutral-400">
            Already have an account?{" "}
            <Link
              href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"}
              className="text-accent hover:underline"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
