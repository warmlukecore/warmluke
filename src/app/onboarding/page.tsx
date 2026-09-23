"use client";

// ─────────────────────────────────────────────────────────────
// /onboarding: the first minutes after signing up.
//
// About you, then the store, then their own AI, then the import, then
// in. Which of those they are on is worked out each time from what is
// true (lib/onboarding.ts), so leaving halfway and coming back lands on
// the first thing still missing, and nothing here trusts a step number
// a page remembered.
//
// The store and the AI can wait: a merchant without their Shopify login
// to hand, or without Claude, is not stopped at the door. Only the
// answers about them are asked for before they go in.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Copy, LoaderCircle, LogOut, Plug, Sparkles, Store } from "lucide-react";
import { apiFetch, signOut, takePendingPrompt, useUser } from "@/lib/auth";
import { supabase } from "@/lib/supabase-client";
import ConnectShopify from "@/components/ConnectShopify";
import { button, field, fieldOf, label, note } from "@/components/ui/controls";
import {
  BUSINESS_MAX,
  HEARD_OPTIONS,
  NAME_MAX,
  ORDER_OPTIONS,
  RETURN_KEY,
  PLATFORM_OPTIONS,
  ROLE_OPTIONS,
  TEAM_OPTIONS,
  TEXT_MAX,
  currentStep,
  heardDetailPrompt,
  problems,
  toRow,
  type Answers,
  type Option,
  type Step,
} from "@/lib/onboarding";

const WATCH_MS = 3000;

type Owned = { id: string; name: string; store: { shop_domain: string; status: string } | null };
type Progress = Record<string, { imported: number; status: string; label?: string }>;

const EMPTY: Answers = {
  full_name: "",
  business_name: "",
  role: "",
  monthly_orders: "",
  platform: "",
  website: "",
  team_size: "",
  heard_from: "",
  heard_from_detail: "",
};

const LATER = "I’ll do this later";

