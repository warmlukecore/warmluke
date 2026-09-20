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
import { engineError, fixPrompt, type AppError, type FixAction } from "@/lib/errors";
import ErrorNote from "@/components/ErrorNote";
import type { BuildOutcome } from "@/components/AppShell";
import { storeOverview } from "@/lib/store-read";
import { supabase } from "@/lib/supabase-client";
import { showWaiting } from "@/lib/favicon";
import { NOT_SUPPORTED } from "@/lib/capabilities";
import { resizeHandleClass } from "@/lib/useResizable";
import type {
  AssistantPlan,
  Blueprint,
  ClarifyQuestion,
  ModuleRow,
  RecordRow,
  TurnEvent,
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
  /**
   * An error with its ways out — see lib/errors. A system line that
   * has one renders it instead of `text` + `errors`, which is what
   * every failure used to be: a sentence and a list, and no button.
   */
  error?: AppError;
  /**
   * Asked through the merchant's own Claude rather than typed here.
   *
   * Same bubble, one label — otherwise the thread looks like they
   * wrote it in this box and forgot.
   */
  viaClient?: boolean;
  /**
   * What this build changed that can be put back, and the id of the
   * stored message holding it.
   *
   * Carried on the message rather than looked up on demand: the point
   * of putting something back is to restore what it was before THIS
   * build, and the section may have moved on twice since.
   */
  undo?: { messageId: string; what: string[] };
}

let msgSeq = 0;
export const nextChatId = () => `m${++msgSeq}`;

/**
 * A step of the turn, in words. The facts in it — which store, what
 * was read, which attempt, how many problems — are the server's; only
 * the phrasing is this panel's.
 */
