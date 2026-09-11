"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { takePendingPrompt } from "@/lib/auth";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    if (takePendingPrompt()) {
      router.replace("/dashboard?build=1");
    } else {
      router.replace("/dashboard");
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 text-sm font-bold text-white">
            A
          </div>
          <span className="font-display text-base font-semibold">Warmluke</span>
        </Link>

        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h1 className="font-display text-xl font-semibold">Welcome back</h1>
          <p className="mt-1 text-sm text-slate-400">
            Sign in to your workspaces.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="text-xs font-medium text-slate-400">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                placeholder="you@company.com"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-400">Password</label>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-800 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-blue-500"
                placeholder="••••••••"
              />
            </div>
            {error && (
              <div className="rounded-lg bg-rose-950/60 px-3 py-2 text-xs text-rose-300">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-gradient-to-r from-blue-500 to-cyan-400 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-slate-500">
            No account?{" "}
            <Link href="/signup" className="text-blue-400 hover:underline">
              Start free
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
