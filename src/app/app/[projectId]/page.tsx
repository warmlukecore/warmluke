"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useUser } from "@/lib/auth";
import AppShell from "@/components/AppShell";

export default function BuilderPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params?.projectId;
  const { user, loading } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user || !projectId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
        Loading workspace…
      </div>
    );
  }

  // Keyed by project, so moving between stores mounts a fresh shell:
  // nothing one store left open — a section, a draft, a chat — can
  // carry over into another store's app.
  return <AppShell key={projectId} projectId={projectId} ownerEmail={user.email ?? ""} />;
}
