"use client";

// ─────────────────────────────────────────────────────────────
// /connect — finishing a connection that started somewhere else.
//
// Two ways here. Shopify sends a merchant after they install the app
// or open it from their admin (?shop=, from /api/shopify/entry), and a
// merchant opens the link they copied in another browser (?project=).
// Either way they sign in first: which store and which project are
// suggestions until the database has checked the project is theirs,
// and a link someone else sent can only connect their own store to
// their own account.
// ─────────────────────────────────────────────────────────────

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch, signOut, useUser } from "@/lib/auth";
import { supabase } from "@/lib/supabase-client";
import { readShopAddress } from "@/lib/shop-address";
import ConnectShopify from "@/components/ConnectShopify";

type Project = { id: string; name: string };
type Store = { project_id: string; shop_domain: string; status: string };

function ConnectInner() {
  const { user, loading } = useUser();
  const router = useRouter();
  const params = useSearchParams();
  // What Shopify said, read the strict way it will be checked again.
  const shopParam = params.get("shop");
  const shop = useMemo(() => {
    if (!shopParam) return null;
    const r = readShopAddress(shopParam);
    return "domain" in r ? r.domain : null;
  }, [shopParam]);
  const hint = params.get("project");

  const [projects, setProjects] = useState<Project[] | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  // Signed in first, then back here with everything they came with.
  useEffect(() => {
    if (!loading && !user) {
      router.replace(`/login?next=${encodeURIComponent(`/connect${window.location.search}`)}`);
    }
  }, [loading, user, router]);

  useEffect(() => {
    if (!user) return;
    (async () => {
      // Their own projects only: a store is connected by a project's
      // owner, and a member's seat is not enough to give one away.
      const { data: mine } = await supabase
        .from("projects")
        .select("id, name")
        .eq("owner_id", user.id)
        .order("created_at", { ascending: false });
      const ids = (mine ?? []).map((p) => p.id);
      const { data: held } = ids.length
        ? await supabase.from("stores").select("project_id, shop_domain, status").in("project_id", ids)
        : { data: [] };
      setProjects((mine ?? []) as Project[]);
      setStores((held ?? []) as Store[]);
    })();
  }, [user]);

  /** A project can take this store if it has none, or has this one already. */
  const eligible = useMemo(() => {
    if (!projects) return [];
    return projects.filter((p) => {
      const theirs = stores.filter((s) => s.project_id === p.id && s.status !== "pending");
      return theirs.length === 0 || (shop !== null && theirs.every((s) => s.shop_domain === shop));
    });
  }, [projects, stores, shop]);

  const already = shop ? stores.find((s) => s.shop_domain === shop && s.status === "connected") : undefined;
  const hinted = hint && eligible.some((p) => p.id === hint) ? hint : null;
  // "Connect another store": a project of its own, made now that Shopify
  // has said which store — never before, so turning back at Shopify
  // leaves nothing empty behind.
  const wantsNew = hint === "new";

  async function begin(projectId: string) {
    if (!shop || busy) return;
    setBusy(true);
    setError(null);
    const { ok, data } = await apiFetch("/api/shopify/install", { projectId, shop });
    if (!ok || typeof data.url !== "string") {
      setBusy(false);
      setError((data.error as string | undefined) ?? "Couldn't reach Shopify. Try again in a moment.");
      return;
    }
    window.location.href = data.url;
  }

  async function newProject() {
    setBusy(true);
    const name = shop ? shop.replace(/\.myshopify\.com$/, "") : "My store";
    const { data, error: made } = await supabase.from("projects").insert({ name }).select("id, name").single();
    setBusy(false);
    if (made || !data) {
      setError("Couldn't create a project. Try again.");
      return;
    }
    setProjects((prev) => [data as Project, ...(prev ?? [])]);
    setChosen(data.id);
    if (shop) begin(data.id);
  }

  // Tapped from a project, sent through Shopify, back again: nothing is
  // left to ask. Only when that project is theirs and can take the store,
  // or when they asked for a new one — and never for a store that is
  // already connected, which is shown to them instead.
  useEffect(() => {
    if (started.current || !shop || projects === null || already) return;
    if (hinted) {
      started.current = true;
      begin(hinted);
    } else if (wantsNew) {
      started.current = true;
      newProject();
    }
    // begin and newProject read only state that is settled by now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop, hinted, wantsNew, already, projects]);

  if (loading || !user || projects === null) {
    return <Shell>Loading…</Shell>;
  }
  const signedIn = <SignedInAs email={user.email} onSignOut={() => signOut(router)} />;

  // ── Shopify sent them, with a store. ──────────────────────────
  if (shopParam) {
    if (!shop) {
      return (
        <Shell>
          <p className="text-rose-300">That link did not name a Shopify store.</p>
          <BackLink />
        </Shell>
      );
    }
    if (already) {
      const where = projects.find((p) => p.id === already.project_id);
      return (
        <Shell>
          <p>
            <span className="text-slate-100">{shop}</span> is already connected
            {where ? ` to ${where.name}` : ""}.
          </p>
          <Link href={`/app/${already.project_id}`} className="mt-3 inline-block text-blue-400 hover:text-blue-300">
            Open it →
          </Link>
        </Shell>
      );
    }
    const pick = chosen ?? hinted ?? (eligible.length === 1 ? eligible[0].id : null);
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-slate-100">Connect {shop}</h1>
        {busy ? (
          <p className="mt-2">Opening Shopify…</p>
        ) : (
          <>
            {eligible.length > 0 ? (
              <>
                <p className="mt-1">Which project is it for?</p>
                <div className="mt-3 space-y-1.5">
                  {eligible.map((p) => (
                    <label key={p.id} className="flex cursor-pointer items-center gap-2 text-slate-200">
                      <input type="radio" name="project" checked={pick === p.id} onChange={() => setChosen(p.id)} />
                      {p.name}
                    </label>
                  ))}
                </div>
                <button
                  onClick={() => pick && begin(pick)}
                  disabled={!pick}
                  className="mt-4 w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  Continue to Shopify
                </button>
              </>
            ) : (
              <p className="mt-1">
                {projects.length
                  ? "Each of your projects already has a store. Start a new one for this store:"
                  : "Start a project for this store:"}
              </p>
            )}
            <button onClick={newProject} className="mt-3 text-sm text-slate-400 underline hover:text-slate-200">
              New project for {shop.replace(/\.myshopify\.com$/, "")}
            </button>
          </>
        )}
        {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
        {signedIn}
      </Shell>
    );
  }

  // ── The link from another browser, naming a project. ──────────
  const project = projects.find((p) => p.id === hint);
  if (!project) {
    return (
      <Shell>
        <p>This link is for a project on another Warmluke account. Sign in with the account that copied it.</p>
        {signedIn}
      </Shell>
    );
  }
  const connected = stores.find((s) => s.project_id === project.id && s.status === "connected");
  if (connected) {
    return (
      <Shell>
        <p>
          {project.name} is connected to <span className="text-slate-100">{connected.shop_domain}</span>. You can
          close this tab.
        </p>
        <Link href={`/app/${project.id}`} className="mt-3 inline-block text-blue-400 hover:text-blue-300">
          Open it →
        </Link>
      </Shell>
    );
  }
  return (
    <Shell>
      <h1 className="mb-3 text-lg font-semibold text-slate-100">Connect {project.name} to Shopify</h1>
      <ConnectShopify
        projectId={project.id}
        anotherBrowser={false}
        onCancel={() => router.push("/dashboard")}
        onConnected={() => router.push(`/app/${project.id}`)}
      />
      {signedIn}
    </Shell>
  );
}

function SignedInAs({ email, onSignOut }: { email?: string | null; onSignOut: () => void }) {
  return (
    <p className="mt-6 text-[11px] text-slate-500">
      Signed in as {email}.{" "}
      <button onClick={onSignOut} className="underline hover:text-slate-300">
        Not you?
      </button>
    </p>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-sm text-slate-400">
      <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-5">{children}</div>
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/dashboard" className="mt-3 inline-block text-blue-400 hover:text-blue-300">
      Back to Warmluke →
    </Link>
  );
}

export default function ConnectPage() {
  return (
    <Suspense fallback={<Shell>Loading…</Shell>}>
      <ConnectInner />
    </Suspense>
  );
}