export default function Onboarding() {
  const { user, loading } = useUser();
  const router = useRouter();

  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>(EMPTY);
  const [profileSaved, setProfileSaved] = useState(false);
  const [owned, setOwned] = useState<Owned[]>([]);
  const [assistantOffered, setAssistantOffered] = useState(false);
  const [assistants, setAssistants] = useState<string[]>([]);
  // Unknown until the import route has answered once; unknown counts as
  // still going, so the steps do not flick to "ready" and back.
  const [importing, setImporting] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<Progress>({});
  const [skipped, setSkipped] = useState({ store: false, assistant: false, preparing: false });

  useEffect(() => {
    if (!loading && !user) router.replace("/login?next=/onboarding");
  }, [loading, user, router]);

  const connected = owned.find((p) => p.store?.status === "connected") ?? null;
  // Where the store goes: a project of theirs with none yet, or else one
  // whose store needs connecting again (removed from Shopify, or an
  // attempt that never came back).
  const target = connected ?? owned.find((p) => !p.store) ?? owned.find((p) => p.store) ?? null;

  const load = useCallback(async () => {
    if (!user) return;
    const [profile, projects, settings, clients] = await Promise.all([
      supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle(),
      supabase
        .from("projects")
        .select("id, name, owner_id, created_at, stores(shop_domain, status)")
        .eq("owner_id", user.id)
        .order("created_at", { ascending: true }),
      supabase.rpc("abo_my_settings"),
      supabase.rpc("abo_oauth_clients"),
    ]);
    if (profile.error || projects.error) {
      setLoadError("Your details couldn’t be loaded. Reload the page to try again.");
      setReady(true);
      return;
    }
    const row = profile.data as (Partial<Record<keyof Answers, string | null>> & { onboarded_at?: string | null }) | null;
    // Finished once is finished: this is not a page to be sent back to.
    if (row?.onboarded_at) {
      router.replace("/dashboard");
      return;
    }
    if (row) {
      setProfileSaved(true);
      const saved = { ...EMPTY };
      for (const k of Object.keys(EMPTY) as Array<keyof Answers>) saved[k] = row[k] ?? "";
      setAnswers(saved);
    } else {
      const meta = user.user_metadata as { full_name?: string; name?: string } | undefined;
      setAnswers((a) => ({ ...a, full_name: a.full_name || meta?.full_name || meta?.name || "" }));
    }
    setOwned(
      ((projects.data ?? []) as Array<{ id: string; name: string; stores: Owned["store"][] | null }>).map((p) => ({
        id: p.id,
        name: p.name,
        store: p.stores?.[0] ?? null,
      }))
    );
    setAssistantOffered(!!settings.data?.[0]?.mcp_enabled);
    setAssistants(((clients.data ?? []) as Array<{ name: string }>).map((c) => c.name));
    setReady(true);
  }, [user, router]);

  useEffect(() => {
    load();
  }, [load]);

  const step: Step = currentStep({
    profile: profileSaved,
    storeConnected: !!connected,
    storeSkipped: skipped.store,
    assistantOffered,
    assistantDone: assistants.length > 0 || skipped.assistant,
    importing: importing !== false,
    preparingSkipped: skipped.preparing,
  });

  // The import, watched from here while they set up the rest.
  const connectedId = connected?.id ?? null;
  useEffect(() => {
    if (!connectedId) return;
    let live = true;
    (async () => {
      while (live) {
        const { data } = await apiFetch("/api/shopify/import", { projectId: connectedId, status: true });
        if (!live) return;
        if (data?.progress) setProgress(data.progress as Progress);
        const finished = !!data?.done || !!data?.stopped;
        setImporting(!finished);
        if (finished) return;
        await new Promise((r) => setTimeout(r, WATCH_MS));
      }
    })();
    return () => {
      live = false;
    };
  }, [connectedId]);

  // Their AI, noticed the moment it connects.
  useEffect(() => {
    if (step !== "assistant") return;
    const t = setInterval(async () => {
      const { data } = await supabase.rpc("abo_oauth_clients");
      setAssistants(((data ?? []) as Array<{ name: string }>).map((c) => c.name));
    }, WATCH_MS);
    return () => clearInterval(t);
  }, [step]);

  // Leaving for Shopify from the store step comes back here, not to the app.
  useEffect(() => {
    if (step !== "store") return;
    try {
      localStorage.setItem(RETURN_KEY, String(Date.now()));
    } catch {
      /* nothing to come back to, then: the app is where they land */
    }
  }, [step]);

  if (loading || !user || !ready) {
    return (
      <Frame email={user?.email} step={null} assistantOffered={false}>
        <div className="h-80 animate-pulse rounded-card bg-surface shadow-card" />
      </Frame>
    );
  }

  return (
    <Frame email={user.email} step={step} assistantOffered={assistantOffered}>
      {loadError ? (
        <div className={note.critical}>{loadError}</div>
      ) : step === "about" ? (
        <AboutYou
          userId={user.id}
          initial={answers}
          onSaved={async (a) => {
            // A place for the store to go, named for the business, if
            // they have no project of their own to put it in.
            if (owned.length === 0) {
              const { data } = await supabase
                .from("projects")
                .insert({ name: a.business_name.trim().slice(0, 42) })
                .select("id, name")
                .single();
              if (data) setOwned([{ id: data.id, name: data.name, store: null }]);
            }
            setAnswers(a);
            setProfileSaved(true);
          }}
        />
      ) : step === "store" ? (
        <Card
          icon={<Store aria-hidden size={20} strokeWidth={1.75} />}
          title="Connect your Shopify store"
          lede="Warmluke reads your products, orders and customers, and changes nothing in your shop unless you say yes to that change."
        >
          {target ? (
            <ConnectShopify
              projectId={target.id}
              initialShop={target.store?.shop_domain ?? ""}
              submitLabel={target.store ? "Reconnect" : "Connect"}
              cancelLabel={LATER}
              onCancel={() => setSkipped((s) => ({ ...s, store: true }))}
              onConnected={load}
            />
          ) : (
            <div className="space-y-3">
              <div className={note.critical}>There is no project to connect it to yet.</div>
              <button onClick={() => setSkipped((s) => ({ ...s, store: true }))} className={button("secondary")}>
                {LATER}
              </button>
            </div>
          )}
        </Card>
      ) : step === "assistant" ? (
        <Assistant connected={assistants} onDone={() => setSkipped((s) => ({ ...s, assistant: true }))} />
      ) : step === "preparing" ? (
        <Card
          icon={<LoaderCircle aria-hidden size={20} strokeWidth={1.75} className="animate-spin" />}
          title="Bringing in your store"
          lede={`${connected?.store?.shop_domain ?? "Your store"} is importing. It carries on if you close this page.`}
        >
          <ImportList progress={progress} />
          <button
            onClick={() => setSkipped((s) => ({ ...s, preparing: true }))}
            className={`${button("secondary", "lg")} mt-6 w-full`}
          >
            Continue, it will finish on its own
          </button>
        </Card>
      ) : (
        <Done
          name={answers.full_name}
          storeConnected={!!connected}
          onOpen={async () => {
            const { error } = await supabase
              .from("profiles")
              .update({ onboarded_at: new Date().toISOString() })
              .eq("user_id", user.id);
            if (error) return "That didn’t save. Try again.";
            try {
              localStorage.removeItem(RETURN_KEY);
            } catch {
              /* already gone */
            }
            // What they typed on the landing page, carried into their app.
            const pending = takePendingPrompt();
            const where = connected ?? target;
            if (!where) {
              router.replace(pending ? "/dashboard?build=1" : "/dashboard");
              return null;
            }
            if (pending) sessionStorage.setItem("abo_build_prompt", pending);
            router.replace(`/app/${where.id}${pending ? "?build=1" : ""}`);
            return null;
          }}
        />
      )}
    </Frame>
  );
}

