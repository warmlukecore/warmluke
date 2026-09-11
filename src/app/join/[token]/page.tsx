"use client";

// ─────────────────────────────────────────────────────────────
// Join — claims a seat in someone else's project.
//
// The token in the URL is the only proof of invitation, so the claim
// runs in the database (abo_join), never here: this page cannot decide
// who gets in, it can only ask. Signed out, it sends you to log in and
// comes back, because the seat is stamped with a user id.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";

export default function JoinPage() {
  const router = useRouter();
  const { token } = useParams<{ token: string }>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        router.replace(`/login?next=${encodeURIComponent(`/join/${token}`)}`);
        return;
      }
      const { data: projectId, error } = await supabase.rpc("abo_join", { p_token: token });
      if (error) {
        setError("Something went wrong opening this invite. Try the link again.");
        return;
      }
      if (!projectId) {
        setError("This invite is no longer valid — ask for a fresh link.");
        return;
      }
      router.replace(`/app/${projectId}`);
    })();
  }, [token, router]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center">
        {error ? (
          <>
            <div className="text-sm text-slate-200">{error}</div>
            <button
              onClick={() => router.replace("/dashboard")}
              className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              Go to my apps
            </button>
          </>
        ) : (
          <div className="text-sm text-slate-400">Opening the app…</div>
        )}
      </div>
    </main>
  );
}
