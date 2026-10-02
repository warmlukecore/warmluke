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
//
// Laid out as a conversation with Luke: Luke on the left, with the steps
// and what was answered in each, and one question at a time on the
// right. Any step already passed can be opened again from the left.
// ─────────────────────────────────────────────────────────────

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, ChevronRight, Copy, LoaderCircle, LogOut, Plug } from "lucide-react";
import { apiFetch, signOut, takePendingPrompt, useUser } from "@/lib/auth";
import { supabase } from "@/lib/supabase-client";
import ConnectShopify from "@/components/ConnectShopify";
import HistoryPicker from "@/components/HistoryPicker";
import { LukeMark } from "@/components/ui/LukeMark";
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
import { Logo } from "@/components/ui/Logo";
import { InviteOnly } from "@/components/InviteOnly";
import { ASSISTANTS } from "@/lib/connect-assistants";

const WATCH_MS = 3000;

type Owned = {
  id: string;
  name: string;
  store: { shop_domain: string; status: string; history_set_at?: string | null } | null;
};
type Progress = Record<string, { imported: number; status: string; label?: string }>;
/** Which way the last move went, so the next screen comes in from that side. */
type Dir = "from-right" | "from-left";

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

/** The steps in the order they come. */
const ORDER: Step[] = ["about", "store", "preparing", "assistant", "done"];

