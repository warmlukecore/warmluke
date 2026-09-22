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
 * there when it is not. Two other states are just as real and used to be
 * invisible: a pending row that never came back from Shopify, and a
 * connected store whose token has expired — both look fine on a card
 * that only knows how to draw a green dot.
 */
function ShopifyStatus({
  store,
  isOwner,
  busy,
  onReconnect,
  onDisconnect,
  onAskDisconnect,
  onCancelDisconnect,
  confirming,
}: {
  store: StoreRow;
  isOwner: boolean;
  busy: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
  onAskDisconnect: () => void;
  onCancelDisconnect: () => void;
  confirming: boolean;
}) {
  // The hour-long access token expiring is not a problem — it is
  // renewed on the next call, and it has lapsed on every store nobody
  // has touched since lunch. Reading it as broken put "Access expired"
  // and a Reconnect button on a store that was working perfectly, which
  // is the kind of false alarm that teaches people to ignore real ones.
  //
  // Reconnecting is only needed when the 90-day refresh token is gone
  // or has run out, because then nothing can renew anything.
  const expired =
    // A store from before Shopify made tokens expire has neither date
    // and works indefinitely; only judge one that has an expiry.
    !!store.token_expires_at &&
    (!store.refresh_token_expires_at ||
      Date.parse(store.refresh_token_expires_at) < Date.now());

  const line =
    store.status === "pending"
      ? { tone: "text-amber-400", dot: "bg-amber-400", text: "Shopify never came back" }
      : expired
        ? { tone: "text-amber-400", dot: "bg-amber-400", text: "Shopify access ran out" }
        : {
            tone: "text-slate-300",
            dot: "bg-emerald-400",
            text: store.last_synced_at
              ? `Synced ${new Date(store.last_synced_at).toLocaleDateString()}`
              : "Not imported yet",
          };

  return (
    <div className="space-y-1">
      <div className={`flex items-center gap-1.5 text-xs ${line.tone}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${line.dot}`} />
        <span className="truncate">{store.shop_domain}</span>
      </div>
      <div className="text-[11px] text-slate-500">
        {line.text} · {store.timezone}
      </div>
      {isOwner ? (
        confirming ? (
          // The cost, in the card, in the app's own type — rather than
          // a browser box that cannot be styled or placed and reads as
          // though a different program is asking.
          <div className="mt-1 rounded-lg border border-rose-900/50 bg-rose-950/30 p-2.5 text-[11px]">
            <p className="leading-relaxed text-rose-100">
              Disconnect {store.shop_domain}? Everything imported from it — products,
              stock, orders and customers — is deleted.
            </p>
            <p className="mt-1 leading-relaxed text-slate-400">
              Your Shopify store itself is untouched, and you can connect it again later.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={onDisconnect}
                disabled={busy}
                className="font-medium text-rose-300 hover:text-rose-200 disabled:opacity-40"
              >
                {busy ? "Disconnecting…" : "Yes, disconnect"}
              </button>
              <button onClick={onCancelDisconnect} className="text-slate-400 hover:text-slate-200">
                Keep it
              </button>
            </div>
          </div>
        ) : (
        <div className="flex items-center gap-2 pt-0.5 text-[11px]">
          <button
            onClick={onReconnect}
            disabled={busy}
            className="font-medium text-blue-400 transition-colors hover:text-blue-300 disabled:opacity-40"
          >
            Reconnect
          </button>
          <span className="text-slate-700">·</span>
          <button
            onClick={onAskDisconnect}
            disabled={busy}
            className="text-slate-500 transition-colors hover:text-rose-400 disabled:opacity-40"
          >
            Disconnect
          </button>
        </div>
        )
      ) : (
        // A member can see the store but not change it; a button that
        // silently did nothing would be worse than no button.
        <div className="pt-0.5 text-[11px] text-slate-600">Managed by the owner</div>
      )}
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
  /** How many designs are waiting on the merchant, per project. */
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [handoffStarted, setHandoffStarted] = useState(false);
  const [settingsFor, setSettingsFor] = useState<ProjectRow | null>(null);
  // One query for every store the caller can see, keyed by project.
  // Asking per card would be twenty requests to draw one screen.
  const [stores, setStores] = useState<Record<string, StoreRow>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  // The project whose store is mid-disconnect, so its two buttons go
  // inert instead of accepting a second click on the same row.
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  // Whether to show the way into the accounts screen. The screen itself
  // refuses non-administrators; this only decides whether the door is
  // visible, so a wrong answer here is cosmetic.
  const [isSuperadmin, setIsSuperadmin] = useState(false);
  const storeOf = (projectId: string) => stores[projectId];

  /** Reconnecting is the connect form again, with the address filled in. */
  function reconnect(projectId: string) {
    setStoreError(null);
    setConnecting(projectId);
  }

  /**
   * Disconnecting deletes the store row, and the cascade from 0018 takes
   * its products, orders, customers and access token with it. That is
   * what /privacy and /terms promise, so it is asked about plainly
   * first rather than softened into "you can undo this".
   */
  async function disconnect(projectId: string) {
    const store = stores[projectId];
    if (!store || disconnecting) return;
    // What this costs is spelled out in the card itself, and this
    // runs only after the merchant has said yes to it there.
    setConfirmDisconnect(null);
    setDisconnecting(projectId);
    setStoreError(null);
    const { error } = await supabase.from("stores").delete().eq("id", store.id);
    setDisconnecting(null);
    if (error) {
      setStoreError("That store couldn't be disconnected. Try again.");
      return;
    }
    setStores((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
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

    // Not select("*"): the token columns are no longer readable, and a
    // dashboard has no business asking for them — it wants a domain and
    // two expiry dates.
    const { data: storeRows } = await supabase
      .from("stores")
      .select(
        "id, project_id, shop_domain, status, currency, timezone, last_synced_at, token_expires_at, refresh_token_expires_at"
      );
    setStores(
      Object.fromEntries(((storeRows ?? []) as StoreRow[]).map((st) => [st.project_id, st]))
    );

    // What their own AI is waiting on them for, per app.
    //
    // This page never asked. A merchant whose assistant proposed
    // something in Claude signs in, lands here, and sees a list of
    // apps that all look the same — the only sign of it is inside
    // one of them, behind a panel. Counted here rather than joined
    // in the card, so an app with nothing waiting renders exactly as
    // it did.
    const { data: waitingRows } = await supabase
      .from("build_requests")
      .select("project_id, status")
      .in("status", ["pending", "partly_built"]);
    const tally: Record<string, number> = {};
    for (const w of (waitingRows ?? []) as Array<{ project_id: string }>) {
      tally[w.project_id] = (tally[w.project_id] ?? 0) + 1;
    }
    setWaiting(tally);
  }, []);

  useEffect(() => {
    if (user) loadProjects();
  }, [user, loadProjects]);

  useEffect(() => {
    if (!user) return;
    supabase.rpc("abo_my_settings").then(({ data }) => {
      setIsSuperadmin(!!data?.[0]?.is_superadmin);
    });
  }, [user]);

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
          {/* An administrator had no way to reach their own screen but
              to know the URL, which is not a product. */}
          {isSuperadmin && (
            <Link
              href="/admin"
              className="rounded-lg border border-slate-800 px-3 py-1.5 text-slate-300 transition-colors hover:bg-slate-900"
            >
              Accounts
            </Link>
          )}
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

        {(connectFailure || storeError) && (
          <div className="mt-6 rounded-xl border border-rose-900/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            {connectFailure ?? storeError}
          </div>
        )}

        {projectsLoading ? (
          <div className="mt-10 text-sm text-slate-500">Loading projects…</div>
        ) : projects.length === 0 ? (
          <div className="mt-10 rounded-2xl border border-dashed border-slate-800 p-8 text-center sm:p-14">
            {/* An administrator with no projects is not a merchant who
                has not started — they are looking at the wrong screen.
                Building one stays available; it is just not the pitch. */}
            {isSuperadmin ? (
              <>
                <div className="font-display text-lg font-semibold">No projects of your own</div>
                <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
                  This is your own workspace. Everyone else&rsquo;s is under Accounts.
                </p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                  <Link
                    href="/admin"
                    className="rounded-xl bg-gradient-to-r from-blue-500 to-cyan-400 px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    Accounts
                  </Link>
                  <button
                    onClick={() => createAndBuild()}
                    disabled={creating}
                    className="rounded-xl border border-slate-800 px-5 py-2.5 text-sm text-slate-300 transition-colors hover:bg-slate-900 disabled:opacity-50"
                  >
                    {creating ? "Creating…" : "Build one anyway"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="font-display text-lg font-semibold">Nothing here yet</div>
                <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
                  Create your first project and describe the problem you&rsquo;re stuck on.
                  It asks how you work, then builds the app around it.
                </p>
                <button
                  onClick={() => createAndBuild()}
                  disabled={creating}
                  className="mt-6 rounded-xl bg-gradient-to-r from-blue-500 to-cyan-400 px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {creating ? "Creating…" : "+ New project"}
                </button>
              </>
            )}
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
                  {waiting[p.id] > 0 && (
                    <div className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                      {waiting[p.id]} waiting for you
                    </div>
                  )}
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
                  {/* The form wins over the status: a reconnect starts
                      from a store that is already there. */}
                  {connecting === p.id ? (
                    <ConnectShopify
                      projectId={p.id}
                      initialShop={storeOf(p.id)?.shop_domain ?? ""}
                      submitLabel={storeOf(p.id) ? "Reconnect" : "Connect"}
                      onCancel={() => setConnecting(null)}
                    />
                  ) : storeOf(p.id) ? (
                    <ShopifyStatus
                      store={storeOf(p.id)!}
                      isOwner={p.owner_id === user.id}
                      busy={disconnecting === p.id}
                      onReconnect={() => reconnect(p.id)}
                      onDisconnect={() => disconnect(p.id)}
                      onAskDisconnect={() => setConfirmDisconnect(p.id)}
                      onCancelDisconnect={() => setConfirmDisconnect(null)}
                      confirming={confirmDisconnect === p.id}
                    />
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
