"use client";

// ─────────────────────────────────────────────────────────────
// Dashboard — the user's projects. Creating a project hands the
// pending first prompt (if any) to the builder's empty state.
// ─────────────────────────────────────────────────────────────

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabase-client";
import { useUser, takePendingPrompt } from "@/lib/auth";
import ProjectSettings from "@/components/ProjectSettings";
import ConnectShopify from "@/components/ConnectShopify";
import { PageFrame } from "@/components/PageFrame";
import { button, field, iconButton, note } from "@/components/ui/controls";
import { accessRanOut } from "@/lib/store-standing";
import { quietClasses } from "@/lib/tone";
import { needsOnboarding } from "@/lib/onboarding";
import type { ProjectRow, StoreRow } from "@/lib/types";
import { Plug, Plus, Search, Settings, Store } from "lucide-react";

/** Past this many projects, a search box is quicker than scrolling. */
const SEARCH_FROM = 7;

/** "my-store" → "MS": the tile that stands for a project. */
function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "·";
}

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
  // Said once, in lib/store-standing, which the store switcher reads too.
  const expired = accessRanOut(store);

  const line =
    store.status === "pending"
      ? { tone: "text-tone-attention-fg", dot: "bg-signal-attention", text: "Shopify never came back" }
      : // Shopify said the app was removed from the store (0111). The
        // imported rows are still here until Shopify asks for them to
        // be erased; reconnecting picks them up again.
        store.status === "uninstalled"
        ? { tone: "text-tone-attention-fg", dot: "bg-signal-attention", text: "Removed from Shopify, reconnect to use it again" }
        : expired
        ? { tone: "text-tone-attention-fg", dot: "bg-signal-attention", text: "Shopify access ran out" }
        : {
            tone: "text-fg-muted",
            dot: "bg-signal-success",
            text: store.last_synced_at
              ? `Synced ${new Date(store.last_synced_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`
              : "Not imported yet",
          };

  return (
    <div className="space-y-1">
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <span className={`h-2 w-2 shrink-0 rounded-full ${line.dot}`} />
        <span className="truncate font-medium text-fg">{store.shop_domain}</span>
      </div>
      <div className={`truncate pl-4 text-xs ${line.tone}`}>
        {line.text} · {store.timezone}
      </div>
      {isOwner ? (
        confirming ? (
          // The cost, in the card, in the app's own type — rather than
          // a browser box that cannot be styled or placed and reads as
          // though a different program is asking.
          <div className={`${note.critical} mt-2`}>
            <p className="font-medium">
              Disconnect {store.shop_domain}? Everything imported from it — products,
              stock, orders and customers — is deleted.
            </p>
            <p className="mt-1 opacity-80">
              Your Shopify store itself is untouched, and you can connect it again later.
            </p>
            <div className="mt-2.5 flex items-center gap-1.5">
              <button onClick={onDisconnect} disabled={busy} className={button("critical", "sm")}>
                {busy ? "Disconnecting…" : "Yes, disconnect"}
              </button>
              <button onClick={onCancelDisconnect} className={button("plain", "sm")}>
                Keep it
              </button>
            </div>
          </div>
        ) : (
        <div className="-ml-2.5 flex items-center gap-0.5 pt-1">
          <button onClick={onReconnect} disabled={busy} className={button("plain", "sm")}>
            Reconnect
          </button>
          <button
            onClick={onAskDisconnect}
            disabled={busy}
            className={button("critical-plain", "sm")}
          >
            Disconnect
          </button>
        </div>
        )
      ) : (
        // A member can see the store but not change it; a button that
        // silently did nothing would be worse than no button.
        <div className="pt-1 pl-4 text-xs text-fg-faint">Managed by the owner</div>
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
  const [query, setQuery] = useState("");
  // Whether this person still has onboarding ahead of them. Decided
  // before anything else happens here, so a landing-page prompt is not
  // spent on a project before they have said who they are.
  const [gate, setGate] = useState<"checking" | "open">("checking");
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
    if (!user || projectsLoading || gate !== "checking") return;
    let live = true;
    supabase
      .from("profiles")
      .select("onboarded_at")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!live) return;
        // A read that failed never locks anybody out of their projects.
        if (error) {
          setGate("open");
          return;
        }
        const own = projects.filter((p) => p.owner_id === user.id).length;
        if (needsOnboarding({ onboarded: !!data?.onboarded_at, ownProjects: own, sharedWithMe: projects.length - own })) {
          router.replace("/onboarding");
        } else {
          setGate("open");
        }
      });
    return () => {
      live = false;
    };
  }, [user, projectsLoading, gate, projects, router]);

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
    if (loading || !user || handoffStarted || gate !== "open") return;
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
  }, [loading, user, searchParams, handoffStarted, gate]);

  if (loading || !user || gate !== "open") return <DashboardLoading />;

  const q = query.trim().toLowerCase();
  const shown = q
    ? projects.filter((p) => p.name.toLowerCase().includes(q) || (storeOf(p.id)?.shop_domain ?? "").includes(q))
    : projects;

  return (
    <PageFrame email={user.email} isSuperadmin={isSuperadmin}>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-fg">Your projects</h1>
            <p className="mt-1 text-[13px] text-fg-muted">
              Each project is its own app — isolated data, its own chat history.
            </p>
          </div>
          <button onClick={() => createAndBuild()} disabled={creating} className={button("primary")}>
            <Plus aria-hidden size={15} strokeWidth={2} />
            {creating ? "Creating…" : "New project"}
          </button>
        </div>

        {(connectFailure || storeError) && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {connectFailure ?? storeError}
          </div>
        )}

        {projects.length >= SEARCH_FROM && (
          <label className="relative mt-5 block max-w-xs">
            <Search aria-hidden size={15} strokeWidth={1.75} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Find a project or store"
              aria-label="Find a project or store"
              className={`${field} pl-8`}
            />
          </label>
        )}

        {projectsLoading ? (
          <CardSkeletons />
        ) : projects.length === 0 ? (
          <div className="mt-6 flex flex-col items-center rounded-card border border-dashed border-line-strong bg-surface px-6 py-14 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-canvas text-fg-muted">
              <Store aria-hidden size={22} strokeWidth={1.75} />
            </span>
            {/* An administrator with no projects is not a merchant who
                has not started — they are looking at the wrong screen.
                Building one stays available; it is just not the pitch. */}
            {isSuperadmin ? (
              <>
                <h2 className="mt-4 text-base font-semibold text-fg">No projects of your own</h2>
                <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-fg-muted">
                  This is your own workspace. Everyone else&rsquo;s is under Accounts.
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                  <Link href="/admin" className={button("primary")}>
                    Accounts
                  </Link>
                  <button onClick={() => createAndBuild()} disabled={creating} className={button("secondary")}>
                    {creating ? "Creating…" : "Build one anyway"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="mt-4 text-base font-semibold text-fg">Nothing here yet</h2>
                <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-fg-muted">
                  Create your first project and describe the problem you&rsquo;re stuck on.
                  It asks how you work, then builds the app around it.
                </p>
                <button onClick={() => createAndBuild()} disabled={creating} className={`${button("primary")} mt-5`}>
                  <Plus aria-hidden size={15} strokeWidth={2} />
                  {creating ? "Creating…" : "New project"}
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {shown.map((p) => (
              <div
                key={p.id}
                className="group relative flex flex-col rounded-card bg-surface shadow-card transition-shadow duration-200 hover:shadow-raised"
              >
                <Link
                  href={`/app/${p.id}`}
                  className="flex flex-1 items-start gap-3 rounded-t-card p-4 pr-12 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                >
                  <span
                    aria-hidden
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-[13px] font-semibold ${quietClasses(p.name)}`}
                  >
                    {initials(p.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-fg">{p.name}</span>
                    <span className="mt-0.5 block text-xs text-fg-muted">
                      Created{" "}
                      {new Date(p.created_at).toLocaleDateString(p.locale || "en-IN", {
                        month: "short",
                        day: "numeric",
                      })}
                      {p.currency ? ` · ${p.currency}` : ""}
                    </span>
                    {waiting[p.id] > 0 && (
                      <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-tone-attention px-2 py-0.5 text-[11px] font-medium text-tone-attention-fg">
                        <span className="h-1.5 w-1.5 rounded-full bg-signal-attention" />
                        {waiting[p.id]} waiting for you
                      </span>
                    )}
                  </span>
                </Link>
                {/* Only the owner can change or delete it; the database
                    refuses anyone else, so neither is offered to them. */}
                {p.owner_id === user.id && (
                  <button
                    onClick={() => setSettingsFor(p)}
                    aria-label={`Settings for ${p.name}`}
                    title="Rename, currency, people, delete"
                    className={`${iconButton} absolute top-3 right-3`}
                  >
                    <Settings aria-hidden size={16} strokeWidth={1.75} />
                  </button>
                )}
                <div className="border-t border-line px-4 py-3">
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
                    <button onClick={() => setConnecting(p.id)} className={button("secondary", "sm")}>
                      <Plug aria-hidden size={13} strokeWidth={2} />
                      Connect Shopify
                    </button>
                  )}
                </div>
              </div>
            ))}
            {shown.length === 0 && (
              <p className="text-[13px] text-fg-muted">No project or store matches &ldquo;{query}&rdquo;.</p>
            )}
          </div>
        )}
      </div>

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
    </PageFrame>
  );
}

/** Three cards where the projects will be, rather than a line of text. */
function CardSkeletons() {
  return (
    <div aria-busy className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="animate-pulse rounded-card bg-surface p-4 shadow-card">
          <div className="flex gap-3">
            <div className="h-10 w-10 rounded-control bg-surface-hover" />
            <div className="flex-1 space-y-2 pt-1">
              <div className="h-3.5 w-2/3 rounded bg-surface-hover" />
              <div className="h-3 w-1/3 rounded bg-surface-hover" />
            </div>
          </div>
          <div className="mt-6 h-3 w-1/2 rounded bg-surface-hover" />
        </div>
      ))}
    </div>
  );
}

function DashboardLoading() {
  return (
    <PageFrame email={null}>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
        <div className="h-6 w-40 animate-pulse rounded bg-surface-hover" />
        <CardSkeletons />
      </div>
    </PageFrame>
  );
}

export default function Dashboard() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <DashboardInner />
    </Suspense>
  );
}
