"use client";

// ─────────────────────────────────────────────────────────────
// Conversations — any conversation with Luke, as the team that fixes
// things needs to read it (0158).
//
// Paste an id from a report — a conversation's, or one turn's from
// "Copy debug info" — and the conversation opens: whose it is, which
// project and store, every message, and beside each reply the trace of
// the turn that made it: which road it took, every step, what failed
// validation and was repaired, what it could not do, the critic's word,
// how long it took, and each model call's tokens and cost. Or browse:
// the latest, the ones that went wrong, cost most or took longest.
//
// Every opening is written to the account's trail, as support access is.
// The database refuses anyone who is not an administrator; this page
// decides nothing.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, ChevronRight, Copy, Download, Search, TriangleAlert } from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { useConsoleScope } from "@/lib/console-scope";
import { useUser } from "@/lib/auth";
import { ago } from "@/lib/when";
import { dollars, modelName, tokensShort } from "@/lib/model-prices";
import type { TurnUsage } from "@/lib/types";
import { PageFrame } from "@/components/PageFrame";
import { Choices, panelScroll } from "@/components/AdminParts";
import { button, card, field, note } from "@/components/ui/controls";

type Filter = "recent" | "problems" | "costly" | "slow";
type Row = {
  id: string;
  title: string | null;
  updated_at: string;
  project: { id: string; name: string };
  owner: string | null;
  shop: string | null;
  turns: number;
  usd: number;
  input: number;
  output: number;
  slowest_ms: number;
  troubled: number;
};
type Trace = {
  turn_id: string | null;
  road: string | null;
  model: string | null;
  steps: Array<Record<string, unknown> & { step: string }>;
  usage: TurnUsage | null;
  repairs: number;
  repair_errors: unknown[];
  unmet: unknown[];
  plan_goal: string | null;
  critic: { verdict: string; missing: number } | null;
  took_ms: number | null;
  created_at: string;
};
type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  payload: Record<string, unknown> | null;
  created_at: string;
};
type Whole = {
  conversation: { id: string; title: string | null; created_at: string; updated_at: string };
  project: { id: string; name: string };
  owner: { id: string; email: string | null };
  store: { shop: string; status: string } | null;
  messages_total: number;
  messages: Message[];
  traces: Trace[];
};

const FILTERS: Array<[Filter, string]> = [
  ["recent", "Latest"],
  ["problems", "Went wrong"],
  ["costly", "Cost most"],
  ["slow", "Took longest"],
];
const DAYS: Array<[number, string]> = [
  [1, "Today"],
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
];
const PAGE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

/** Whether a turn went wrong somewhere: repaired, left something out, or sent back by the critic. */
const troubled = (t: Trace) =>
  t.repairs > 0 ||
  (t.repair_errors?.length ?? 0) > 0 ||
  (t.unmet?.length ?? 0) > 0 ||
  t.critic?.verdict === "redo" ||
  (t.critic?.missing ?? 0) > 0;

