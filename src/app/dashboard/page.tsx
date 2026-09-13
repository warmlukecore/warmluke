"use client";

// ─────────────────────────────────────────────────────────────
// Dashboard — the user's projects. Creating a project hands the
// pending first prompt (if any) to the builder's empty state.
// ─────────────────────────────────────────────────────────────

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase-client";
import { useUser, signOut, takePendingPrompt } from "@/lib/auth";
import ProjectSettings from "@/components/ProjectSettings";
import ConnectShopify from "@/components/ConnectShopify";
import type { ProjectRow, StoreRow } from "@/lib/types";

/**
 * What the store is actually doing, not what we hope it is.
 *
 * Connected and synced are different things, and saying "synced" before
 * an import has run would be the app telling the owner their data is
 * there when it is not. A pending row that has sat too long is a failed
 * connection, and says so rather than spinning forever.
 */
function ShopifyStatus({ store }: { store: StoreRow }) {
  if (store.status === "pending") {
    return (
      <div className="text-xs text-amber-400">
        Waiting for Shopify — <span className="text-slate-500">reopen to try again</span>
      </div>
    );
  }
  const synced = store.last_synced_at
    ? `Synced ${new Date(store.last_synced_at).toLocaleDateString()}`
    : "Not imported yet";
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5 text-xs text-slate-300">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        <span className="truncate">{store.shop_domain}</span>
      </div>
      <div className="text-[11px] text-slate-500">
        {synced} · {store.timezone}
      </div>
    </div>
  );
}

/** The callback's reason codes, in the owner's terms. */
const CONNECT_FAILURE: Record<string, string> = {
  not_configured: "Shopify isn't set up on this deployment yet.",
  invalid_callback: "That link didn't come from Shopify — start the connection again.",
  invalid_shop_domain: "That store address wasn't valid.",
  incomplete: "Shopify sent us back without finishing. Try again.",
  expired: "The connection took too long. Start again.",
  token_exchange_failed: "Shopify refused to complete the connection.",
  shop_context_failed: "Connected, but the store details couldn't be read.",
  save_failed: "Connected, but saving it failed. Try again.",
};

