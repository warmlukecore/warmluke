"use client";

// ─────────────────────────────────────────────────────────────
// ChatPanel — presentational assistant panel. State and actions
// live in AppShell so the first-build flow can drive messages.
// Deletion always requires typing the module's name.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { watchRows } from "@/lib/live";
import GenericRenderer from "@/components/GenericRenderer";
import { describeAutomation, describePlan, type StoreFacts } from "@/lib/describe";
import { storeOverview } from "@/lib/store-read";
import { supabase } from "@/lib/supabase-client";
import { NOT_SUPPORTED } from "@/lib/capabilities";
import { resizeHandleClass } from "@/lib/useResizable";
import type {
  AssistantPlan,
  Blueprint,
  ClarifyQuestion,
  ModuleRow,
  RecordRow,
  UiSchema,
} from "@/lib/types";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text?: string;
  plan?: AssistantPlan;
  /** Discovery questions — answered inline, sent back as one message. */
  questions?: ClarifyQuestion[];
  /** Plain-language design awaiting the owner's approval. */
  blueprint?: Blueprint;
  errors?: string[];
}

let msgSeq = 0;
export const nextChatId = () => `m${++msgSeq}`;

const ICON_GLYPHS: Record<string, string> = {
  "shopping-cart": "🛒",
  package: "📦",
  users: "👥",
  receipt: "🧾",
  calendar: "📅",
  "clipboard-list": "📋",
  "undo-2": "↩️",
  box: "📦",
  heart: "❤️",
  wrench: "🔧",
  globe: "🌐",
  truck: "🚚",
  wallet: "👛",
  target: "🎯",
  table: "📋",
};

function describeFeatures(f: NonNullable<AssistantPlan["features"]>): string[] {
  const out: string[] = [];
  if (f.search?.enabled) out.push(`🔍 Search${f.search.fields?.length ? ` over ${f.search.fields.join(", ")}` : ""}`);
  for (const fl of f.filters ?? []) out.push(`▦ Filter: ${fl.label} (${fl.options.join(" / ")})`);
  for (const s of f.stats ?? []) out.push(`📊 Stat: ${s.label} (${s.op}${s.field ? ` of ${s.field}` : ""})`);
  if (f.defaultSort) out.push(`↕ Default sort: ${f.defaultSort.field} ${f.defaultSort.dir}`);
  if (out.length === 0) out.push("No features — plain table");
  return out;
}


// ── Discovery cards ──────────────────────────────────────────
// These are the human-in-the-loop steps that happen BEFORE anything
// is built: the assistant asks how the business actually works, then
// proposes a design in plain language for the owner to approve.

/**
 * The answers a card collected live in the reply it sent, not in this
 * component. A reloaded thread mounts a fresh ClarifyCard with empty
 * state, so every question read "(skipped)" even though the owner had
 * answered it. Read them back out of that reply instead.
 */
function answersFromReply(
  text: string,
  questions: ClarifyQuestion[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const block of text.split("\n\n")) {
    const at = block.indexOf("\n\u2192 ");
    if (at < 0) continue;
    const q = block.slice(0, at).trim();
    const a = block.slice(at + 3).trim();
    const match = questions.find((x) => x.question.trim() === q);
    if (match && a && a !== "(skipped)") out[match.id] = a;
  }
  return out;
}