function stepWords(step: TurnEvent): string {
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
  switch (step.step) {
    case "accepted":
      return "Luke has it";
    case "store":
      if (!step.shop) return "No store connected — working from the app alone";
      return step.read ? `Read ${step.shop}: ${step.read}` : `Read ${step.shop}`;
    case "context":
      return `Read ${n(step.sections, "section")} and ${n(step.rules, "rule")}`;
    case "model":
      return step.attempt === 1 ? "Thinking it through…" : `Trying again (${step.attempt} of ${step.of})…`;
    case "checked":
      return step.problems === 0 ? "Checked the reply" : `Found ${n(step.problems, "problem")} — sending it back`;
    case "gaps":
      return "Checking what the design misses…";
  }
}

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
  for (const s of f.stats ?? [])
    out.push(`📊 Stat: ${s.label} (${s.op}${s.field ? ` of ${s.field}` : ""}${s.by ? ` by ${s.by}` : ""})`);
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
  steps = [],
  onSend,
  onApply,
  onBuild,
  onDiscard,
  onUndo,
  onFix,
  autoBuild,
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
  /** What the running turn has done so far, oldest first. Empty until
   *  the server has taken the turn, and while a build is applied. */
  steps?: TurnEvent[];
  onSend: (text: string) => Promise<void> | void;
  onApply: (plan: AssistantPlan, planId: string) => void;
  /** Applies an approved blueprint's plans directly, with no model round trip. */
  onBuild: (
    plans: AssistantPlan[],
    requestId?: string,
    requestText?: string
  ) => Promise<BuildOutcome>;
  onDiscard: (planId: string) => void;
  /** Puts one build's changes back, by the id of the message offering
   *  it. Lives in the shell because the screen has to reload after. */
  /** Absent for a member: the server refuses them anyway, and a button
   *  that always says no is worse than none. */
  onUndo?: (messageId: string) => Promise<{ message: string } | null>;
  /** Runs a way out of an error — Luke, a retry. Lives in the shell. */
  onFix: (action: FixAction) => void | Promise<void>;
  /** Whether this project builds on its own, so a card that is asking
   *  anyway can say why rather than look broken. */
  autoBuild: boolean;
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
  /** Included designs from our own model: the finite ceiling is kept
   *  even while an admin has explicitly lifted it. */
  const [turns, setTurns] = useState<{
    free: number;
    used: number;
    unlimited: boolean;
  } | null>(null);
  const [wantsPlan, setWantsPlan] = useState(false);
  /** Whether the connect-your-own-AI block is open, so the button
   *  offered when the included designs run out can open it. */
  const [ownAiOpen, setOwnAiOpen] = useState(false);
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
      outcome: { applied?: unknown[]; errors?: string[] } | null;
    }>
  >([]);

  /**
   * Why a design is still asking although the setting is on.
   *
   * With the setting on there is only one answer left: it was tried
   * and it did not go in. Everything else the assistant may design is
   * built without asking now, so a card that is here anyway is a card
   * that failed — and saying nothing made the setting look broken.
   */
  const whyItIsAsking = (r: {
    outcome: { applied?: unknown[]; errors?: string[] } | null;
  }): string | null => {
    const errors = r.outcome?.errors ?? [];
    if (errors.length === 0) return null;
    return `it was tried on its own and did not go in — ${errors.slice(0, 2).join("; ")}`;
  };

  const loadRequests = useCallback(async () => {
    const { data } = await supabase
      .from("build_requests")
      .select("id, request, client_id, created_at, summary, plans, unmet, status, built_at, outcome")
      .eq("project_id", projectId)
      // Built ones stay. A build that came in through their own AI
      // wrote nothing to this conversation, so once the row stopped
      // being pending the only sign it ever happened was a section
      // appearing in the sidebar — and a refresh took even the
      // "it's live now" message away.
      // partly_built joins them. It is the one state nobody may be
      // left unaware of — a section exists with half of what was asked
      // for — and it was the only state with nowhere at all to appear.
      // Two questions, not one list.
      //
      // This was a single query: every status, seven days, oldest
      // first, ten rows. Ten old receipts could push a request that
      // wants an answer out of the bell entirely, and anything
      // unanswered for more than a week vanished — while the connected
      // assistant went on truthfully saying it was waiting. Work that
      // wants a person is never aged out and never crowded out;
      // finished work is the part that is bounded.
      .in("status", ["pending", "partly_built"])
      .order("created_at", { ascending: true });
    const active = data ?? [];

    const { data: doneRows } = await supabase
      .from("build_requests")
      .select("id, request, client_id, created_at, summary, plans, unmet, status, built_at, outcome")
      .eq("project_id", projectId)
      .eq("status", "built")
      .gt("created_at", new Date(Date.now() - 7 * 864e5).toISOString())
      .order("created_at", { ascending: false })
      .limit(10);

    // Oldest first inside each half: the receipts read as history above
    // the thing still being asked.
    const rows = [...[...(doneRows ?? [])].reverse(), ...active];
    setRequests(rows);

    // Anything that arrived while they were watching announces
    // itself. A bell is a container, and nobody taps a container to
    // find out whether something happened — the count only tells you
    // afterwards, if you look.
    const pending = rows.filter((r) => r.status === "pending").map((r) => r.id);
    if (seen.current === null) {
      // First load. What is already waiting is not news; that is
      // exactly what the bell is for.
      seen.current = new Set(pending);
      return;
    }
    const arrived = pending.filter((id) => !seen.current!.has(id));
    seen.current = new Set(pending);
    if (arrived.length > 0) setToasts((prev) => [...new Set([...prev, ...arrived])].slice(-3));
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
    // The turn runs first. This used to mark the request opened and
    // drop it from the queue before the replacement design existed —
    // and the turn can fail on the network, on a validation loop, on a
    // used-up allowance. Once opened, approve_change refuses the
    // original and the panel stops loading it, so there was nothing
    // left to go back to.
    setOpening(r.id);
    try {
      await onSend(r.request);
    } finally {
      setOpening(null);
    }

    const { error } = await supabase
      .from("build_requests")
      .update({ status: "opened", resolved_at: new Date().toISOString() })
      .eq("id", r.id);
    // It stays in the queue if that did not save. A card that is still
    // there is a nuisance; one that is gone with nothing to replace it
    // is a design the merchant cannot get back.
    if (error) {
      console.error("could not mark the request opened:", error.message);
      loadRequests();
      return;
    }
    setRequests((prev) => prev.filter((x) => x.id !== r.id));
  }

  /**
   * Builds the design their AI already made. No model call, so this
   * works on an account whose Warmluke assistant is switched off —
   * which is the whole point of the two switches being separate.
   */
  /** Which build is being put back, so its own button says so. */
  const [undoing, setUndoing] = useState<string | null>(null);

  async function putItBack(messageId: string) {
    if (!onUndo) return;
    setUndoing(messageId);
    try {
      await onUndo(messageId);
    } finally {
      setUndoing(null);
    }
  }

  async function buildRequest(r: { id: string; request: string; plans: AssistantPlan[] | null }) {
    if (!r.plans?.length) return;
    // This tap is the yes. Recording it here is what lets the merchant
    // approve from inside Claude too: their AI can only build a
    // request somebody stamped, and it cannot stamp its own.
    await supabase.rpc("abo_approve_request", { p_request: r.id });

    // Only what actually got built is written down as built. This used
    // to mark it regardless, so a failed build disappeared from the
    // queue as done — and their assistant, reading that queue, would
    // tell them it was finished.
    // The id goes with it now. The server claims the request before
    // writing anything and records the outcome afterwards, so a second
    // tab — or the assistant approving at the same moment — is told it
    // is already being built instead of building it a second time.
    // The request text goes with it so the thread can say what was
    // asked, not only what came of it.
    await onBuild(r.plans, r.id, r.request);
    // Reloaded rather than removed: it becomes the record that this
    // was built, which is the whole point of keeping it.
    loadRequests();
  }

  async function dismissRequest(id: string) {
    const { error } = await supabase
      .from("build_requests")
      .update({ status: "dismissed", resolved_at: new Date().toISOString() })
      .eq("id", id);
    // Removed after the write, not before it. Dropping the card first
    // meant a failed dismissal looked done here and stayed waiting
    // everywhere else — including in what their assistant is told.
    if (error) {
      console.error("could not dismiss the request:", error.message);
      loadRequests();
      return;
    }
    setRequests((prev) => prev.filter((x) => x.id !== id));
  }
  useEffect(() => {
    supabase.rpc("abo_my_settings").then(({ data }) => {
      const row = data?.[0];
      setFeatures({ chat: row?.chat_enabled ?? true, mcp: row?.mcp_enabled ?? true });
      if (typeof row?.free_turns === "number") {
        setTurns({
          free: row.free_turns,
          used: row.turns_used ?? 0,
          unlimited: row.turns_unlimited ?? false,
        });
      }
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
  /** The request whose redesign is running, so it cannot be started twice. */
  const [opening, setOpening] = useState<string | null>(null);
  const [bellOpen, setBellOpen] = useState(false);
  // Which row is asking "are you sure". A browser confirm box is
  // another application's chrome interrupting ours, and it cannot be
  // styled, placed, or dismissed the way anything else here can.
  const [confirmThread, setConfirmThread] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const menus = useRef<HTMLDivElement | null>(null);

  // A popover that only closes by pressing the thing that opened it
  // is a popover people leave open and then click through.
  useEffect(() => {
    if (!bellOpen && !threadsOpen) return;
    const shut = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof PointerEvent && menus.current?.contains(e.target as Node)) return;
      setBellOpen(false);
      setThreadsOpen(false);
      setConfirmThread(null);
    };
    document.addEventListener("pointerdown", shut);
    document.addEventListener("keydown", shut);
    return () => {
      document.removeEventListener("pointerdown", shut);
      document.removeEventListener("keydown", shut);
    };
  }, [bellOpen, threadsOpen]);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Keep the latest message in view. Request cards sit at the end of
  // the same list, so they count as newest too — without them here, a
  // build that just landed opens below the fold.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, requests.length, busy, steps.length]);

  // How long the current step has been running. A model call is
  // twenty quiet seconds; a number that moves says the turn has not
  // died, and a number that reaches sixty says something has.
  const [stepSeconds, setStepSeconds] = useState(0);
  useEffect(() => {
    if (!busy) return;
    setStepSeconds(0);
    const started = Date.now();
    const t = setInterval(() => setStepSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy, steps.length]);

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
  /** Only the ones still waiting on them deserve the badge. */
  // Not "pending" — "wants you". A half-built section is nobody's
  // decision to make and so counted as nothing, which put it behind a
  // bell with no number on it: recorded, and still unknown to them.
  const pendingCount = requests.filter(
    (r) => r.status === "pending" || r.status === "partly_built"
  ).length;

  // On the tab, not only in the panel. A merchant is not sitting here
  // when their assistant proposes something — they are in another tab,
  // doing the job this app is meant to help with, and the bell they
  // never see is no better than nothing.
  useEffect(() => {
    showWaiting(pendingCount);
    return () => showWaiting(0);
  }, [pendingCount]);
  /** Requests that turned up just now, floating over the panel. */
  const [toasts, setToasts] = useState<string[]>([]);
  /** What was already waiting last time we looked. Null = never looked. */
  const seen = useRef<Set<string> | null>(null);

  // A toast interrupts; it should not also nag. After a while it
  // steps aside and the bell keeps the count — nothing is lost by
  // letting it go.
  useEffect(() => {
    if (toasts.length === 0) return;
    const t = setTimeout(() => setToasts((prev) => prev.slice(1)), 12000);
    return () => clearTimeout(t);
  }, [toasts]);
  const loadClients = useCallback(async () => {
    const { data } = await supabase.rpc("abo_oauth_clients");
    setClients(data ?? []);
  }, []);
  useEffect(() => {
    if (features.mcp) loadClients();
  }, [features.mcp, loadClients]);

  async function revoke(client: { client_id: string; name: string }) {
    setRevoking(client.client_id);
    await supabase.rpc("abo_oauth_revoke", { p_client: client.client_id });
    setRevoking(null);
    loadClients();
  }

  return (
    <aside
      style={{ ["--chat-w" as string]: `${width}px` }}
      className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] shrink-0 flex-col border-l border-slate-200 bg-white lg:relative lg:w-[var(--chat-w)] lg:max-w-none lg:translate-x-0 ${
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
            <div className="font-display text-sm font-semibold tracking-tight">Luke</div>
            <div className="text-[11px] text-slate-400">
              Build anything by describing it — preview before it applies
            </div>
          </div>
          <div ref={menus} className="relative ml-auto flex items-center gap-1">
            {/* What their own AI asked for is a notification, not a
                turn in the conversation. It lived in the stream and
                sat there through every reload, taller than the chat
                and describing something already dealt with. Twice we
                moved where it sat; what was wrong was what it was. */}
            {requests.length > 0 && (
              <button
                onClick={() => {
                  setBellOpen((o) => !o);
                  setThreadsOpen(false);
                }}
                title="What your AI asked for"
                aria-label={`${pendingCount} want your attention`}
                className={`relative rounded-lg px-2 py-1 text-[12px] transition-colors hover:bg-slate-100 ${
                  pendingCount > 0 ? "text-amber-600" : "text-slate-400"
                }`}
              >
                🔔
                {pendingCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-semibold text-white">
                    {pendingCount}
                  </span>
                )}
              </button>
            )}
            <button
              onClick={onNewThread}
              title="Start a fresh conversation"
              className="rounded-lg px-2 py-1 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              + New
            </button>
            {threads.length > 0 && (
              <button
                onClick={() => {
                  setThreadsOpen((o) => !o);
                  setBellOpen(false);
                }}
                title="Past conversations"
                aria-label="Past conversations"
                className="rounded-lg px-2 py-1 text-[11px] text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                🕘 {threads.length}
              </button>
            )}
            {bellOpen && (
              <div className="absolute top-full right-0 z-50 mt-1 max-h-96 w-80 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-lg thin-scroll">
        {requests.map((r) => {
          const done = r.status === "built";
          const half = r.status === "partly_built";
          // A finished thing does not belong in the live area at full
          // height. It sat there for a week, taller than the chat,
          // describing something the merchant dealt with yesterday —
          // and naming a section they may since have deleted.
          // A half-built one is never collapsed away. It is not a
          // finished thing being kept for the record; it is a section
          // sitting there with part of what was asked for, and the
          // only screen that can say so.
          if (half) {
            const missed = r.outcome?.errors ?? [];
            return (
              <div
                key={r.id}
                className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2"
              >
                <div className="text-[11px] font-medium text-amber-800">
                  ⚠️ Only part of this was built
                </div>
                <div className="text-[11px] text-slate-600">{r.request}</div>
                {missed.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-4 text-[10px] text-amber-700">
                    {missed.slice(0, 3).map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
                <div className="text-[10px] text-slate-500">
                  Ask for the missing part again — this one cannot be finished.
                </div>
                <button
                  onClick={() => dismissRequest(r.id)}
                  className="text-[10px] text-slate-500 hover:underline"
                >
                  Dismiss
                </button>
              </div>
            );
          }

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
                  {/* The setting is on and this is asking anyway. Without
                      a reason here the card reads as the setting not
                      working — which is exactly what it looked like. */}
                  {!done && (r.outcome?.errors?.length ?? 0) > 0 ? (
                    // Tried on its own and did not go in. The errors
                    // are the design's, so Luke can correct the design
                    // — and the correction waits for a yes like any
                    // other change.
                    <ErrorNote
                      compact
                      onFix={onFix}
                      error={engineError(
                        autoBuild
                          ? "It was tried on its own and did not go in."
                          : "This could not be built as it is.",
                        r.outcome!.errors!,
                        fixPrompt({
                          what: r.request,
                          tried: r.plans,
                          errors: r.outcome!.errors!,
                        })
                      )}
                    />
                  ) : !done && autoBuild && whyItIsAsking(r) ? (
                    <div className="rounded-lg border border-amber-300 bg-amber-100/70 px-2 py-1.5 text-[11px] leading-relaxed text-amber-900">
                      <span className="font-semibold">Waiting for you:</span>{" "}
                      {whyItIsAsking(r)}
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
                    disabled={opening !== null}
                    className="rounded-lg border border-amber-300 px-2 py-1 text-[10px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                  >
                    {opening === r.id
                      ? "Designing…"
                      : r.plans?.length
                        ? "Change it first"
                        : "Design it"}
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
              </div>
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
                    {confirmThread === t.id ? (
                      <span className="flex shrink-0 items-center gap-1 pr-1 text-[10px]">
                        <button
                          onClick={() => {
                            setConfirmThread(null);
                            onDeleteThread(t.id);
                          }}
                          className="font-medium text-rose-600 hover:underline"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setConfirmThread(null)}
                          className="text-slate-400 hover:underline"
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmThread(t.id)}
                        aria-label={`Delete ${t.title ?? "this conversation"}`}
                        className="shrink-0 rounded px-1.5 py-1 text-[11px] text-slate-300 hover:bg-rose-50 hover:text-rose-500"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close Luke"
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
              <div key={m.id} className="flex flex-col items-end">
                {m.viaClient && (
                  <div className="mb-0.5 pr-1 text-[10px] tracking-wide text-slate-400 uppercase">
                    Asked through your AI
                  </div>
                )}
                {/* break-words, because a request is not always made of
                    words: "(Pending/Packed/Verified/Discrepancy)" is one
                    unbreakable token, and without this it ran straight
                    off the right edge of the panel and was cut in half.
                    Same for a pasted URL or a list of SKUs. */}
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-3 py-2 text-sm break-words text-white">
                  {m.text}
                </div>
              </div>
            );
          }

          if (m.role === "system") {
            if (m.error) {
              return (
                <div key={m.id}>
                  <ErrorNote error={m.error} onFix={onFix} />
                </div>
              );
            }
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
                <div className="break-words">{m.text}</div>
                {/* Under the build, which is where they find out it
                    happened — a change made with nobody watching is
                    read here first, and this is the moment they want
                    to say no. It names what goes back, because "undo"
                    on its own does not say how much. */}
                {m.undo && onUndo && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-emerald-200 pt-1.5">
                    <button
                      onClick={() => putItBack(m.undo!.messageId)}
                      disabled={undoing !== null}
                      className="rounded-lg border border-emerald-300 bg-white px-2 py-1 text-[10px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {undoing === m.undo.messageId ? "Putting it back…" : "↩️ Put it back"}
                    </button>
                    <span className="text-[10px] text-emerald-700/80">
                      {m.undo.what.join(", ")}
                    </span>
                  </div>
                )}
              </div>
            );
          }

          const plan = m.plan;
          // A card with anything after it was dealt with — the same
          // rule the clarify and blueprint cards already follow, and
          // the one this card was left out of. Session state alone
          // meant a reloaded thread offered Apply Change on a plan
          // that had already been applied, and applying a RECORD_SEED
          // twice writes its rows twice.
          const isPending = applyingPlanId === m.id || answered;
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
                        {answered ? "Dealt with" : isPending ? "Deleting…" : "Delete module"}
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
                      {answered ? "Dealt with" : isPending ? "Applying…" : "Apply Change"}
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
        {busy && (
          <div className="space-y-1 text-xs text-slate-400">
            {/* Each line is a step the server said it took, in the
                order it said so. The last one is still running; the
                ones above it are done. Nothing here is on a timer —
                a turn that stalls shows a line that stays put, with
                the seconds climbing beside it. */}
            {(steps.length ? steps : [null]).map((step, i, all) => {
              const active = i === all.length - 1;
              const words = step ? stepWords(step) : "Working on it…";
              return (
                <div key={i} className={`flex items-center gap-2 ${active ? "" : "text-slate-300"}`}>
                  {active ? (
                    <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" />
                  ) : (
                    <span className="w-2 shrink-0 text-center text-[10px] text-emerald-500">✓</span>
                  )}
                  <span className="min-w-0 truncate" title={words}>
                    {words}
                  </span>
                  {active && stepSeconds >= 2 && (
                    <span className="shrink-0 tabular-nums text-slate-300">{stepSeconds}s</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* What just arrived, saying so. It floats rather than taking
          a place in the layout: an interruption that pushed the
          conversation around would be a worse interruption. Letting
          it go loses nothing — the bell above still has it. */}
      {toasts.length > 0 && (
        <div className="pointer-events-none absolute inset-x-3 bottom-32 z-30 space-y-2">
          {toasts.map((id) => {
            const r = requests.find((x) => x.id === id);
            if (!r || r.status !== "pending") return null;
            return (
              <div
                key={id}
                className="pointer-events-auto rounded-xl border border-amber-300 bg-amber-50 p-3 shadow-lg"
              >
                <div className="flex items-start gap-2">
                  <span className="text-sm">✦</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold tracking-widest text-amber-700 uppercase">
                      Your AI asked for this
                    </div>
                    <p className="mt-0.5 line-clamp-3 text-[11px] leading-relaxed text-amber-900">
                      {r.request}
                    </p>
                  </div>
                  <button
                    onClick={() => setToasts((p) => p.filter((x) => x !== id))}
                    aria-label="Later"
                    className="shrink-0 text-[11px] text-amber-600 hover:text-amber-800"
                  >
                    ✕
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  {r.plans?.length ? (
                    <button
                      onClick={() => {
                        setToasts((p) => p.filter((x) => x !== id));
                        buildRequest(r);
                      }}
                      disabled={busy}
                      className="rounded-lg bg-amber-600 px-2 py-1 text-[10px] font-medium text-white hover:bg-amber-700 disabled:opacity-40"
                    >
                      Build it
                    </button>
                  ) : null}
                  <button
                    onClick={() => {
                      setToasts((p) => p.filter((x) => x !== id));
                      setBellOpen(true);
                    }}
                    className="rounded-lg border border-amber-300 px-2 py-1 text-[10px] font-medium text-amber-800 hover:bg-amber-100"
                  >
                    See it
                  </button>
                  <button
                    onClick={() => {
                      setToasts((p) => p.filter((x) => x !== id));
                      dismissRequest(r.id);
                    }}
                    className="ml-auto text-[10px] text-amber-700 hover:underline"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Their own AI. Shown alongside the chat rather than instead of
          it: both can be on, and a merchant who has connected Claude
          still uses this panel to read and approve what it asked for. */}
      {features.mcp && (
        <details
          className="border-t border-slate-100 px-3 py-2 text-[11px]"
          open={ownAiOpen || !features.chat}
          onToggle={(e) => setOwnAiOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
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
                  {/* Worth a pause — the assistant stops mid-sentence
                      and reconnecting means consent again — but a
                      browser confirm box is somebody else's chrome
                      appearing in the middle of our app. The second
                      click is the confirmation. */}
                  {confirmRevoke === c.client_id ? (
                    <span className="flex shrink-0 items-center gap-1.5 text-[10px]">
                      <span className="text-slate-500">Sure?</span>
                      <button
                        onClick={() => {
                          setConfirmRevoke(null);
                          revoke(c);
                        }}
                        className="font-medium text-rose-600 hover:underline"
                      >
                        Disconnect
                      </button>
                      <button
                        onClick={() => setConfirmRevoke(null)}
                        className="text-slate-400 hover:underline"
                      >
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmRevoke(c.client_id)}
                      disabled={revoking === c.client_id}
                      className="shrink-0 text-[10px] font-medium text-rose-600 hover:underline disabled:opacity-40"
                    >
                      {revoking === c.client_id ? "…" : "Disconnect"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </details>
      )}

      {/* Input */}
      {turns && !turns.unlimited && turns.used >= turns.free && features.chat ? (
        // Not a locked door with a price on it. What they can still
        // do is the larger half — reading their store never costs us
        // anything — so it is offered first, by name.
        <div className="border-t border-slate-100 p-3">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-semibold text-slate-700">
              You have used all {turns.free} included {turns.free === 1 ? "design" : "designs"}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              Asking about your store still works, and anything already designed can still
              be built. Designing something new is the part that needs Warmluke AI.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setWantsPlan(true)}
                className="rounded-lg bg-slate-900 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-slate-700"
              >
                Get Warmluke AI
              </button>
              {features.mcp && (
                <button
                  onClick={() => {
                    setWantsPlan(false);
                    setOwnAiOpen(true);
                  }}
                  className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-white"
                >
                  Use your own Claude
                </button>
              )}
            </div>
            {wantsPlan && (
              <div className="mt-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-[11px] leading-relaxed text-slate-600">
                Still being built — it releases soon. Until then your own Claude or ChatGPT
                does the asking, and Warmluke keeps building what you have already approved.
                <button
                  onClick={() => setWantsPlan(false)}
                  className="mt-1.5 block text-[10px] text-slate-400 hover:underline"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      ) : !features.chat ? (
        <div className="border-t border-slate-100 p-3 text-[11px] leading-relaxed text-slate-500">
          Luke is off for this account.{" "}
          {features.mcp
            ? "Your own AI can still design changes, and you approve them above."
            : "Ask us to turn Luke on for you."}
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