function DashboardInner() {
  const { user, loading } = useUser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [handoffStarted, setHandoffStarted] = useState(false);
  const [settingsFor, setSettingsFor] = useState<ProjectRow | null>(null);
  // One query for every store the caller can see, keyed by project.
  // Asking per card would be twenty requests to draw one screen.
  const [stores, setStores] = useState<Record<string, StoreRow>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const storeOf = (projectId: string) => stores[projectId];
  const connectFailure =
    searchParams.get("shopify") === "failed"
      ? (CONNECT_FAILURE[searchParams.get("reason") ?? ""] ??
        "The store couldn't be connected. Try again.")
      : null;

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const loadProjects = useCallback(async () => {
    const { data, error } = await supabase
      .from("projects")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      console.error(error.message);
    } else {
      setProjects((data ?? []) as ProjectRow[]);
    }
    setProjectsLoading(false);

    const { data: storeRows } = await supabase.from("stores").select("*");
    setStores(
      Object.fromEntries(((storeRows ?? []) as StoreRow[]).map((st) => [st.project_id, st]))
    );
  }, []);

  useEffect(() => {
    if (user) loadProjects();
  }, [user, loadProjects]);

  async function createProject(name?: string): Promise<string | null> {
    setCreating(true);
    const { data, error } = await supabase
      .from("projects")
      .insert({ name: name?.trim() || "Untitled project" })
      .select()
      .single();
    setCreating(false);
    if (error || !data) {
      console.error(error?.message);
      return null;
    }
    setProjects((prev) => [data as ProjectRow, ...prev]);
    return data.id;
  }

  // Landing prompt box → "Start building": create project + go build.
  async function createAndBuild() {
    const pending = takePendingPrompt();
    const id = await createProject(pending ? pending.slice(0, 42) : undefined);
    if (id) router.push(`/app/${id}?build=1`);
  }

  // Arrived from signup/login with a pending prompt.
  useEffect(() => {
    if (loading || !user || handoffStarted) return;
    if (searchParams.get("build") === "1") {
      setHandoffStarted(true);
      const pending = takePendingPrompt();
      if (pending) {
        (async () => {
          const id = await createProject(pending.slice(0, 42));
          if (id) {
            sessionStorage.setItem("abo_build_prompt", pending);
            router.replace(`/app/${id}?build=1`);
          }
        })();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user, searchParams, handoffStarted]);

  async function handleSignOut() {
    await signOut(router);
  }

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6 sm:py-5">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-cyan-400 text-sm font-bold text-white">
            A
          </div>
          <span className="font-display text-base font-semibold">Warmluke</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-slate-400">{user.email}</span>
          <button
            onClick={handleSignOut}
            className="rounded-lg border border-slate-800 px-3 py-1.5 text-slate-300 transition-colors hover:bg-slate-900"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight">Your projects</h1>
            <p className="mt-1 text-sm text-slate-400">
              Each project is its own app — isolated data, its own chat history.
            </p>
          </div>
          <button
            onClick={() => createAndBuild()}
            disabled={creating}
            className="rounded-xl bg-gradient-to-r from-blue-500 to-cyan-400 px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            + New project
          </button>
        </div>

        {connectFailure && (
          <div className="mt-6 rounded-xl border border-rose-900/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            {connectFailure}
          </div>
        )}

        {projectsLoading ? (
          <div className="mt-10 text-sm text-slate-500">Loading projects…</div>
        ) : projects.length === 0 ? (
          <div className="mt-10 rounded-2xl border border-dashed border-slate-800 p-8 text-center sm:p-14">
            <div className="font-display text-lg font-semibold">Nothing here yet</div>
            <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
              Create your first project and describe the problem you&rsquo;re stuck
              on. It asks how you work, then builds the app around it.
            </p>
            <button
              onClick={() => createAndBuild()}
              disabled={creating}
              className="mt-6 rounded-xl bg-gradient-to-r from-blue-500 to-cyan-400 px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {creating ? "Creating…" : "+ New project"}
            </button>
          </div>
        ) : (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <div
                key={p.id}
                className="group relative rounded-2xl border border-slate-800 bg-slate-900/50 transition-colors hover:border-slate-600"
              >
                <Link href={`/app/${p.id}`} className="block p-5">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500/20 to-cyan-400/20 text-lg">
                    🚀
                  </div>
                  <div className="font-display mt-3 pr-8 font-semibold group-hover:text-white">
                    {p.name}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    Created{" "}
                    {new Date(p.created_at).toLocaleDateString(p.locale || "en-IN", {
                      month: "short",
                      day: "numeric",
                    })}
                    {p.currency ? ` · ${p.currency}` : ""}
                  </div>
                  <div className="mt-3 text-xs font-medium text-blue-400 opacity-0 transition-opacity group-hover:opacity-100">
                    Open builder →
                  </div>
                </Link>
                <div className="border-t border-slate-800 px-5 py-3">
                  {storeOf(p.id) ? (
                    <ShopifyStatus store={storeOf(p.id)!} />
                  ) : connecting === p.id ? (
                    <ConnectShopify projectId={p.id} onCancel={() => setConnecting(null)} />
                  ) : (
                    <button
                      onClick={() => setConnecting(p.id)}
                      className="text-xs font-medium text-slate-400 transition-colors hover:text-blue-400"
                    >
                      ⚡ Connect Shopify
                    </button>
                  )}
                </div>
                <button
                  onClick={() => setSettingsFor(p)}
                  aria-label={`Settings for ${p.name}`}
                  title="Rename, currency, delete"
                  className="absolute top-4 right-4 rounded-lg px-2 py-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
                >
                  ⚙
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      {settingsFor && (
        <ProjectSettings
          project={settingsFor}
          onSaved={(updated) =>
            setProjects((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
          }
          onDeleted={(id) => setProjects((prev) => prev.filter((x) => x.id !== id))}
          onClose={() => setSettingsFor(null)}
        />
      )}
    </div>
  );
}

export default function Dashboard() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
          Loading…
        </div>
      }
    >
      <DashboardInner />
    </Suspense>
  );
}