export default function Conversations() {
  const { user, loading } = useUser();
  const router = useRouter();
  const params = useSearchParams();
  const open = params.get("id");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, router]);

  // The conversation is the address (?id=), so a link to it opens it and Back closes it.
  const show = useCallback((id: string | null) => {
    const at = new URLSearchParams(window.location.search);
    if (id) at.set("id", id);
    else at.delete("id");
    const qs = at.toString();
    window.history.pushState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, []);

  // ── The list ──
  const [query, setQuery] = useState("");
  const [asked, setAsked] = useState("");
  const [filter, setFilter] = useState<Filter>("recent");
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const scope = useConsoleScope();
  // Find was just pressed with a whole id: open what it names, once. Not
  // again when Back comes to the list with the same search still in it.
  const jump = useRef<string | null>(null);

  const list = useCallback(
    async (before: string | null) => {
      setBusy(true);
      const { data, error: err } = await supabase.rpc("abo_admin_conversations", {
        p_query: asked || null,
        p_filter: filter,
        p_days: days,
        p_limit: PAGE,
        p_before: before,
        // Whose conversations: every account, one, or one app of it (0184).
        p_account: scope.account,
        p_app: scope.app,
      });
      setBusy(false);
      setNow(Date.now());
      if (err) {
        setError(
          err.code === "42501"
            ? "This page is for administrators."
            : err.code === "PGRST202"
              ? "This database does not have this yet: apply migration 0158."
              : err.message
        );
        return;
      }
      setError(null);
      const got = (data ?? []) as Row[];
      setRows((prev) => (before && prev ? [...prev, ...got] : got));
      // Only the latest pages on; the others are a top list.
      setMore(filter === "recent" && got.length === PAGE);
      // A whole id pasted: straight to the conversation it names.
      // Only the answer to the search that asked for it: a list still coming back from before does not count.
      if (!before && asked && jump.current === asked) {
        jump.current = null;
        if (UUID.test(asked) && got.length === 1) show(got[0].id);
      }
    },
    [asked, filter, days, show, scope]
  );

  useEffect(() => {
    if (user && !open) list(null);
  }, [user, open, list]);

  // ── One conversation ──
  const [whole, setWhole] = useState<Whole | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!user || !open) return;
    let live = true;
    supabase.rpc("abo_admin_conversation", { p_id: open, p_limit: 300 }).then(({ data, error: err }) => {
      if (!live) return;
      setNow(Date.now());
      if (err) {
        setError(err.code === "42501" ? "This page is for administrators." : err.message);
        return;
      }
      setMissing(!data);
      setWhole((data as Whole | null) ?? null);
    });
    return () => {
      live = false;
      setWhole(null);
      setMissing(false);
    };
  }, [user, open]);

  if (loading || !user) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-40 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 h-72 animate-pulse rounded-card bg-surface shadow-card" />
        </div>
      </PageFrame>
    );
  }

  const refused = error === "This page is for administrators.";
  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        {error && (
          <div role="alert" className={`${note.critical} mb-5 text-[13px]`}>
            {error}
          </div>
        )}
        {open ? (
          <Detail whole={whole} missing={missing} id={open} now={now} onBack={() => window.history.back()} />
        ) : (
          !refused && (
            <>
              <h1 className="text-xl font-semibold tracking-tight text-fg">Conversations</h1>
              <p className="mt-1 text-[13px] text-fg-muted">
                Paste an id from a report, a conversation&rsquo;s or a turn&rsquo;s, or find one by its owner, project,
                store or title. Opening one is written to that account&rsquo;s trail.
              </p>
              <form
                className="mt-5 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  jump.current = query.trim();
                  setAsked(query.trim());
                }}
              >
                <div className="relative min-w-0 flex-1">
                  <Search
                    aria-hidden
                    size={15}
                    strokeWidth={1.75}
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-faint"
                  />
                  <input
                    className={`${field} pl-9`}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Conversation or turn id, email, project, store, title"
                    aria-label="Find a conversation"
                    spellCheck={false}
                  />
                </div>
                <button type="submit" className={button("primary")}>
                  Find
                </button>
              </form>
              <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
                <Choices options={FILTERS} value={filter} onChange={setFilter} />
                <Choices options={DAYS} value={days} onChange={setDays} />
                {!!rows?.length && (
                  <span className="ml-auto text-xs text-fg-faint tabular-nums" aria-live="polite">
                    {rows.length.toLocaleString()} {rows.length === 1 ? "conversation" : "conversations"}
                    {more ? ", older below" : ""}
                  </span>
                )}
              </div>
              <div className={`${card} ${panelScroll} mt-4`}>
                {rows === null ? (
                  <div className="h-48 animate-pulse bg-surface-subdued" aria-busy />
                ) : rows.length === 0 ? (
                  <p className="px-5 py-8 text-center text-[13px] text-fg-muted">
                    {asked ? `Nothing matches “${asked}”.` : "No conversations in this window."}
                  </p>
                ) : (
                  <ul className="divide-y divide-line">
                    {rows.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => show(r.id)}
                          className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-left transition-colors hover:bg-surface-hover"
                        >
                          <span className="min-w-0 flex-1 basis-48">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-[13px] font-medium text-fg">
                                {r.title || "Untitled conversation"}
                              </span>
                              {r.troubled > 0 && (
                                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-tone-attention/60 px-1.5 py-px text-[10px] font-medium text-tone-attention-fg">
                                  <TriangleAlert aria-hidden size={10} strokeWidth={2} />
                                  {r.troubled} went wrong
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 block truncate text-xs text-fg-muted">
                              {r.owner ?? "An account since deleted"} · {r.project.name}
                              {r.shop ? ` · ${r.shop}` : ""}
                            </span>
                          </span>
                          <span className="order-last w-full text-xs text-fg-muted tabular-nums sm:order-none sm:w-auto">
                            {r.turns} {r.turns === 1 ? "turn" : "turns"} · {dollars(Number(r.usd))} ·{" "}
                            {tokensShort(Number(r.input))} in
                            {r.slowest_ms > 0 ? ` · slowest ${seconds(r.slowest_ms)}` : ""}
                          </span>
                          <span className="w-20 text-right text-xs text-fg-faint">{ago(r.updated_at, now)}</span>
                          <ChevronRight aria-hidden size={14} strokeWidth={1.75} className="text-fg-faint" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {more && rows && (
                <div className="mt-4 flex justify-center">
                  <button
                    onClick={() => list(rows[rows.length - 1].updated_at)}
                    disabled={busy}
                    className={button("secondary", "sm")}
                  >
                    {busy ? "Loading…" : "Older"}
                  </button>
                </div>
              )}
            </>
          )
        )}
      </div>
    </PageFrame>
  );
}