export default function Onboarding() {
  const { user, loading } = useUser();
  const router = useRouter();

  const [ready, setReady] = useState(false);
  const [uninvited, setUninvited] = useState(false);
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
  // Chosen on this visit: the row read at load still says not chosen.
  const [historyChosen, setHistoryChosen] = useState(false);
  // Whether merchants are asked at all (history_settings): off, nobody is.
  const [historyOn, setHistoryOn] = useState(true);
  // A step opened again from the list, over the one they are up to.
  const [viewing, setViewing] = useState<Step | null>(null);
  const [dir, setDir] = useState<Dir>("from-right");
  // What they have typed so far, for Luke to answer to as they type.
  const [draft, setDraft] = useState<Answers>(EMPTY);

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
    const [profile, projects, settings, clients, may, asking] = await Promise.all([
      supabase.from("profiles").select("*").eq("user_id", user.id).maybeSingle(),
      supabase
        .from("projects")
        .select("id, name, owner_id, created_at, stores(shop_domain, status, history_set_at)")
        .eq("owner_id", user.id)
        .order("created_at", { ascending: true }),
      supabase.rpc("abo_my_settings"),
      supabase.rpc("abo_oauth_clients"),
      supabase.rpc("abo_may_start_app"),
      supabase.from("history_settings").select("enabled").maybeSingle(),
    ]);
    setHistoryOn(asking.data?.enabled !== false);
    // Invite only (0141): the database would refuse their app, so the
    // questions about it are not asked. Unknown (before 0141) is allowed.
    if (may.data === false) {
      setUninvited(true);
      setReady(true);
      return;
    }
    if (profile.error || projects.error) {
      setLoadError("Your details couldn’t be loaded. Reload the page to try again.");
      setReady(true);
      return;
    }
    const row = profile.data as
      | (Partial<Record<keyof Answers, string | null>> & { onboarded_at?: string | null })
      | null;
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
      setDraft(saved);
    } else {
      // A name from the sign-up, and a business from an invite (0119),
      // so the first question starts answered.
      const meta = user.user_metadata as { full_name?: string; name?: string; business_name?: string } | undefined;
      const name = meta?.full_name || meta?.name || "";
      const business = meta?.business_name || "";
      const seed = (a: Answers) => ({
        ...a,
        full_name: a.full_name || name,
        business_name: a.business_name || business,
      });
      setAnswers(seed);
      setDraft(seed);
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
    historyAwaiting: historyOn && !!connected && !connected.store?.history_set_at && !historyChosen,
    assistantOffered,
    assistantDone: assistants.length > 0 || skipped.assistant,
    importing: importing !== false,
    preparingSkipped: skipped.preparing,
  });
  const shown: Step = viewing ?? step;

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
    if (shown !== "assistant") return;
    const t = setInterval(async () => {
      const { data } = await supabase.rpc("abo_oauth_clients");
      setAssistants(((data ?? []) as Array<{ name: string }>).map((c) => c.name));
    }, WATCH_MS);
    return () => clearInterval(t);
  }, [shown]);

  // Leaving for Shopify from the store step comes back here, not to the app.
  useEffect(() => {
    if (shown !== "store") return;
    try {
      localStorage.setItem(RETURN_KEY, String(Date.now()));
    } catch {
      /* nothing to come back to, then: the app is where they land */
    }
  }, [shown]);

  /** Opens a step already passed, coming in from the side it lies on. */
  function revisit(to: Step) {
    if (to === shown) return;
    setDir(ORDER.indexOf(to) < ORDER.indexOf(shown) ? "from-left" : "from-right");
    // A step opened again that its skip had closed is open again.
    if (to === "store") setSkipped((s) => ({ ...s, store: false }));
    if (to === "assistant") setSkipped((s) => ({ ...s, assistant: false }));
    setViewing(to === step ? null : to);
  }

  /** Done with the step on screen: on to whatever is still missing. */
  function onward(skip?: Partial<typeof skipped>) {
    setDir("from-right");
    if (skip) setSkipped((s) => ({ ...s, ...skip }));
    setViewing(null);
  }

  if (loading || !user || !ready) {
    return (
      <div
        className="font-ui flex min-h-dvh flex-col items-center justify-center gap-4 bg-canvas text-fg"
        role="status"
      >
        <LukeMark size="lg" state="thinking" />
        <span className="shimmer text-[13px]">Setting things up</span>
      </div>
    );
  }

  if (uninvited) return <InviteOnly signedIn />;

  const reading = Object.values(progress).find((p) => p.label && p.status !== "done")?.label;
  // Connected and still coming in: said wherever they are, so the
  // import is seen going on while they set up the rest.
  const syncing = !!connected && importing !== false;

  return (
    <Frame
      email={user.email}
      shown={shown}
      step={step}
      assistantOffered={assistantOffered}
      answers={answers}
      draft={draft}
      shop={connected?.store?.shop_domain ?? null}
      skipped={skipped}
      assistants={assistants}
      reading={reading}
      syncing={syncing}
      onRevisit={revisit}
    >
      <div key={shown} className={dir}>
        {loadError ? (
          <div className={note.critical}>{loadError}</div>
        ) : shown === "about" ? (
          <AboutYou
            userId={user.id}
            initial={answers}
            onDraft={setDraft}
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
              onward();
            }}
          />
        ) : shown === "store" ? (
          <Screen
            eyebrow="Your store"
            title={connected ? "Almost done" : "Connect your Shopify store"}
            lede={
              connected
                ? `${connected.store?.shop_domain ?? "Your store"} is connected, and already syncing in the background.`
                : "Warmluke reads your products, orders and customers, and changes nothing in your shop unless you say yes to that change."
            }
          >
            {connected ? (
              <div className="space-y-8">
                <div className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3">
                  <span className="h-2 w-2 shrink-0 rounded-full bg-signal-success" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                    {connected.store?.shop_domain}
                  </span>
                  <span className="text-xs text-fg-muted">{syncing ? "Syncing" : "Connected"}</span>
                </div>
                {historyOn && !connected.store?.history_set_at && !historyChosen ? (
                  // Right after Shopify said yes: how far back orders and
                  // customers go. Products are already coming in.
                  <div>
                    <h2 className="text-[15px] font-semibold text-fg">How far back should orders come in?</h2>
                    <p className="mt-1 mb-4 text-sm text-fg-muted">
                      Your products are already coming in. Choose how much order history to bring with them.
                    </p>
                    <HistoryPicker
                      projectId={connected.id}
                      onDone={async () => {
                        await apiFetch("/api/shopify/import", { projectId: connected.id, kick: true });
                        setHistoryChosen(true);
                        onward();
                      }}
                    />
                  </div>
                ) : (
                  <Actions onBack={() => revisit("about")} onNext={() => onward()} next="Continue" />
                )}
              </div>
            ) : target ? (
              <div className="space-y-6">
                {/* No way past it: Warmluke is built on the store, and a merchant
                    who went in without one found nothing there to build on. */}
                <ConnectShopify
                  projectId={target.id}
                  initialShop={target.store?.shop_domain ?? ""}
                  submitLabel={target.store ? "Reconnect" : "Connect"}
                  known={!!target.store && target.store.status !== "pending"}
                  onConnected={load}
                />
                <BackLink onBack={() => revisit("about")} />
              </div>
            ) : (
              <div className="space-y-3">
                <div className={note.critical}>There is no project to connect it to yet.</div>
                <button onClick={() => onward({ store: true })} className={button("secondary")}>
                  {LATER}
                </button>
              </div>
            )}
          </Screen>
        ) : shown === "assistant" ? (
          <Assistant
            connected={assistants}
            onBack={() => revisit("store")}
            onDone={() => onward({ assistant: true })}
          />
        ) : shown === "preparing" ? (
          <Screen
            eyebrow="Your store"
            title="Getting things ready for you"
            lede={`${connected?.store?.shop_domain ?? "Your store"} is syncing in the background. It carries on if you close this page, and what is in already is ready to use.`}
          >
            <ImportList progress={progress} />
            <div className="mt-8">
              <Actions
                onBack={() => revisit("store")}
                onNext={() => onward({ preparing: true })}
                next="Continue, it will finish on its own"
                quiet
              />
            </div>
          </Screen>
        ) : (
          <Done
            name={answers.full_name}
            business={answers.business_name}
            shop={connected?.store?.shop_domain ?? null}
            syncing={syncing}
            assistants={assistants}
            assistantOffered={assistantOffered}
            onChange={revisit}
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
      </div>
    </Frame>
  );
}