// ── The frame: the mark, where they are, and the way out ────────

const TRAIL: Array<{ step: Step[]; text: string; assistant?: true }> = [
  { step: ["about"], text: "About you" },
  { step: ["store", "preparing"], text: "Your store" },
  { step: ["assistant"], text: "Your AI", assistant: true },
  { step: ["done"], text: "Ready" },
];

function Frame({
  email,
  step,
  assistantOffered,
  children,
}: {
  email: string | null | undefined;
  step: Step | null;
  assistantOffered: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const trail = TRAIL.filter((t) => !t.assistant || assistantOffered);
  const at = step ? trail.findIndex((t) => t.step.includes(step)) : -1;
  return (
    <div className="font-ui min-h-dvh bg-canvas text-fg">
      <header className="mx-auto flex w-full max-w-2xl items-center gap-3 px-4 py-5 sm:px-6">
        <Image src="/images/logowarmluke.png" alt="" width={28} height={28} priority className="h-7 w-7 rounded-lg object-cover" />
        <span className="text-sm font-semibold">Warmluke</span>
        <div className="ml-auto flex items-center gap-2 text-xs text-fg-muted">
          <span className="hidden max-w-[14rem] truncate sm:inline">{email}</span>
          <button onClick={() => signOut(router)} className={button("plain", "sm")} aria-label="Sign out">
            <LogOut aria-hidden size={14} strokeWidth={1.75} />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 pb-16 sm:px-6">
        {at >= 0 && (
          <ol aria-label="Steps" className="mb-6 flex items-center gap-2">
            {trail.map((t, i) => (
              <li key={t.text} className="flex flex-1 flex-col gap-1.5" aria-current={i === at ? "step" : undefined}>
                <span className={`h-1 rounded-full transition-colors duration-300 ${i <= at ? "bg-primary" : "bg-line"}`} />
                <span className={`text-[11px] font-medium ${i === at ? "text-fg" : "text-fg-faint"}`}>{t.text}</span>
              </li>
            ))}
          </ol>
        )}
        <div
          key={step ?? "loading"}
          className="rise"
          style={{ ["--rise-from" as string]: "8px", ["--rise-for" as string]: "0.35s" }}
        >
          {children}
        </div>
      </main>
    </div>
  );
}

function Card({
  icon,
  title,
  lede,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-card bg-surface p-6 shadow-card sm:p-8">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-canvas text-fg">{icon}</span>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-fg-muted">{lede}</p>
      <div className="mt-6">{children}</div>
    </section>
  );
}

// ── About you ───────────────────────────────────────────────────

function AboutYou({
  userId,
  initial,
  onSaved,
}: {
  userId: string;
  initial: Answers;
  onSaved: (a: Answers) => Promise<void>;
}) {
  const [a, setA] = useState<Answers>(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrong = useMemo(() => problems(a), [a]);
  const set = (k: keyof Answers) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setA((prev) => ({ ...prev, [k]: e.target.value }));
  const shown = (k: keyof Answers) => (tried ? wrong[k] : undefined);
  const detail = heardDetailPrompt(a.heard_from);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    if (Object.keys(wrong).length > 0 || busy) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase
      .from("profiles")
      .upsert({ user_id: userId, ...toRow(a) }, { onConflict: "user_id" });
    if (err) {
      setBusy(false);
      setError("Your answers didn’t save. Check your connection and try again.");
      return;
    }
    await onSaved(a);
    setBusy(false);
  }

  return (
    <Card
      icon={<Sparkles aria-hidden size={20} strokeWidth={1.75} />}
      title="Tell us about you"
      lede="So Warmluke fits the way your business already works. It takes a minute."
    >
      <form onSubmit={save} noValidate className="space-y-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <Text id="full_name" text="Your name" value={a.full_name} onChange={set("full_name")} error={shown("full_name")} max={NAME_MAX} autoComplete="name" autoFocus />
          <Text id="business_name" text="Business name" value={a.business_name} onChange={set("business_name")} error={shown("business_name")} max={BUSINESS_MAX} autoComplete="organization" />
          <Pick id="role" text="Your role" value={a.role} onChange={set("role")} options={ROLE_OPTIONS} error={shown("role")} />
          <Pick id="monthly_orders" text="Orders a month" value={a.monthly_orders} onChange={set("monthly_orders")} options={ORDER_OPTIONS} error={shown("monthly_orders")} />
          <Pick id="platform" text="Where your store runs" value={a.platform} onChange={set("platform")} options={PLATFORM_OPTIONS} error={shown("platform")} />
          <Pick id="team_size" text="Team size" value={a.team_size} onChange={set("team_size")} options={TEAM_OPTIONS} error={shown("team_size")} optional />
        </div>
        <Text id="website" text="Website" value={a.website} onChange={set("website")} error={shown("website")} max={TEXT_MAX} optional placeholder="yourstore.com" autoComplete="url" />
        <div className="grid gap-5 sm:grid-cols-2">
          <Pick id="heard_from" text="How did you hear about us?" value={a.heard_from} onChange={set("heard_from")} options={HEARD_OPTIONS} error={shown("heard_from")} optional />
          {detail && (
            <Text id="heard_from_detail" text={detail} value={a.heard_from_detail} onChange={set("heard_from_detail")} error={shown("heard_from_detail")} max={TEXT_MAX} />
          )}
        </div>
        {error && <div className={note.critical}>{error}</div>}
        <button type="submit" disabled={busy} className={`${button("primary", "lg")} w-full`}>
          {busy ? "Saving…" : "Continue"}
          {!busy && <ArrowRight aria-hidden size={16} strokeWidth={2} />}
        </button>
      </form>
    </Card>
  );
}

function Text({
  id,
  text,
  value,
  onChange,
  error,
  max,
  optional,
  placeholder,
  autoComplete,
  autoFocus,
}: {
  id: string;
  text: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  error?: string;
  max: number;
  optional?: boolean;
  placeholder?: string;
  autoComplete?: string;
  autoFocus?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className={label}>
        {text}
        {optional && <span className="ml-1 font-normal text-fg-faint">(optional)</span>}
      </label>
      <input
        id={id}
        value={value}
        onChange={onChange}
        maxLength={max}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={field}
      />
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-tone-critical-fg">
          {error}
        </p>
      )}
    </div>
  );
}

