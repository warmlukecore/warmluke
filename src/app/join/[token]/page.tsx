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
import { CenteredCard } from "@/components/CenteredCard";
import { button } from "@/components/ui/controls";

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
        setError("This invite is no longer valid. Ask for a fresh link.");
        return;
      }
      router.replace(`/app/${projectId}`);
    })();
  }, [token, router]);

  return (
    <CenteredCard>
      {error ? (
        <div className="text-center">
          <div className="text-fg">{error}</div>
          <button onClick={() => router.replace("/dashboard")} className={`${button("primary")} mt-4`}>
            Go to my apps
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-neutral" />
          Opening the app…
        </div>
      )}
    </CenteredCard>
  );
}