// ── The frame: Luke and the steps on the left, the screen on the right ──

type TrailItem = { key: Step; steps: Step[]; text: string };

function Frame({
  email,
  shown,
  step,
  assistantOffered,
  answers,
  draft,
  shop,
  skipped,
  assistants,
  reading,
  syncing,
  onRevisit,
  children,
}: {
  email: string | null | undefined;
  shown: Step;
  step: Step;
  assistantOffered: boolean;
  answers: Answers;
  draft: Answers;
  shop: string | null;
  skipped: { store: boolean; assistant: boolean; preparing: boolean };
  assistants: string[];
  reading?: string;
  syncing: boolean;
  onRevisit: (to: Step) => void;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const trail: TrailItem[] = [
    { key: "about", steps: ["about"], text: "About you" },
    { key: "store", steps: ["store", "preparing"], text: "Your store" },
    ...(assistantOffered ? [{ key: "assistant" as Step, steps: ["assistant"] as Step[], text: "Your AI" }] : []),
    { key: "done", steps: ["done"], text: "Ready" },
  ];
  const at = trail.findIndex((t) => t.steps.includes(shown));
  const reached = trail.findIndex((t) => t.steps.includes(step));
  const names = [...new Set(assistants)];

  /** What was answered in a step, said under it. */
  const said = (key: Step): string | null => {
    if (key === "about") return answers.business_name ? `${answers.full_name} · ${answers.business_name}` : null;
    if (key === "store") return shop ? (syncing ? `${shop} · syncing` : shop) : skipped.store ? "Later" : null;
    if (key === "assistant") return names.length ? names.join(", ") : skipped.assistant ? "Later" : null;
    return null;
  };

  const first = draft.full_name.trim().split(/\s+/)[0] ?? "";
  const business = draft.business_name.trim();
  // What Luke says beside each step; it answers to what they type.
  const line =
    shown === "about"
      ? first
        ? business
          ? `Nice to meet you, ${first}. Tell me about ${business}.`
          : `Nice to meet you, ${first}.`
        : "Hi, I’m Luke. A few questions, and I’ll set things up around how you work."
      : shown === "store"
        ? "I read your store and change nothing in it until you say yes."
        : shown === "preparing"
          ? reading
            ? `Reading ${reading.toLowerCase()}.`
            : "Starting on your store."
          : shown === "assistant"
            ? "If you already use Claude or ChatGPT, I can work alongside it."
            : `That’s everything${first ? `, ${first}` : ""}. Let’s build something.`;

  return (
    <div className="font-ui grid min-h-dvh bg-canvas text-fg lg:grid-cols-[20rem_minmax(0,1fr)]">
      {/* Luke and the steps. On a phone, a bar across the top instead. */}
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-surface px-7 py-7 lg:flex">
        <div className="flex items-center gap-2.5">
          <Logo className="h-5" priority />
          <span className="text-sm font-semibold">Warmluke</span>
        </div>

        <div className="mt-14">
          <LookingLuke thinking={shown === "preparing"} />
          <p aria-live="polite" className="mt-5 min-h-[4.5rem] text-[15px] leading-relaxed text-fg">
            {line}
          </p>
        </div>

        <ol aria-label="Steps" className="mt-8 space-y-0.5">
          {trail.map((t, i) => {
            const done = i < reached || (t.key === "done" && shown === "done");
            const current = i === at;
            const open = i <= reached && !current;
            const sub = said(t.key);
            return (
              <li key={t.key}>
                <button
                  onClick={() => onRevisit(t.key === "store" && step === "preparing" ? "preparing" : t.key)}
                  disabled={!open}
                  aria-current={current ? "step" : undefined}
                  className={`group flex w-full items-start gap-3 rounded-control px-2.5 py-2 text-left transition-colors ${
                    current ? "bg-surface-subdued" : open ? "hover:bg-surface-hover" : ""
                  }`}
                >
                  <span
                    className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums transition-colors ${
                      done && !current
                        ? "bg-primary text-on-primary"
                        : current
                          ? "border-2 border-primary text-fg"
                          : "border border-line-strong text-fg-faint"
                    }`}
                  >
                    {done && !current ? <Check aria-hidden size={11} strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-[13px] leading-5 font-medium ${
                        current ? "text-fg" : open ? "text-fg-muted group-hover:text-fg" : "text-fg-faint"
                      }`}
                    >
                      {t.text}
                    </span>
                    {sub && <span className="block truncate text-xs text-fg-faint">{sub}</span>}
                  </span>
                  {open && (
                    <span className="text-[11px] leading-5 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100">
                      Change
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>

        <div className="mt-auto flex items-center gap-2 border-t border-line pt-4 text-xs text-fg-muted">
          <span className="min-w-0 flex-1 truncate">{email}</span>
          <button
            onClick={() => signOut(router)}
            className={button("plain", "sm")}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut aria-hidden size={14} strokeWidth={1.75} />
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3 lg:hidden">
          <Logo className="h-4" priority />
          <span className="text-sm font-semibold">Warmluke</span>
          <span className="ml-auto text-xs text-fg-muted tabular-nums">
            {at + 1} of {trail.length} · {trail[at]?.text}
          </span>
          <button onClick={() => signOut(router)} className={button("plain", "sm")} aria-label="Sign out">
            <LogOut aria-hidden size={14} strokeWidth={1.75} />
          </button>
        </header>
        <div className="h-0.5 bg-line lg:hidden">
          <div
            className="h-full bg-primary transition-[width] duration-500"
            style={{ width: `${((at + 1) / trail.length) * 100}%` }}
          />
        </div>

        <div className="flex flex-1 justify-center px-5 pt-10 pb-16 sm:px-8 lg:pt-[12vh]">
          <div className="w-full max-w-[34rem]">
            {/* On a phone, Luke and what it says sit above the question. */}
            <div className="mb-8 flex items-start gap-3 lg:hidden">
              <LukeMark size="sm" state={shown === "preparing" ? "thinking" : "idle"} />
              <p className="pt-1 text-[13px] leading-relaxed text-fg-muted">{line}</p>
            </div>
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * Luke, looking at the pointer: the eyes follow it round the page, a
 * few pixels at most. Still for reduced motion and on touch, where there
 * is no pointer to follow.
 */
function LookingLuke({ thinking }: { thinking: boolean }) {
  const face = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = face.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let x = 0;
    let y = 0;
    const aim = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      const dx = x - (r.left + r.width / 2);
      const dy = y - (r.top + r.height / 2);
      const d = Math.max(1, Math.hypot(dx, dy));
      const k = Math.min(1, d / 400);
      el.style.setProperty("--look-x", `${((dx / d) * k * 5).toFixed(2)}px`);
      el.style.setProperty("--look-y", `${((dy / d) * k * 4).toFixed(2)}px`);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      x = e.clientX;
      y = e.clientY;
      if (!frame) frame = requestAnimationFrame(aim);
    };
    window.addEventListener("pointermove", move);
    return () => {
      window.removeEventListener("pointermove", move);
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <span ref={face} className="inline-flex">
      <LukeMark size="xl" state={thinking ? "thinking" : "idle"} />
    </span>
  );
}

/** Words arriving one after another, each coming into focus. */
function Reveal({ text, after = 0.05 }: { text: string; after?: number }) {
  return (
    <>
      {text.split(" ").map((w, i) => (
        <Fragment key={i}>
          <span className="word-in" style={{ ["--word-after" as string]: `${(after + i * 0.05).toFixed(2)}s` }}>
            {w}
          </span>{" "}
        </Fragment>
      ))}
    </>
  );
}

/** One screen: where it belongs, the question, what it is for, then what to do. */
function Screen({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string;
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="text-xs font-medium text-fg-muted">{eyebrow}</div>
      <h1 className="mt-2 text-[28px] leading-[1.15] font-semibold tracking-tight text-fg sm:text-[32px]">
        <Reveal text={title} />
      </h1>
      {lede && (
        <p
          className="rise mt-3 text-[15px] leading-relaxed text-fg-muted"
          style={{ ["--rise-after" as string]: "0.25s", ["--rise-from" as string]: "4px" }}
        >
          {lede}
        </p>
      )}
      <div className="mt-8">{children}</div>
    </section>
  );
}

/** Back on the left, onward on the right, the same on every screen. */
function Actions({
  onBack,
  onNext,
  next,
  busy,
  submit,
  quiet,
}: {
  onBack?: () => void;
  onNext?: () => void;
  next: string;
  busy?: boolean;
  submit?: boolean;
  quiet?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      {onBack && (
        <button type="button" onClick={onBack} className={`${button("plain", "lg")} -ml-3`}>
          <ArrowLeft aria-hidden size={16} strokeWidth={2} />
          Back
        </button>
      )}
      {submit && <span className="ml-auto hidden text-xs text-fg-faint sm:inline">or press Enter</span>}
      <button
        type={submit ? "submit" : "button"}
        onClick={submit ? undefined : onNext}
        disabled={busy}
        className={`${button(quiet ? "secondary" : "primary", "lg")} ${submit ? "" : "ml-auto"}`}
      >
        {next}
        {!busy && !quiet && <ArrowRight aria-hidden size={16} strokeWidth={2} />}
      </button>
    </div>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" onClick={onBack} className={`${button("plain", "sm")} -ml-2.5`}>
      <ArrowLeft aria-hidden size={14} strokeWidth={2} />
      Back
    </button>
  );
}

// ── About you: one question at a time ─────────────────────────────

/** The questions, the answers each one holds, and whether a tap on a choice moves on. */
const QUESTIONS: Array<{ fields: Array<keyof Answers>; advance?: true }> = [
  { fields: ["full_name", "business_name"] },
  { fields: ["role"], advance: true },
  { fields: ["monthly_orders"], advance: true },
  { fields: ["platform", "website"] },
  { fields: ["team_size", "heard_from", "heard_from_detail"] },
];

function AboutYou({
  userId,
  initial,
  onDraft,
  onSaved,
}: {
  userId: string;
  initial: Answers;
  onDraft: (a: Answers) => void;
  onSaved: (a: Answers) => Promise<void>;
}) {
  const [a, setA] = useState<Answers>(initial);
  const [q, setQ] = useState(0);
  const [dir, setDir] = useState<Dir>("from-right");
  const [tried, setTried] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrong = useMemo(() => problems(a), [a]);
  const last = q === QUESTIONS.length - 1;
  const business = a.business_name.trim() || "the business";

  const update = (k: keyof Answers, v: string) => {
    const nextA = { ...a, [k]: v };
    setA(nextA);
    onDraft(nextA);
  };
  const set = (k: keyof Answers) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    update(k, e.target.value);
  const shown = (k: keyof Answers) => (tried === q ? wrong[k] : undefined);
  const detail = heardDetailPrompt(a.heard_from);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const bad = QUESTIONS[q].fields.some((f) => wrong[f]);
    if (bad) {
      setTried(q);
      return;
    }
    if (!last) {
      setDir("from-right");
      setQ(q + 1);
      return;
    }
    if (Object.keys(wrong).length > 0 || busy) {
      setTried(q);
      return;
    }
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

  function back() {
    setDir("from-left");
    setQ(q - 1);
  }

  /** A choice: kept, and on a question with one answer, straight on to the next. */
  function choose(k: keyof Answers, v: string) {
    update(k, v);
    if (QUESTIONS[q].advance) {
      setTimeout(() => {
        setDir("from-right");
        setQ((n) => Math.min(n + 1, QUESTIONS.length - 1));
      }, 220);
    }
  }

  const eyebrow = `About you · ${q + 1} of ${QUESTIONS.length}`;
  return (
    <form onSubmit={save} noValidate>
      <div key={q} className={dir}>
        {q === 0 ? (
          <Screen
            eyebrow={eyebrow}
            title="First, who are we talking to?"
            lede="So Warmluke fits the way your business already works. It takes a minute."
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <Text
                id="full_name"
                text="Your name"
                value={a.full_name}
                onChange={set("full_name")}
                error={shown("full_name")}
                max={NAME_MAX}
                autoComplete="name"
                autoFocus
              />
              <Text
                id="business_name"
                text="Business name"
                value={a.business_name}
                onChange={set("business_name")}
                error={shown("business_name")}
                max={BUSINESS_MAX}
                autoComplete="organization"
              />
            </div>
          </Screen>
        ) : q === 1 ? (
          <Screen eyebrow={eyebrow} title={`What do you do at ${business}?`}>
            <Choices
              label="Your role"
              options={ROLE_OPTIONS}
              value={a.role}
              onPick={(v) => choose("role", v)}
              error={shown("role")}
            />
          </Screen>
        ) : q === 2 ? (
          <Screen eyebrow={eyebrow} title="How many orders a month?">
            <Choices
              label="Orders a month"
              options={ORDER_OPTIONS}
              value={a.monthly_orders}
              onPick={(v) => choose("monthly_orders", v)}
              error={shown("monthly_orders")}
            />
          </Screen>
        ) : q === 3 ? (
          <Screen eyebrow={eyebrow} title="Where does the store run?">
            <Choices
              label="Where your store runs"
              options={PLATFORM_OPTIONS}
              value={a.platform}
              onPick={(v) => choose("platform", v)}
              error={shown("platform")}
            />
            <div className="mt-6">
              <Text
                id="website"
                text="Website"
                value={a.website}
                onChange={set("website")}
                error={shown("website")}
                max={TEXT_MAX}
                placeholder="yourstore.com"
                autoComplete="url"
              />
            </div>
          </Screen>
        ) : (
          <Screen eyebrow={eyebrow} title="Two last things, both optional.">
            <Choices
              label="Team size"
              options={TEAM_OPTIONS}
              value={a.team_size}
              onPick={(v) => choose("team_size", a.team_size === v ? "" : v)}
              compact
            />
            <div className="mt-6 grid gap-5 sm:grid-cols-2">
              <Pick
                id="heard_from"
                text="How did you hear about us?"
                value={a.heard_from}
                onChange={set("heard_from")}
                options={HEARD_OPTIONS}
                error={shown("heard_from")}
                optional
              />
              {detail && (
                <Text
                  id="heard_from_detail"
                  text={detail}
                  value={a.heard_from_detail}
                  onChange={set("heard_from_detail")}
                  error={shown("heard_from_detail")}
                  max={TEXT_MAX}
                />
              )}
            </div>
          </Screen>
        )}
      </div>
      {error && <div className={`${note.critical} mt-6`}>{error}</div>}
      <div className="mt-8">
        <Actions
          onBack={q > 0 ? back : undefined}
          next={busy ? "Saving…" : last ? "Save and continue" : "Continue"}
          busy={busy}
          submit
        />
      </div>
    </form>
  );
}

/**
 * Choices as tiles, each with the letter that picks it from the keyboard.
 * Letters only while no field has focus, so typing a name never picks one.
 */
function Choices({
  label: text,
  options,
  value,
  onPick,
  error,
  compact,
}: {
  label: string;
  options: Option[];
  value: string;
  onPick: (v: string) => void;
  error?: string;
  compact?: boolean;
}) {
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  });
  useEffect(() => {
    if (compact) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && /INPUT|TEXTAREA|SELECT/.test(t.tagName))) return;
      const i = e.key.toLowerCase().charCodeAt(0) - 97;
      if (e.key.length === 1 && i >= 0 && i < options.length) pick.current(options[i].value);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [options, compact]);

  return (
    <div>
      <div
        role="radiogroup"
        aria-label={text}
        className={`grid gap-2 ${compact ? "grid-cols-2 sm:grid-cols-3" : "sm:grid-cols-2"}`}
      >
        {options.map((o, i) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onPick(o.value)}
              className={`group flex min-h-11 items-center gap-3 rounded-control border bg-surface px-3 py-2.5 text-left text-sm transition-[border-color,box-shadow,background-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                on
                  ? "border-primary shadow-[0_0_0_1px_var(--color-primary)]"
                  : "border-line hover:border-line-strong hover:bg-surface-hover"
              }`}
            >
              {!compact && (
                <span
                  aria-hidden
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[10px] font-semibold uppercase ${
                    on ? "border-primary bg-primary text-on-primary" : "border-line-strong text-fg-muted"
                  }`}
                >
                  {String.fromCharCode(97 + i)}
                </span>
              )}
              <span className={`min-w-0 flex-1 truncate text-fg ${on ? "font-medium" : ""}`}>{o.label}</span>
              {on && <Check aria-hidden size={14} strokeWidth={2.5} className="shrink-0 text-fg" />}
            </button>
          );
        })}
      </div>
      {error && <p className="mt-2 text-xs text-tone-critical-fg">{error}</p>}
    </div>
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
//
// Warmluke cannot add itself to someone's Claude or ChatGPT: they add it
// there. So this shows where the buttons are in theirs, from the same
// list the app's "Use your own AI" draws (lib/connect-assistants), and
// says plainly that it turns green when they allow it. It used to wait
// under a spinner, which read as Warmluke doing the connecting.

/**
 * A step as the list writes it, "Apps → Advanced settings: turn on
 * Developer mode.", drawn the way it is followed: the menu path in bold
 * with a chevron between names, and what to do there on the line below.
 */
function StepText({ text }: { text: string }) {
  const parts = text.split(" → ");
  if (parts.length === 1) return <span className="text-fg">{text}</span>;
  const last = parts.pop() ?? "";
  const cut = last.search(/[:.](\s|$)/);
  const path = [...parts, cut < 0 ? last : last.slice(0, cut)];
  const rest = cut < 0 ? "" : last.slice(cut + 1).trim();
  return (
    <span className="block">
      <span className="flex flex-wrap items-center gap-x-1 font-medium text-fg">
        {path.map((p, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <>
                <ChevronRight aria-hidden size={13} strokeWidth={2} className="text-fg-faint" />
                <span className="sr-only">, then </span>
              </>
            )}
            <span>{p}</span>
          </Fragment>
        ))}
      </span>
      {rest && <span className="mt-0.5 block text-fg-muted">{rest.charAt(0).toUpperCase() + rest.slice(1)}</span>}
    </span>
  );
}

/** One of the two parts, numbered, with a line down to the next. */
function Part({ n, title, last, children }: { n: number; title: string; last?: boolean; children: React.ReactNode }) {
  return (
    <section className="relative pl-10">
      {!last && <span aria-hidden className="absolute top-8 bottom-1 left-3 w-px bg-line" />}
      <span className="absolute top-0 left-0 flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-on-primary tabular-nums">
        {n}
      </span>
      <h2 className="text-[15px] leading-6 font-semibold text-fg">{title}</h2>
      <div className={`mt-3 ${last ? "" : "pb-8"}`}>{children}</div>
    </section>
  );
}

function Assistant({ connected, onBack, onDone }: { connected: string[]; onBack: () => void; onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [which, setWhich] = useState(ASSISTANTS[0].id);
  const url = typeof window === "undefined" ? "" : `${window.location.origin}/api/mcp`;
  const names = [...new Set(connected)];
  const chosen = ASSISTANTS.find((a) => a.id === which) ?? ASSISTANTS[0];
  const where = chosen.id === "any" ? "your AI" : chosen.name;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }

  const copyButton = (text: string) => (
    <button onClick={() => copy(text)} className={button("secondary")}>
      {copied === text ? (
        <Check aria-hidden size={15} strokeWidth={2} className="text-signal-success" />
      ) : (
        <Copy aria-hidden size={15} strokeWidth={1.75} />
      )}
      {copied === text ? "Copied" : "Copy"}
    </button>
  );

  return (
    <Screen
      eyebrow="Your AI · optional"
      title="Use Claude or ChatGPT with your store"
      lede="Add Warmluke inside the AI you already use. It can then read your store, and anything it wants to build or change waits here for your yes."
    >
      <Part n={1} title="Copy this address">
        <div className="flex gap-2">
          <input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Connector address"
            className={`${fieldOf("md")} w-full min-w-0 font-mono`}
          />
          {copyButton(url)}
        </div>
      </Part>

      <Part n={2} title="Add it in your AI" last>
        <div role="group" aria-label="Your AI" className="grid grid-cols-3 gap-1.5">
          {ASSISTANTS.map((a) => (
            <button
              key={a.id}
              onClick={() => setWhich(a.id)}
              aria-pressed={which === a.id}
              className={button(which === a.id ? "secondary" : "plain", "sm")}
            >
              {a.logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- a small SVG, nothing to optimise
                <img src={a.logo} alt="" width={14} height={14} className="h-3.5 w-3.5 shrink-0 object-contain" />
              ) : (
                <Plug aria-hidden size={14} strokeWidth={1.75} className="shrink-0" />
              )}
              {a.name}
            </button>
          ))}
        </div>
        <ol className="mt-5 space-y-4 text-sm leading-relaxed">
          {chosen.steps(url).map((s, i) => (
            <li key={`${chosen.id}-${i}`} className="flex gap-3">
              <span className="w-4 shrink-0 pt-px text-right text-xs font-medium text-fg-faint tabular-nums">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 space-y-2">
                <StepText text={s.text} />
                {s.copy && (
                  <span className="flex gap-2">
                    <code className="min-w-0 flex-1 rounded-control bg-surface-subdued px-2.5 py-2 font-mono text-xs break-all text-fg">
                      {s.copy}
                    </code>
                    {copyButton(s.copy)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
        {chosen.plan && <p className="mt-3 pl-7 text-xs text-fg-faint">{chosen.plan}</p>}
      </Part>

      <div
        role="status"
        className={`mt-8 flex items-center gap-2.5 rounded-control px-3 py-2.5 text-[13px] ${
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
            <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-line-strong" />
            Not connected yet. When you allow Warmluke in {where}, this turns green.
          </>
        )}
      </div>

      <div className="mt-8">
        <Actions onBack={onBack} onNext={onDone} next={names.length ? "Continue" : LATER} quiet={!names.length} />
      </div>
    </Screen>
  );
}

// ── The import ──────────────────────────────────────────────────

function ImportList({ progress }: { progress: Progress }) {
  const rows = Object.entries(progress).filter(([, p]) => p.label);
  if (rows.length === 0) {
    return <div className="h-24 animate-pulse rounded-card bg-surface-subdued" />;
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
      {rows.map(([key, p]) => {
        const done = p.status === "done";
        return (
          <li key={key} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            {done ? (
              <Check aria-hidden size={15} strokeWidth={2} className="text-signal-success" />
            ) : (
              <LoaderCircle
                aria-hidden
                size={15}
                strokeWidth={1.75}
                className="animate-spin text-fg-faint motion-reduce:animate-none"
              />
            )}
            <span className={`flex-1 ${done ? "text-fg" : "shimmer"}`}>{p.label}</span>
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
  business,
  shop,
  syncing,
  assistants,
  assistantOffered,
  onChange,
  onOpen,
}: {
  name: string;
  business: string;
  shop: string | null;
  syncing: boolean;
  assistants: string[];
  assistantOffered: boolean;
  onChange: (to: Step) => void;
  onOpen: () => Promise<string | null | undefined>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = name.trim().split(/\s+/)[0];
  const names = [...new Set(assistants)];
  // What was set up, each with a way back to it.
  const summary: Array<{ to: Step; what: string; value: string; set: boolean }> = [
    { to: "about", what: "About you", value: business ? `${name} · ${business}` : name, set: true },
    {
      to: "store",
      what: "Store",
      value: shop ? (syncing ? `${shop} · syncing` : shop) : "Not connected yet",
      set: !!shop,
    },
    ...(assistantOffered
      ? [
          {
            to: "assistant" as Step,
            what: "Your AI",
            value: names.length ? names.join(", ") : "Not connected yet",
            set: names.length > 0,
          },
        ]
      : []),
  ];
  return (
    <Screen
      eyebrow="Ready"
      title={first ? `You’re all set, ${first}` : "You’re all set"}
      lede={
        shop && syncing
          ? "Your store is still syncing in the background, and what is in already is ready. Ask Luke anything about it, or describe the tool you wish you had and it builds it around how you work."
          : shop
            ? "Your store is in. Ask Luke anything about it, or describe the tool you wish you had and it builds it around how you work."
            : "Describe the problem you’re stuck on, not the software, and Luke builds the app around how you work. You can connect your store whenever you like."
      }
    >
      <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
        {summary.map((s) => (
          <li key={s.what} className="flex items-center gap-3 px-4 py-3">
            <span className={`h-2 w-2 shrink-0 rounded-full ${s.set ? "bg-signal-success" : "bg-line-strong"}`} />
            <span className="w-20 shrink-0 text-xs text-fg-muted">{s.what}</span>
            <span className={`min-w-0 flex-1 truncate text-sm ${s.set ? "text-fg" : "text-fg-faint"}`}>{s.value}</span>
            <button onClick={() => onChange(s.to)} className={button("plain", "sm")}>
              {s.set ? "Change" : "Set up"}
            </button>
          </li>
        ))}
      </ul>
      {error && <div className={`${note.critical} mt-4`}>{error}</div>}
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
        className={`${button("primary", "lg")} mt-8 w-full`}
      >
        {busy ? "Opening…" : "Open Warmluke"}
        {!busy && <ArrowRight aria-hidden size={16} strokeWidth={2} />}
      </button>
    </Screen>
  );
}