function CopyId({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={`Copy ${text}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          setDone(false);
        }
      }}
      className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[11px] text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
    >
      {done ? (
        <Check aria-hidden size={11} strokeWidth={2.5} className="text-signal-success" />
      ) : (
        <Copy aria-hidden size={11} strokeWidth={2} />
      )}
      {done ? "Copied" : (label ?? text)}
    </button>
  );
}

function Detail({
  whole,
  missing,
  id,
  now,
  onBack,
}: {
  whole: Whole | null;
  missing: boolean;
  id: string;
  now: number;
  onBack: () => void;
}) {
  // Each reply's trace, found by its turn: the reply's message id is the turn's.
  const byTurn = useMemo(() => new Map((whole?.traces ?? []).map((t) => [t.turn_id, t])), [whole]);
  const totals = useMemo(() => {
    const ts = whole?.traces ?? [];
    return {
      turns: ts.length,
      // Read from cache is counted apart, as under each reply.
      input: ts.reduce((n, t) => n + (t.usage?.uses ?? []).reduce((m, u) => m + u.input, 0), 0),
      output: ts.reduce((n, t) => n + (t.usage?.uses ?? []).reduce((m, u) => m + u.output, 0), 0),
      usd: ts.reduce((n, t) => n + (t.usage?.usd ?? 0), 0),
      ms: ts.reduce((n, t) => n + (t.took_ms ?? 0), 0),
      wrong: ts.filter(troubled).length,
    };
  }, [whole]);

  const back = (
    <button onClick={onBack} className={`${button("plain", "sm")} -ml-2`}>
      <ArrowLeft aria-hidden size={14} strokeWidth={2} />
      Conversations
    </button>
  );
  if (missing) {
    return (
      <div>
        {back}
        <p className={`${note.attention} mt-4 text-[13px]`}>
          No conversation has the id {id}. It may have been deleted.
        </p>
      </div>
    );
  }
  if (!whole) {
    return (
      <div>
        {back}
        <div className="mt-4 h-72 animate-pulse rounded-card bg-surface shadow-card" aria-busy />
      </div>
    );
  }

  const download = () => {
    const blob = new Blob([JSON.stringify(whole, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `conversation-${whole.conversation.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      {back}
      <div className={`${card} mt-3 p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight text-fg">
              {whole.conversation.title || "Untitled conversation"}
            </h1>
            <p className="mt-0.5 text-[13px] text-fg-muted">
              {whole.owner.email ?? "An account since deleted"} · {whole.project.name}
              {whole.store ? ` · ${whole.store.shop} (${whole.store.status})` : ""}
            </p>
          </div>
          <button onClick={download} className={button("secondary", "sm")}>
            <Download aria-hidden size={13} strokeWidth={2} />
            Download as JSON
          </button>
        </div>
        <dl className="mt-4 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
          {(
            [
              ["Conversation", <CopyId key="c" text={whole.conversation.id} />],
              ["Project", <CopyId key="p" text={whole.project.id} />],
              [
                "Started",
                `${new Date(whole.conversation.created_at).toLocaleString()} (${ago(whole.conversation.created_at, now)})`,
              ],
              ["Last turn", ago(whole.conversation.updated_at, now)],
              [
                "Taken",
                `${totals.turns} ${totals.turns === 1 ? "turn" : "turns"} · ${tokensShort(totals.input)} in · ${tokensShort(totals.output)} out · ${dollars(totals.usd)} · ${seconds(totals.ms)}`,
              ],
              ["Went wrong", totals.wrong ? `${totals.wrong} of ${totals.turns} turns` : "None"],
            ] as Array<[string, React.ReactNode]>
          ).map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="w-28 shrink-0 text-fg-muted">{k}</dt>
              <dd className="min-w-0 text-fg">{v}</dd>
            </div>
          ))}
        </dl>
        {whole.messages_total > whole.messages.length && (
          <p className={`${note.info} mt-4`}>
            The latest {whole.messages.length} of {whole.messages_total} messages. Download as JSON has the same.
          </p>
        )}
      </div>

      <ol className="mt-4 space-y-3">
        {whole.messages.map((m) => {
          const t = m.role === "assistant" ? byTurn.get(m.id) : undefined;
          const said =
            m.role === "user"
              ? m.content
              : typeof m.payload?.message === "string"
                ? m.payload.message
                : typeof m.payload?.text === "string"
                  ? m.payload.text
                  : m.content;
          return (
            <li key={m.id} className={`${card} p-4 ${m.role === "user" ? "bg-surface-subdued" : ""}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
                <span className="font-medium text-fg">{m.role === "user" ? "Asked" : "Luke"}</span>
                {m.role === "assistant" && typeof m.payload?.type === "string" && (
                  <span className="rounded bg-surface-hover px-1.5 py-px text-[11px]">{m.payload.type}</span>
                )}
                <span>{new Date(m.created_at).toLocaleString()}</span>
                <span className="ml-auto">
                  <CopyId text={m.id} label={m.role === "assistant" ? `turn ${m.id.slice(0, 8)}` : m.id.slice(0, 8)} />
                </span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed whitespace-pre-wrap text-fg">{said}</p>
              {t && <TraceView t={t} />}
              {m.role === "assistant" && (
                <details className="mt-2 text-xs text-fg-muted">
                  <summary className="cursor-pointer select-none hover:text-fg">The reply as stored</summary>
                  <pre className="mt-2 max-h-96 overflow-auto rounded-control bg-surface-subdued p-3 font-mono text-[11px] leading-relaxed text-fg">
                    {JSON.stringify(m.payload, null, 2)}
                  </pre>
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** One turn's trace: how Luke got to the reply above it. */
function TraceView({ t }: { t: Trace }) {
  const wrong = troubled(t);
  return (
    <details
      className={`mt-3 rounded-control border p-3 text-xs ${wrong ? "border-tone-attention" : "border-line"}`}
      open={wrong}
    >
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 select-none">
        <span className="font-medium text-fg">Trace</span>
        {t.road && <span className="text-fg-muted">road {t.road}</span>}
        {t.model && <span className="text-fg-muted">{modelName(t.model)}</span>}
        {t.took_ms !== null && <span className="text-fg-muted tabular-nums">{seconds(t.took_ms)}</span>}
        {t.usage && <span className="text-fg-muted tabular-nums">{dollars(t.usage.usd)}</span>}
        {wrong && (
          <span className="inline-flex items-center gap-1 rounded-full bg-tone-attention/60 px-1.5 py-px text-[10px] font-medium text-tone-attention-fg">
            <TriangleAlert aria-hidden size={10} strokeWidth={2} />
            went wrong
          </span>
        )}
      </summary>
      <div className="mt-3 space-y-3 text-fg">
        {t.plan_goal && (
          <p>
            <span className="text-fg-muted">Understood: </span>
            {t.plan_goal}
          </p>
        )}
        {t.critic && (
          <p>
            <span className="text-fg-muted">Critic: </span>
            {t.critic.verdict}
            {t.critic.missing ? `, ${t.critic.missing} missing` : ""}
          </p>
        )}
        {t.repairs > 0 && (
          <div>
            <p className="text-fg-muted">Repaired {t.repairs} times, for:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono text-[11px]">
              {(t.repair_errors ?? []).map((e, k) => (
                <li key={k}>{typeof e === "string" ? e : JSON.stringify(e)}</li>
              ))}
            </ul>
          </div>
        )}
        {(t.unmet?.length ?? 0) > 0 && (
          <div>
            <p className="text-fg-muted">Could not do:</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {t.unmet.map((u, k) => (
                <li key={k}>{typeof u === "string" ? u : JSON.stringify(u)}</li>
              ))}
            </ul>
          </div>
        )}
        {t.usage && (
          <div>
            <p className="text-fg-muted">Model calls</p>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px] tabular-nums">
              {t.usage.uses.map((u, k) => (
                <li key={k}>
                  {u.job} · {u.model}
                  {u.calls > 1 ? ` · ${u.calls} calls` : ""} · {u.input} in
                  {u.cacheRead ? ` (${u.cacheRead} cached)` : ""} · {u.output} out ·{" "}
                  {u.usd === null ? "unpriced" : dollars(u.usd)}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <p className="text-fg-muted">Steps</p>
          <ol className="mt-1 space-y-0.5 font-mono text-[11px]">
            {(t.steps ?? []).map((s, k) => {
              const { step, ...rest } = s;
              const said = JSON.stringify(rest);
              return (
                <li key={k} className="break-words">
                  <span className="text-fg">{step}</span>
                  {said !== "{}" && <span className="text-fg-muted"> {said}</span>}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </details>
  );
}