function ClarifyCard({
  message,
  questions,
  done,
  reply,
  onSubmit,
}: {
  message: string;
  questions: ClarifyQuestion[];
  done: boolean;
  reply?: string;
  onSubmit: (composed: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const prior = useMemo(
    () => (reply ? answersFromReply(reply, questions) : {}),
    [reply, questions]
  );
  const shown = (id: string) => (answers[id] ?? "").trim() || (prior[id] ?? "");
  const answered = questions.filter((q) => (answers[q.id] ?? "").trim().length > 0);

  /**
   * Suggestions toggle instead of replacing. "What do you track on each
   * booking?" has more than one true answer, and picking a second chip
   * used to silently throw the first away. Selections live in the same
   * answer string, so anything typed by hand is still just text.
   */
  const parts = (id: string) =>
    (answers[id] ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

  const toggle = (id: string, sug: string) =>
    setAnswers((prev) => {
      const cur = parts(id);
      const next = cur.includes(sug) ? cur.filter((x) => x !== sug) : [...cur, sug];
      return { ...prev, [id]: next.join(", ") };
    });

  function submit() {
    if (answered.length === 0) return;
    const composed = questions
      .map((q) => {
        const a = (answers[q.id] ?? "").trim();
        return a ? `${q.question}\n→ ${a}` : `${q.question}\n→ (skipped)`;
      })
      .join("\n\n");
    onSubmit(composed);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-violet-200 shadow-sm">
      <div className="flex items-center justify-between bg-violet-50 px-3 py-2">
        <span className="text-xs font-semibold text-violet-800">A few questions first</span>
        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-violet-700 uppercase">
          Discovery
        </span>
      </div>

      <div className="space-y-3 p-3">
        <p className="text-xs text-slate-600">{message}</p>

        {questions.map((q) => (
          <div key={q.id} className="space-y-1.5">
            <div className="text-xs font-medium text-slate-700">{q.question}</div>
            {q.why && <div className="text-[11px] text-slate-400">{q.why}</div>}
            {!done && (q.suggestions?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {q.suggestions!.map((sug) => {
                  const on = parts(q.id).includes(sug);
                  return (
                    <button
                      key={sug}
                      onClick={() => toggle(q.id, sug)}
                      aria-pressed={on}
                      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                        on
                          ? "border-violet-400 bg-violet-100 font-medium text-violet-800"
                          : "border-slate-200 text-slate-600 hover:border-violet-300 hover:bg-violet-50 hover:text-violet-700"
                      }`}
                    >
                      {on ? "✓ " : ""}
                      {sug}
                    </button>
                  );
                })}
              </div>
            )}
            {done ? (
              <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500">
                {shown(q.id) || "(skipped)"}
              </div>
            ) : (
              <textarea
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                rows={2}
                placeholder="Pick any above, and/or add your own"
                className="w-full resize-none rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
              />
            )}
          </div>
        ))}

        {!done && (
          <button
            onClick={submit}
            disabled={answered.length === 0}
            className="w-full rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-700 disabled:opacity-40"
          >
            Send answers ({answered.length}/{questions.length})
          </button>
        )}
      </div>
    </div>
  );
}

function BlueprintCard({
  message,
  blueprint,
  modules,
  currentColumns,
  storeFacts,
  done,
  onApprove,
  onAmend,
}: {
  message: string;
  blueprint: Blueprint;
  modules: ModuleRow[];
  /** Columns of the section in view, so a plan that adds some says so. */
  currentColumns?: Array<{ field: string; label: string }>;
  /** The connected store, so a duplicating section is flagged here. */
  storeFacts: StoreFacts | null;
  done: boolean;
  /** Receives the exact plans the owner ticked — nothing is regenerated. */
  onApprove: (plans: AssistantPlan[]) => void;
  onAmend: () => void;
}) {
  const [dropped, setDropped] = useState<Record<number, boolean>>({});
  // A blueprint lists every field, stat, button and rule. That is the
  // point — it IS what gets built — but a wall of it gets skimmed and
  // then nothing is really approved. Show the gist, keep the rest one
  // click away.
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const PREVIEW_LINES = 2;
  // A rule is two lines but one of them can be a 300-char sentence that
  // wraps to four rows — counting lines alone misses the worst wall of
  // text there is. Long lines get clamped to one row until expanded.
  const LONG_LINE = 90;
  const isOverwhelming = (lines: string[]) =>
    lines.length > PREVIEW_LINES || lines.some((l) => l.length > LONG_LINE);

  // Dropping an optional section takes with it anything that pointed at
  // it, so the owner can never approve a rule aimed at nothing.
  const droppedSlugs = new Set(
    blueprint.plans
      .map((p, i) => (dropped[i] ? p.newModule?.name : null))
      .filter((n): n is string => !!n)
  );
  const referencesDropped = (p: AssistantPlan) => {
    const refs = [
      p.targetModuleId,
      ...(p.automation?.definition.actions ?? []).map((a) =>
        a.type === "create_record"
          ? a.module_id
          : a.type === "set_fields" && !("self" in a.target)
            ? a.target.module_id
            : null
      ),
    ];
    return refs.some(
      (r) => typeof r === "string" && r.startsWith("#") && droppedSlugs.has(r.slice(1))
    );
  };

  const chosen = blueprint.plans.filter((p, i) => !dropped[i] && !referencesDropped(p));
  const hasOptional = blueprint.plans.some((p) => p.optional);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ring-1 ring-slate-900/5">
      <div className="flex items-center justify-between border-b border-slate-100 bg-gradient-to-r from-blue-50 to-violet-50 px-3.5 py-2.5">
        <span className="text-xs font-semibold text-slate-800">Proposed design</span>
        <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-blue-700 uppercase ring-1 ring-blue-200">
          Blueprint
        </span>
      </div>

      <div className="space-y-3.5 p-3.5">
        <p className="text-xs text-slate-500">{message}</p>
        <p className="rounded-lg border border-slate-100 bg-slate-50/70 px-3 py-2.5 text-xs leading-relaxed text-slate-700">
          {blueprint.summary}
        </p>

        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-semibold tracking-widest text-slate-400 uppercase">
              What gets built
            </span>
            {hasOptional && (
              <span className="text-[10px] text-slate-400">untick anything you don&rsquo;t need</span>
            )}
          </div>

          {blueprint.plans.map((plan, i) => {
            const summary = describePlan(plan, modules, currentColumns, storeFacts);
            const off = dropped[i] || referencesDropped(plan);
            const cascaded = !dropped[i] && off;
            return (
              <div
                key={i}
                className={`rounded-lg border px-3 py-2.5 transition-colors ${
                  off ? "border-slate-150 bg-slate-50 opacity-55" : "border-slate-200 bg-white"
                }`}
              >
                <div className="flex items-start gap-2">
                  {plan.optional && !done && !cascaded && (
                    <input
                      type="checkbox"
                      checked={!dropped[i]}
                      onChange={() => setDropped((prev) => ({ ...prev, [i]: !prev[i] }))}
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-blue-600"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-semibold text-slate-800">{summary.title}</span>
                      {plan.optional && (
                        <span className="rounded bg-amber-100 px-1.5 py-px text-[9px] font-semibold tracking-wide text-amber-800 uppercase">
                          Optional
                        </span>
                      )}
                      {cascaded && (
                        <span className="text-[10px] text-slate-400">needs a section you removed</span>
                      )}
                    </div>
                    {plan.optional && plan.optionalWhy && (
                      <div className="mt-0.5 text-[11px] leading-relaxed text-amber-700">
                        {plan.optionalWhy}
                      </div>
                    )}
                    {/* Above the field list, not below it: this changes
                        whether the owner wants the section at all. */}
                    {summary.warnings?.map((w, k) => (
                      <div
                        key={k}
                        className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-800"
                      >
                        {w}
                      </div>
                    ))}
                    {summary.lines.length > 0 && (
                      <>
                        <ul className="mt-1 space-y-0.5">
                          {(expanded[i] ? summary.lines : summary.lines.slice(0, PREVIEW_LINES)).map(
                            (line, j) => (
                              <li
                                key={j}
                                className={`text-[11px] leading-relaxed text-slate-500 ${
                                  expanded[i] ? "" : "truncate"
                                }`}
                              >
                                {line}
                              </li>
                            )
                          )}
                        </ul>
                        {isOverwhelming(summary.lines) && (
                          <button
                            onClick={() => setExpanded((p) => ({ ...p, [i]: !p[i] }))}
                            className="mt-1 text-[11px] font-medium text-blue-600 transition-colors hover:text-blue-700"
                          >
                            {expanded[i]
                              ? "Show less"
                              : summary.lines.length > PREVIEW_LINES
                                ? `Show all ${summary.lines.length} details`
                                : "Show the full detail"}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {blueprint.workflow.length > 0 && (
          <div className="space-y-1.5">
            <div className="text-[10px] font-semibold tracking-widest text-slate-400 uppercase">
              How it flows
            </div>
            <ol className="space-y-1.5 border-l border-slate-150 pl-3">
              {blueprint.workflow.map((w, i) => (
                <li key={i} className="relative text-[11px] leading-relaxed text-slate-600">
                  <span className="absolute -left-[17px] top-1 h-1.5 w-1.5 rounded-full bg-slate-300" />
                  {w.step}
                  {w.who && <span className="text-slate-400"> — {w.who}</span>}
                </li>
              ))}
            </ol>
          </div>
        )}

        {(blueprint.unmet?.length ?? 0) > 0 && (
          <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2">
            <div className="text-[10px] font-semibold tracking-wide text-amber-900 uppercase">
              Not covered by this
            </div>
            <ul className="mt-1 space-y-0.5">
              {blueprint.unmet!.map((l, i) => (
                <li key={i} className="text-[11px] leading-relaxed text-amber-800">
                  {l}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Shown on every design, from the engine's own registry. The
            assistant is told to flag anything it cannot do, but a prompt
            instruction is not a guarantee — it stayed silent about extra
            staff logins on a design built for a team. The owner sees the
            limits whether or not the model mentions them. */}
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <div className="text-[10px] font-semibold tracking-wide text-slate-500 uppercase">
            What this platform can&rsquo;t do
          </div>
          <ul className="mt-1 space-y-0.5">
            {NOT_SUPPORTED.map((n) => (
              <li key={n.id} className="text-[11px] leading-relaxed text-slate-500">
                {n.label}
              </li>
            ))}
          </ul>
        </div>

        {!done && (
          <div className="flex gap-2 pt-0.5">
            <button
              onClick={() => onApprove(chosen)}
              disabled={chosen.length === 0}
              className="flex-1 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 disabled:opacity-40"
            >
              Build {chosen.length === 1 ? "this" : `these ${chosen.length}`}
            </button>
            <button
              onClick={onAmend}
              className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50"
            >
              Change
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ChatPanel({
  projectId,
  width,
  dragging,
  onResizeStart,
  onResizeReset,
  open,
  onClose,
  modules,
  selectedModuleId,
  currentSchema,
  records,
  messages,
  busy,
  threads,
  conversationId,
  onNewThread,
  onPickThread,
  onDeleteThread,
  onStop,
  canStop,
  onSend,
  onApply,
  onBuild,
  onDiscard,
}: {
  /** Panel width above lg; below it the panel is a full-width drawer. */
  width: number;
  dragging: boolean;
  onResizeStart: (e: React.PointerEvent) => void;
  onResizeReset: () => void;
  /** Drawer state below lg; the panel is always visible above it. */
  open: boolean;
  onClose: () => void;
  modules: ModuleRow[];
  selectedModuleId: string | null;
  currentSchema: UiSchema | null;
  records: RecordRow[];
  messages: ChatMessage[];
  /** Past threads for this project, newest first. */
  threads: Array<{ id: string; title: string | null; updated_at: string }>;
  conversationId: string | null;
  onNewThread: () => void;
  onPickThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  onStop: () => void;
  /** Only a model call can be stopped. Applying a build must not be
   *  interrupted halfway, and there is nothing to abort during it. */
  canStop: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onApply: (plan: AssistantPlan, planId: string) => void;
  /** Applies an approved blueprint's plans directly, with no model round trip. */
  onBuild: (plans: AssistantPlan[]) => void;
  onDiscard: (planId: string) => void;
  /** Whose store to warn about, if this project has one connected. */
  projectId: string;
}) {
  const [input, setInput] = useState("");
  // The connected store, so an approval card can say when a section
  // would sit beside data the project already holds. Loaded once per
  // panel, and null for a project without a store.
  // ponytail: one extra round of head-counts on open; fold into a
  // shared fetch if the app screen ever gets a third reader of them.
  const [storeFacts, setStoreFacts] = useState<StoreFacts | null>(null);
  // Two switches, not one choice. An account can have Warmluke's
  // assistant, their own AI, both, or neither — the routes enforce it
  // either way, and this is so the panel says what is going on rather
  // than offering a box that answers with an error.
  const [features, setFeatures] = useState<{ chat: boolean; mcp: boolean }>({
    chat: true,
    mcp: true,
  });
  // What their AI has asked for and nobody has looked at yet. Without
  // this the request lands in the database and dies there: Claude says
  // "I've asked Warmluke to build it" and the merchant never sees it.
  const [requests, setRequests] = useState<
    Array<{
      id: string;
      request: string;
      client_id: string | null;
      created_at: string;
      summary: string | null;
      plans: AssistantPlan[] | null;
      unmet: string[] | null;
      status: string;
      built_at: string | null;
    }>
  >([]);
  const loadRequests = useCallback(async () => {
    const { data } = await supabase
      .from("build_requests")
      .select("id, request, client_id, created_at, summary, plans, unmet, status, built_at")
      .eq("project_id", projectId)
      // Built ones stay. A build that came in through their own AI
      // wrote nothing to this conversation, so once the row stopped
      // being pending the only sign it ever happened was a section
      // appearing in the sidebar — and a refresh took even the
      // "it's live now" message away.
      .in("status", ["pending", "built"])
      .gt("created_at", new Date(Date.now() - 7 * 864e5).toISOString())
      .order("created_at", { ascending: true })
      .limit(10);
    setRequests(data ?? []);
  }, [projectId]);
  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  // A request made in Claude a moment ago should appear here without
  // the merchant being told to refresh a page nobody told them was
  // stale.
  useEffect(
    () =>
      watchRows(`requests:${projectId}`, [
        { table: "build_requests", filter: `project_id=eq.${projectId}`, onChange: loadRequests },
      ]),
    [projectId, loadRequests]
  );

  /** Hands one to the builder, as though the owner had typed it. */
  async function openRequest(r: { id: string; request: string }) {
    await supabase
      .from("build_requests")
      .update({ status: "opened", resolved_at: new Date().toISOString() })
      .eq("id", r.id);
    setRequests((prev) => prev.filter((x) => x.id !== r.id));
    onSend(r.request);
  }

  /**
   * Builds the design their AI already made. No model call, so this
   * works on an account whose Warmluke assistant is switched off —
   * which is the whole point of the two switches being separate.
   */
  async function buildRequest(r: { id: string; plans: AssistantPlan[] | null }) {
    if (!r.plans?.length) return;
    await onBuild(r.plans);
    await supabase
      .from("build_requests")
      .update({
        status: "built",
        built_at: new Date().toISOString(),
        resolved_at: new Date().toISOString(),
      })
      .eq("id", r.id);
    // Reloaded rather than removed: it becomes the record that this
    // was built, which is the whole point of keeping it.
    loadRequests();
  }

  async function dismissRequest(id: string) {
    setRequests((prev) => prev.filter((x) => x.id !== id));
    await supabase
      .from("build_requests")
      .update({ status: "dismissed", resolved_at: new Date().toISOString() })
      .eq("id", id);
  }
  useEffect(() => {
    supabase.rpc("abo_my_settings").then(({ data }) => {
      const row = data?.[0];
      setFeatures({ chat: row?.chat_enabled ?? true, mcp: row?.mcp_enabled ?? true });
    });
  }, []);
  useEffect(() => {
    let gone = false;
    (async () => {
      const { data: row } = await supabase
        .from("stores")
        .select("id, shop_domain, currency")
        .eq("project_id", projectId)
        .eq("status", "connected")
        .maybeSingle();
      if (!row || gone) return;
      const over = await storeOverview(supabase, row.id as string);
      if (gone) return;
      setStoreFacts({
        shop_domain: row.shop_domain as string,
        currency: row.currency as string,
        counts: over?.counts ?? {},
      });
    })();
    return () => {
      gone = true;
    };
  }, [projectId]);
  const [applyingPlanId, setApplyingPlanId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Record<string, string>>({});
  // Discovery cards collapse once answered/approved so the thread reads
  // as history rather than a pile of still-actionable prompts.
  const [resolvedCards, setResolvedCards] = useState<Record<string, boolean>>({});
  const [threadsOpen, setThreadsOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Keep the latest message in view. Request cards sit at the end of
  // the same list, so they count as newest too — without them here, a
  // build that just landed opens below the fold.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, requests.length, busy]);

  function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setInput("");
    onSend(content);
  }

  function resolveCard(id: string, text: string) {
    setResolvedCards((prev) => ({ ...prev, [id]: true }));
    onSend(text);
  }

  async function apply(plan: AssistantPlan, planId: string) {
    setApplyingPlanId(planId);
    try {
      await onApply(plan, planId);
    } finally {
      setApplyingPlanId(null);
    }
  }

  /** The endpoint their own AI connects to. */
  const mcpUrl = typeof window === "undefined" ? "" : `${window.location.origin}/api/mcp`;

  // Assistants that are connected right now. Connecting was a
  // one-way door: the token an AI holds lasts ninety days, so a
  // laptop left behind meant ninety days of access with nothing on
  // any screen to stop it.
  const [clients, setClients] = useState<
    Array<{
      client_id: string;
      name: string;
      granted_at: string;
      sessions: number;
      last_call: string | null;
      calls_24h: number;
    }>
  >([]);
  const [revoking, setRevoking] = useState<string | null>(null);
  /** Built requests the merchant has opened back up. */
  const [openBuilt, setOpenBuilt] = useState<Record<string, boolean>>({});
  const loadClients = useCallback(async () => {
    const { data } = await supabase.rpc("abo_oauth_clients");
    setClients(data ?? []);
  }, []);
  useEffect(() => {
    if (features.mcp) loadClients();
  }, [features.mcp, loadClients]);

  async function revoke(client: { client_id: string; name: string }) {
    // Worth a pause: the assistant stops working mid-sentence, and
    // reconnecting means going through consent again.
    if (!confirm(`Disconnect ${client.name}? It will lose access immediately.`)) return;
    setRevoking(client.client_id);
    await supabase.rpc("abo_oauth_revoke", { p_client: client.client_id });
    setRevoking(null);
    loadClients();
  }

  return (
    <aside
      style={{ ["--chat-w" as string]: `${width}px` }}
      className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] shrink-0 flex-col border-l border-slate-200 bg-white lg:static lg:w-[var(--chat-w)] lg:max-w-none lg:translate-x-0 ${
        dragging ? "" : "transition-transform duration-200"
      } ${open ? "translate-x-0" : "translate-x-full"}`}
    >
      <div
        onPointerDown={onResizeStart}
        onDoubleClick={onResizeReset}
        title="Drag to resize · double-click to reset"
        className={resizeHandleClass("right", dragging)}
      />
      <div className="border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-blue-500 text-xs text-white">
            ✦
          </span>
          <div>
            <div className="font-display text-sm font-semibold tracking-tight">AI Assistant</div>
            <div className="text-[11px] text-slate-400">
              Build anything by describing it — preview before it applies
            </div>
          </div>
          <div className="relative ml-auto flex items-center gap-1">
            <button
              onClick={onNewThread}
              title="Start a fresh conversation"
              className="rounded-lg px-2 py-1 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              + New
            </button>
            {threads.length > 0 && (
              <button
                onClick={() => setThreadsOpen((o) => !o)}
                title="Past conversations"
                aria-label="Past conversations"
                className="rounded-lg px-2 py-1 text-[11px] text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                🕘 {threads.length}
              </button>
            )}
            {threadsOpen && (
              <div className="absolute top-full right-0 z-50 mt-1 max-h-72 w-64 overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg thin-scroll">
                {threads.length === 0 && (
                  <div className="px-3 py-2 text-[11px] text-slate-400">No past conversations.</div>
                )}
                {threads.map((t) => (
                  <div
                    key={t.id}
                    className={`flex items-center gap-1 px-1.5 transition-colors hover:bg-slate-50 ${
                      t.id === conversationId ? "bg-blue-50" : ""
                    }`}
                  >
                    <button
                      onClick={() => {
                        onPickThread(t.id);
                        setThreadsOpen(false);
                      }}
                      className={`min-w-0 flex-1 px-1.5 py-2 text-left text-[11px] ${
                        t.id === conversationId ? "text-blue-800" : "text-slate-600"
                      }`}
                    >
                      <div className="truncate font-medium">{t.title ?? "Untitled"}</div>
                      <div className="text-[10px] text-slate-400">
                        {new Date(t.updated_at).toLocaleString()}
                      </div>
                    </button>
                    {/* Threads accumulate — six of them called "hello"
                        before there was any way to be rid of one. */}
                    <button
                      onClick={() => onDeleteThread(t.id)}
                      aria-label={`Delete ${t.title ?? "this conversation"}`}
                      className="shrink-0 rounded px-1.5 py-1 text-[11px] text-slate-300 hover:bg-rose-50 hover:text-rose-500"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close assistant"
            className="rounded-lg px-2 py-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 lg:hidden"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4 thin-scroll"
      >
        {/* Four invented problems used to sit here — a double-booked
            slot, parts coming off a job. They were written to show what
            the engine can do, and to a shop selling phone cases they
            read as a product for somebody else. A prompt for their own
            words is the honest opening. */}
        {messages.length === 0 && (
          <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
            👋 Tell me the problem you&rsquo;re trying to solve — in your own words.
            I&rsquo;ll ask how you work, show you a plan, and only build once you
            approve it.
          </div>
        )}

        {messages.map((m, i) => {
          // A card with anything after it was already answered. Derived
          // from position, not remembered: resolvedCards is session
          // state, so a reloaded thread came back with every old
          // clarify and blueprint looking live again.
          const answered = i < messages.length - 1;
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-3 py-2 text-sm text-white">
                  {m.text}
                </div>
              </div>
            );
          }

          if (m.role === "system") {
            return (
              <div
                key={m.id}
                className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
              >
                <div>{m.text}</div>
                {m.errors && m.errors.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {m.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          }

          if (m.questions) {
            return (
              <ClarifyCard
                key={m.id}
                message={m.text ?? ""}
                questions={m.questions}
                done={!!resolvedCards[m.id] || answered || busy}
                reply={messages[i + 1]?.role === "user" ? messages[i + 1].text : undefined}
                onSubmit={(composed) => resolveCard(m.id, composed)}
              />
            );
          }

          if (m.blueprint) {
            return (
              <BlueprintCard
                key={m.id}
                message={m.text ?? ""}
                blueprint={m.blueprint}
                modules={modules}
                currentColumns={currentSchema?.columns}
                storeFacts={storeFacts}
                done={!!resolvedCards[m.id] || answered}
                onApprove={(chosen) => {
                  setResolvedCards((prev) => ({ ...prev, [m.id]: true }));
                  onBuild(chosen);
                }}
                onAmend={() => {
                  setInput("Change this in the blueprint: ");
                  inputRef.current?.focus();
                }}
              />
            );
          }

          // confirmation bubble after apply/discard
          if (!m.plan) {
            return (
              <div key={m.id} className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                {m.text}
              </div>
            );
          }

          const plan = m.plan;
          const isPending = applyingPlanId === m.id;
          const targetModule = modules.find((mod) => mod.id === plan.targetModuleId);

          // The world can move on while a proposal sits in the thread: the
          // section may already have been built by a later message. Applying
          // it now would just fail validation, so retire the card instead.
          const stale =
            (plan.changeType === "NEW_MODULE" &&
              !!plan.newModule &&
              modules.some((mod) => mod.name === plan.newModule!.name)) ||
            (plan.changeType !== "NEW_MODULE" && !!plan.targetModuleId && !targetModule);

          if (stale) {
            return (
              <div
                key={m.id}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500"
              >
                <span className="font-medium text-slate-600">Out of date</span> — “
                {plan.newModule?.nav_label ?? plan.explanation}” already changed since this was
                proposed, so there is nothing left to apply.
              </div>
            );
          }

          return (
            <div key={m.id} className="overflow-hidden rounded-xl border border-slate-200 shadow-sm">
              <div className="flex items-center justify-between bg-slate-50 px-3 py-2">
                <span className="text-xs font-semibold text-slate-700">Proposed Change</span>
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-violet-700 uppercase">
                  {plan.changeType.replace("_", " ")}
                </span>
              </div>

              <div className="space-y-3 p-3">
                {m.text ? (
                  <p className="text-xs text-slate-600">{m.text}</p>
                ) : (
                  <>
                    {/* Generated from the plan, not the sentence the
                        assistant wrote beside it. A plan that inserts a
                        row was described as "Changed the customer name
                        from Meena to Raman"; applying it would have left
                        the original row alone and added a duplicate. */}
                    {(() => {
                      const summary = describePlan(plan, modules, currentSchema?.columns);
                      return (
                        <>
                          <p className="text-xs font-medium text-slate-700">{summary.title}</p>
                          {summary.lines.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                              {summary.lines.map((line, j) => (
                                <li key={j} className="text-[11px] leading-relaxed text-slate-500">
                                  {line}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      );
                    })()}
                    <p className="mt-1 text-[11px] text-slate-400">{plan.explanation}</p>
                  </>
                )}

                {(plan.changeType === "UI_CHANGE" || plan.changeType === "FIELD_ADD") && (
                  <GenericRenderer schema={plan.newSchema} records={records} preview />
                )}

                {plan.changeType === "NEW_MODULE" && plan.newModule && (
                  <>
                    <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      <span className="text-base">{ICON_GLYPHS[plan.newModule.icon] ?? "📋"}</span>
                      New module: <b>{plan.newModule.nav_label}</b>
                      <span className="text-slate-400">({plan.newModule.name})</span>
                    </div>
                    <GenericRenderer
                      schema={plan.newSchema}
                      records={(plan.newRecords ?? []).map((data, i) => ({
                        id: `preview-${i}`,
                        project_id: "preview",
                        module_id: "preview",
                        data,
                        created_at: "",
                        updated_at: "",
                      }))}
                      preview
                    />
                  </>
                )}

                {plan.changeType === "MODULE_UPDATE" && plan.moduleUpdate && (
                  <div className="space-y-1.5 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    {plan.moduleUpdate.nav_label && (
                      <div>
                        ✏️ Rename: <b>{targetModule?.nav_label}</b> → <b>{plan.moduleUpdate.nav_label}</b>
                      </div>
                    )}
                    {plan.moduleUpdate.icon && (
                      <div>
                        Icon: {ICON_GLYPHS[targetModule?.icon ?? ""] ?? "📋"} →{" "}
                        {ICON_GLYPHS[plan.moduleUpdate.icon] ?? "📋"}
                      </div>
                    )}
                    {plan.moduleUpdate.sort_order !== undefined && (
                      <div>↕ Sidebar position: sort_order {plan.moduleUpdate.sort_order}</div>
                    )}
                  </div>
                )}

                {plan.changeType === "MODULE_DELETE" && targetModule && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                    <div className="font-semibold">
                      ⚠️ Delete “{targetModule.nav_label}” and all its records?
                    </div>
                    <div className="mt-1">
                      Type <b>“{targetModule.nav_label}”</b> below to confirm.
                    </div>
                  </div>
                )}

                {plan.changeType === "FEATURE_UPDATE" && (
                  <>
                    <ul className="space-y-1 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                      {describeFeatures(plan.features!).map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                    <GenericRenderer
                      schema={{
                        columns: currentSchema?.columns ?? [],
                        features: plan.features ?? undefined,
                      }}
                      records={records}
                      preview
                    />
                  </>
                )}

                {plan.changeType === "AUTOMATION_ADD" && plan.automation && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2.5">
                    <div className="text-[11px] font-semibold text-emerald-900">
                      ⚡ {plan.automation.name}
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {describeAutomation(plan.automation, modules).map((line, i) => (
                        <li key={i} className="text-[11px] leading-relaxed text-emerald-800">
                          {line}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-1.5 text-[10px] text-emerald-700/70">
                      Runs on every change to this section, from anywhere.
                    </div>
                  </div>
                )}

                {plan.changeType === "AUTOMATION_REMOVE" && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
                    Turns off the rule “{plan.automationRemoveName}”. Its history stays visible.
                  </div>
                )}

                {plan.changeType === "RECORD_SEED" && (
                  <div className="overflow-x-auto rounded-lg border border-slate-200 thin-scroll">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
                          {Object.keys(plan.newRecords?.[0] ?? {}).map((k) => (
                            <th key={k} className="px-2.5 py-1.5 font-semibold">
                              {k}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(plan.newRecords ?? []).map((row, i) => (
                          <tr key={i} className="border-b border-slate-100 last:border-0">
                            {Object.keys(plan.newRecords?.[0] ?? {}).map((k) => (
                              <td key={k} className="px-2.5 py-1.5">
                                {String(row[k] ?? "—")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Actions */}
                {plan.changeType === "MODULE_DELETE" && targetModule ? (
                  <div className="space-y-2">
                    <input
                      value={deleteConfirm[m.id] ?? ""}
                      onChange={(e) =>
                        setDeleteConfirm((prev) => ({ ...prev, [m.id]: e.target.value }))
                      }
                      placeholder={`Type "${targetModule.nav_label}" to enable deletion`}
                      className="w-full rounded-lg border border-rose-200 px-3 py-1.5 text-xs outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => apply(plan, m.id)}
                        disabled={
                          isPending ||
                          (deleteConfirm[m.id] ?? "").trim().toLowerCase() !==
                            targetModule.nav_label.toLowerCase()
                        }
                        className="flex-1 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-40"
                      >
                        {isPending ? "Deleting…" : "Delete module"}
                      </button>
                      <button
                        onClick={() => onDiscard(m.id)}
                        disabled={isPending}
                        className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={() => apply(plan, m.id)}
                      disabled={isPending}
                      className="flex-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                    >
                      {isPending ? "Applying…" : "Apply Change"}
                    </button>
                    <button
                      onClick={() => onDiscard(m.id)}
                      disabled={isPending}
                      className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
                    >
                      Discard
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* What their own AI asked for, read in the conversation it
            belongs to. As a banner above the header it pushed the
            whole panel down and a long design covered the chat
            entirely — the one place it must not be is on top of the
            thing it is asking about. */}
        {requests.map((r) => {
          const done = r.status === "built";
          // A finished thing does not belong in the live area at full
          // height. It sat there for a week, taller than the chat,
          // describing something the merchant dealt with yesterday —
          // and naming a section they may since have deleted.
          if (done && !openBuilt[r.id]) {
            return (
              <div
                key={r.id}
                className="flex items-center gap-2 rounded-lg border border-slate-150 bg-slate-50 px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-[10px] text-slate-400">
                  Built by your AI
                  {r.built_at ? ` · ${new Date(r.built_at).toLocaleDateString()}` : ""} ·{" "}
                  {r.request}
                </span>
                <button
                  onClick={() => setOpenBuilt((p) => ({ ...p, [r.id]: true }))}
                  className="shrink-0 text-[10px] text-slate-500 hover:underline"
                >
                  Show
                </button>
                <button
                  onClick={() => dismissRequest(r.id)}
                  aria-label="Hide this"
                  className="shrink-0 text-[11px] text-slate-400 hover:text-slate-600"
                >
                  ✕
                </button>
              </div>
            );
          }
          return (
            <div
              key={r.id}
              className={`rounded-xl border px-3 py-2.5 ${
                done ? "border-slate-200 bg-slate-50" : "border-amber-200 bg-amber-50"
              }`}
            >
              <div
                className={`text-[10px] font-semibold tracking-widest uppercase ${
                  done ? "text-slate-400" : "text-amber-700"
                }`}
              >
                {done
                  ? `Built by your AI${r.built_at ? ` · ${new Date(r.built_at).toLocaleString()}` : ""}`
                  : "Asked for by your AI"}
              </div>
              <div className="mt-2">
              <p className={`text-[11px] leading-relaxed font-medium ${done ? "text-slate-700" : "text-amber-900"}`}>{r.request}</p>
              {/* What changes their mind stays out in the open: the
                  warning, and what they asked for that this does not
                  do. The field-by-field detail folds away — it is how
                  the thing is built, not whether they want it.

                  Rendered from the plans, the same source the
                  sentences their AI read out were generated from, so
                  the two cannot drift. */}
              {r.plans?.length ? (
                <div className="mt-1.5 space-y-1.5">
                  {r.plans.map((plan, i) => {
                    const d = describePlan(plan, modules, undefined, storeFacts);
                    return (
                      <div key={i}>
                        <div
                          className={`text-[11px] font-semibold ${done ? "text-slate-700" : "text-amber-900"}`}
                        >
                          {d.title}
                        </div>
                        {d.warnings?.map((w, k) => (
                          <div
                            key={k}
                            className="mt-1 rounded border border-amber-300 bg-amber-100/70 px-2 py-1.5 text-[11px] leading-relaxed text-amber-900"
                          >
                            {w}
                          </div>
                        ))}
                        {d.lines.length > 0 && (
                          <details className="mt-1">
                            <summary
                              className={`cursor-pointer list-none text-[10px] hover:underline ${
                                done ? "text-slate-500" : "text-amber-700"
                              }`}
                            >
                              {done ? "What was built" : "Show details"}
                            </summary>
                            <ul
                              className={`mt-1 space-y-0.5 text-[11px] leading-relaxed ${
                                done ? "text-slate-600" : "text-amber-900/90"
                              }`}
                            >
                              {d.lines.map((l, k) => (
                                <li key={k}>· {l}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </div>
                    );
                  })}
                  {r.unmet?.length ? (
                    <div
                      className={`text-[11px] leading-relaxed ${done ? "text-slate-600" : "text-amber-900"}`}
                    >
                      <span className="font-semibold">Not covered:</span>{" "}
                      {r.unmet.join(" · ")}
                    </div>
                  ) : null}
                </div>
              ) : (
                // A request made before designs were attached, or one
                // whose design could not be rebuilt. The text it was
                // stored with is all there is.
                r.summary && (
                  <div className="mt-1.5 rounded-lg bg-white/70 px-2.5 py-2 text-[11px] leading-relaxed whitespace-pre-wrap text-amber-900">
                    {r.summary}
                  </div>
                )
              )}
              {!done && (
              <div className="mt-1.5 flex items-center gap-1.5">
                {r.plans?.length ? (
                  <button
                    onClick={() => buildRequest(r)}
                    disabled={busy}
                    className="rounded-lg bg-amber-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-amber-700 disabled:opacity-40"
                  >
                    Build it
                  </button>
                ) : null}
                {features.chat && (
                  <button
                    onClick={() => openRequest(r)}
                    className="rounded-lg border border-amber-300 px-2 py-1 text-[10px] font-medium text-amber-800 hover:bg-amber-100"
                  >
                    {r.plans?.length ? "Change it first" : "Design it"}
                  </button>
                )}
                <button
                  onClick={() => dismissRequest(r.id)}
                  className="ml-auto text-[10px] text-amber-700 hover:underline"
                >
                  Dismiss
                </button>
              </div>
              )}
            </div>
          </div>
          );
        })}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-blue-500" />
            Working on it…
          </div>
        )}
      </div>

      {/* Their own AI. Shown alongside the chat rather than instead of
          it: both can be on, and a merchant who has connected Claude
          still uses this panel to read and approve what it asked for. */}
      {features.mcp && (
        <details className="border-t border-slate-100 px-3 py-2 text-[11px]" open={!features.chat}>
          <summary className="cursor-pointer list-none text-slate-500 hover:text-slate-700">
            ✦ Use your own Claude or ChatGPT
          </summary>
          <p className="mt-2 leading-relaxed text-slate-500">
            Add Warmluke as a connector with this address. It can read your store, and
            anything it wants to build comes back here for you to approve.
          </p>
          <code className="mt-2 block rounded-lg bg-slate-50 px-2.5 py-1.5 text-[10px] break-all text-slate-600">
            {mcpUrl}
          </code>

          {clients.length > 0 && (
            <div className="mt-3 space-y-1.5">
              <div className="text-[10px] font-semibold tracking-widest text-slate-400 uppercase">
                Connected
              </div>
              {clients.map((c) => (
                <div
                  key={c.client_id}
                  className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium text-slate-700">{c.name}</div>
                    <div className="text-[10px] text-slate-400">
                      {c.last_call
                        ? `Last used ${new Date(c.last_call).toLocaleString()} · ${c.calls_24h} today`
                        : "Connected, not used yet"}
                    </div>
                  </div>
                  <button
                    onClick={() => revoke(c)}
                    disabled={revoking === c.client_id}
                    className="shrink-0 text-[10px] font-medium text-rose-600 hover:underline disabled:opacity-40"
                  >
                    {revoking === c.client_id ? "…" : "Disconnect"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </details>
      )}

      {/* Input */}
      {!features.chat ? (
        <div className="border-t border-slate-100 p-3 text-[11px] leading-relaxed text-slate-500">
          Warmluke&rsquo;s own assistant is off for this account.{" "}
          {features.mcp
            ? "Your own AI can still design changes, and you approve them above."
            : "Ask us to turn an assistant on for you."}
        </div>
      ) : (
      <div className="border-t border-slate-100 p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Describe a change — or a whole new section…"
            className="max-h-32 flex-1 resize-none rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
          />
          <button
            onClick={() => (canStop ? onStop() : send())}
            disabled={busy && !canStop ? true : !canStop && !input.trim()}
            className={`rounded-xl px-3 py-2 text-sm font-medium text-white transition-colors disabled:opacity-40 ${
              canStop ? "bg-slate-700 hover:bg-slate-800" : "bg-blue-600 hover:bg-blue-700"
            }`}
          >
            {canStop ? "Stop" : busy ? "Building…" : "Send"}
          </button>
        </div>
        <div className="mt-1.5 text-[10px] text-slate-400">
          Asked, previewed, versioned, reversible — nothing applies without your approval.
        </div>
      </div>
      )}
    </aside>
  );
}