function Pick({
  id,
  text,
  value,
  onChange,
  options,
  error,
  optional,
}: {
  id: string;
  text: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  options: Option[];
  error?: string;
  optional?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className={label}>
        {text}
        {optional && <span className="ml-1 font-normal text-fg-faint">(optional)</span>}
      </label>
      <select
        id={id}
        value={value}
        onChange={onChange}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`${field} [&:has(option[value='']:checked)]:text-fg-faint`}
      >
        <option value="">{optional ? "Rather not say" : "Choose one"}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} className="text-fg">
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-tone-critical-fg">
          {error}
        </p>
      )}
    </div>
  );
}

// ── Their own AI ───────────────────────────────────────────────

function Assistant({ connected, onDone }: { connected: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? "" : `${window.location.origin}/api/mcp`;
  const names = [...new Set(connected)];

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card
      icon={<Plug aria-hidden size={20} strokeWidth={1.75} />}
      title="Bring your own AI"
      lede="Use Claude or ChatGPT with your store. It can read it, and anything it wants to build or change comes back to Warmluke for your yes."
    >
      <div className={label}>Connector address</div>
      <div className="flex gap-2">
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Connector address"
          className={`${fieldOf("sm")} w-full min-w-0 font-mono`}
        />
        <button onClick={copy} className={button("secondary")}>
          {copied ? (
            <Check aria-hidden size={15} strokeWidth={2} className="text-signal-success" />
          ) : (
            <Copy aria-hidden size={15} strokeWidth={1.75} />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <ol className="mt-5 space-y-2.5 text-[13px] text-fg-muted">
        {[
          "In Claude, open Settings, then Connectors, and add a custom connector. In ChatGPT it is under Settings, Connectors.",
          "Paste the address, connect, and sign in with this Warmluke account when it asks.",
          "Ask it about your store. What it proposes waits in Warmluke for you.",
        ].map((t, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-canvas text-[11px] font-semibold text-fg">
              {i + 1}
            </span>
            <span>{t}</span>
          </li>
        ))}
      </ol>

      <div
        role="status"
        className={`mt-6 flex items-center gap-2 rounded-control px-3 py-2.5 text-[13px] ${
          names.length ? "bg-tone-success/30 text-tone-success-fg" : "bg-surface-subdued text-fg-muted"
        }`}
      >
        {names.length ? (
          <>
            <Check aria-hidden size={15} strokeWidth={2} />
            {names.join(", ")} connected
          </>
        ) : (
          <>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-neutral" />
            Waiting for it to connect. This notices by itself.
          </>
        )}
      </div>

      <button onClick={onDone} className={`${button(names.length ? "primary" : "secondary", "lg")} mt-4 w-full`}>
        {names.length ? "Continue" : LATER}
      </button>
    </Card>
  );
}

// ── The import ──────────────────────────────────────────────────

function ImportList({ progress }: { progress: Progress }) {
  const rows = Object.entries(progress).filter(([, p]) => p.label);
  if (rows.length === 0) {
    return <div className="h-24 animate-pulse rounded-card bg-surface-subdued" />;
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-card border border-line">
      {rows.map(([key, p]) => {
        const done = p.status === "done";
        return (
          <li key={key} className="flex items-center gap-3 px-3 py-2 text-[13px]">
            {done ? (
              <Check aria-hidden size={15} strokeWidth={2} className="text-signal-success" />
            ) : (
              <LoaderCircle aria-hidden size={15} strokeWidth={1.75} className="animate-spin text-fg-faint" />
            )}
            <span className="flex-1 text-fg">{p.label}</span>
            <span className="text-xs text-fg-muted tabular-nums">{p.imported.toLocaleString()}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ── In ──────────────────────────────────────────────────────────

function Done({
  name,
  storeConnected,
  onOpen,
}: {
  name: string;
  storeConnected: boolean;
  onOpen: () => Promise<string | null | undefined>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = name.trim().split(/\s+/)[0];
  return (
    <Card
      icon={<Check aria-hidden size={20} strokeWidth={2} className="text-signal-success" />}
      title={first ? `You’re all set, ${first}` : "You’re all set"}
      lede={
        storeConnected
          ? "Your store is in. Ask Luke anything about it, or describe the tool you wish you had and it builds it around how you work."
          : "Describe the problem you’re stuck on, not the software, and Luke builds the app around how you work. You can connect your store whenever you like."
      }
    >
      {error && <div className={`${note.critical} mb-4`}>{error}</div>}
      <button
        onClick={async () => {
          setBusy(true);
          setError(null);
          const why = await onOpen();
          if (why) {
            setError(why);
            setBusy(false);
          }
        }}
        disabled={busy}
        className={`${button("primary", "lg")} w-full`}
      >
        {busy ? "Opening…" : "Open Warmluke"}
        {!busy && <ArrowRight aria-hidden size={16} strokeWidth={2} />}
      </button>
    </Card>
  );
}
