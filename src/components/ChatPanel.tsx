"use client";

// ─────────────────────────────────────────────────────────────
// ChatPanel — presentational assistant panel. State and actions
// live in AppShell so the first-build flow can drive messages.
// Deletion always requires typing the module's name.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { watchRows } from "@/lib/live";
import GenericRenderer from "@/components/GenericRenderer";
import { describeAutomation, describePlan, WAITING_BUTTONS, type StoreFacts } from "@/lib/describe";
import { actionSpec } from "@/lib/store-actions";
import { apiFetch } from "@/lib/auth";
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
  NextStep,
  RecordRow,
  TurnEvent,
  UiSchema,
} from "@/lib/types";
import { Icon } from "@/components/ui/Icon";
import { ArrowUp, Bell, Check, ChevronRight, Copy, History, Pencil, Plug, Sparkles, Square, SquarePen, TriangleAlert, X, Zap } from "lucide-react";
import { button } from "@/components/ui/controls";
import { LukeMark } from "@/components/ui/LukeMark";
import { LUKE_COPY } from "@/lib/luke-copy";

/** A message arrives with a short rise; turned off when motion is asked to be reduced (globals.css). */
const RISE = { ["--rise-from" as string]: "6px", ["--rise-for" as string]: "0.28s" } as React.CSSProperties;

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
   * Corrected by a later edit. The bubble stays — it is what was
   * actually asked — but it is no longer the live question, and
   * neither is what it drew.
   */
  superseded?: boolean;
  /**
   * What this build changed that can be put back, and the id of the
   * stored message holding it.
   *
   * Carried on the message rather than looked up on demand: the point
   * of putting something back is to restore what it was before THIS
   * build, and the section may have moved on twice since.
   */
  undo?: { messageId: string; what: string[] };
  /**
   * What the design offered to do next, on the receipt of its build.
   * Shown only while this is the last thing in the thread: once
   * anything else has happened — a question, a put-back — an offer
   * made for the app as it was is stale.
   */
  next?: NextStep[];
  /**
   * What the turn did to arrive at this reply, as the server said it,
   * and how long it took. Session only — a reloaded thread does not
   * carry it, and does not need to.
   */
  trace?: { steps: TurnEvent[]; ms: number };
}

/**
 * The steps a turn took, folded into one quiet line above the reply:
 * "Read your store · thought it through · 14s", with every step behind
 * a caret. The words are this panel's; the steps and the time are not.
 */
function TraceLine({ trace }: { trace: { steps: TurnEvent[]; ms: number } }) {
  const parts: string[] = [];
  const store = trace.steps.find((s) => s.step === "store");
  if (store) parts.push(store.shop ? "Read your store" : "Read your app");
  const tries = trace.steps.filter((s) => s.step === "model").length;
  if (tries === 1) parts.push("thought it through");
  else if (tries > 1) parts.push(`took ${tries} tries`);
  if (trace.steps.some((s) => s.step === "gaps")) parts.push("checked for gaps");
  if (parts.length === 0) return null;
  const secs = Math.max(1, Math.round(trace.ms / 1000));
  return (
    <details className="group text-[11px] text-fg-faint">
      <summary className="cursor-pointer list-none select-none truncate hover:text-fg-muted">
        <ChevronRight aria-hidden size={14} strokeWidth={2} className="inline shrink-0 align-[-2px] transition-transform duration-150 group-open:rotate-90" />
        {parts.join(" · ")} · {secs}s
      </summary>
      <ul className="mt-0.5 space-y-0.5 pl-3.5 text-fg-faint">
        {trace.steps.map((s, i) => (
          <li key={i} className="flex items-center gap-1.5 truncate"><Check aria-hidden size={12} strokeWidth={2.25} className="shrink-0 text-tone-success-fg" />{stepWords(s)}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The sections a design would remove, by the name that has to be
 * typed to confirm each one.
 *
 * A removal takes every row with it and does not come back, so it is
 * the one change this card will not build on a single tap — the same
 * confirmation the section's own settings ask for. Their assistant
 * can propose one; only this can let it through.
 */
const removalsIn = (plans: AssistantPlan[] | null): string[] =>
  (plans ?? [])
    .filter((p) => p.changeType === "MODULE_DELETE")
    .map((p) => p.deleteConfirmName ?? "")
    .filter(Boolean);

/**
 * How long ago, in the fewest words that are still true.
 *
 * "Last used 21/09/2026, 15:49:33" is a timestamp, not an answer. The
 * question behind it is whether this assistant is still in use.
 */
function since(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** An assistant's mark, by the name it registered with; null for one we have no mark for. */
function assistantLogo(name: string): string | null {
  if (/claude/i.test(name)) return "/logos/claude.svg";
  if (/chatgpt|openai/i.test(name)) return "/logos/openai.svg";
  return null;
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


function describeFeatures(f: NonNullable<AssistantPlan["features"]>): string[] {
  const out: string[] = [];
  if (f.search?.enabled) out.push(`Search${f.search.fields?.length ? ` over ${f.search.fields.join(", ")}` : ""}`);
  for (const fl of f.filters ?? []) out.push(`Filter: ${fl.label} (${fl.options.join(" / ")})`);
  for (const s of f.stats ?? [])
    out.push(`Stat: ${s.label} (${s.op}${s.field ? ` of ${s.field}` : ""}${s.by ? ` by ${s.by}` : ""})`);
  if (f.defaultSort) out.push(`Default sort: ${f.defaultSort.field} ${f.defaultSort.dir}`);
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

  // Questions read as a message, not a form: Luke's line, then the
  // questions numbered underneath, each with its example answers and a
  // place to type. No header, no badge, no box around it.
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-fg">{message}</p>

      <ol className="space-y-3">
        {questions.map((q, n) => (
          <li key={q.id} className="space-y-1.5">
            <div className="text-[13px] leading-relaxed text-fg">
              <span className="mr-1.5 text-fg-faint">{n + 1}.</span>
              {q.question}
            </div>
            {q.why && <div className="pl-5 text-[11px] text-fg-faint">{q.why}</div>}
            {!done && (q.suggestions?.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5 pl-5">
                {q.suggestions!.map((sug) => {
                  const on = parts(q.id).includes(sug);
                  return (
                    <button
                      key={sug}
                      onClick={() => toggle(q.id, sug)}
                      aria-pressed={on}
                      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                        on
                          ? "border-primary bg-primary font-medium text-on-primary"
                          : "border-line text-fg-muted hover:border-line-strong hover:text-fg"
                      }`}
                    >
                      {sug}
                    </button>
                  );
                })}
              </div>
            )}
            {done ? (
              <div className="pl-5 text-xs text-fg-muted">→ {shown(q.id) || "(skipped)"}</div>
            ) : (
              <div className="pl-5">
                <textarea
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                  rows={1}
                  placeholder="Pick any above, or type your own"
                  className="w-full resize-none rounded-lg border border-line px-2.5 py-1.5 text-xs outline-none focus:border-focus focus:ring-2 focus:ring-focus/15"
                />
              </div>
            )}
          </li>
        ))}
      </ol>

      {!done && (
        <button
          onClick={submit}
          disabled={answered.length === 0}
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-40"
        >
          Send answers ({answered.length}/{questions.length})
        </button>
      )}
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
  // then nothing is really approved. One line per thing, its detail
  // behind a caret.
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

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

  // A design reads as a message: what Luke said, what it would build
  // as one line per thing with the detail behind a caret, what it does
  // not cover, and two small actions. No header, no badge, no boxes.
  // The platform's limits are not repeated on every design any more;
  // they sit under the composer, one tap away, and a design that fails
  // to meet something says so in its own "Not covered" line.
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-fg">{message}</p>
      {blueprint.summary && blueprint.summary.trim() !== message.trim() && (
        <p className="text-[13px] leading-relaxed text-fg-muted">{blueprint.summary}</p>
      )}

      <div className="space-y-1">
        {hasOptional && !done && (
          <div className="text-[11px] text-fg-faint">Untick anything you don&rsquo;t need.</div>
        )}
        {blueprint.plans.map((plan, i) => {
          const summary = describePlan(plan, modules, currentColumns, storeFacts);
          const off = dropped[i] || referencesDropped(plan);
          const cascaded = !dropped[i] && off;
          const hasDetail = summary.lines.length > 0;
          const open = !!expanded[i];
          const toggleDetail = () => hasDetail && setExpanded((p) => ({ ...p, [i]: !p[i] }));
          return (
            <div key={i} className={`flex items-start gap-1.5 ${off ? "opacity-50" : ""}`}>
              {plan.optional && !done && !cascaded ? (
                <input
                  type="checkbox"
                  checked={!dropped[i]}
                  onChange={() => setDropped((prev) => ({ ...prev, [i]: !prev[i] }))}
                  className="mt-1 h-3.5 w-3.5 shrink-0 accent-primary"
                />
              ) : (
                <button
                  onClick={toggleDetail}
                  aria-expanded={open}
                  aria-label={hasDetail ? (open ? "Hide detail" : "Show detail") : undefined}
                  className={`mt-0.5 w-3.5 shrink-0 text-center text-[11px] ${
                    hasDetail ? "text-fg-faint hover:text-fg" : "cursor-default text-fg-faint"
                  }`}
                >
                  {hasDetail ? (
                    <ChevronRight aria-hidden size={13} strokeWidth={2} className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
                  ) : (
                    "·"
                  )}
                </button>
              )}
              <div className="min-w-0 flex-1">
                <button
                  onClick={toggleDetail}
                  className={`text-left text-[13px] leading-relaxed text-fg ${hasDetail ? "hover:text-fg" : "cursor-default"}`}
                >
                  {summary.title}
                  {hasDetail && !open && (
                    <span className="text-fg-faint">
                      {" "}· {summary.lines.length} detail{summary.lines.length === 1 ? "" : "s"}
                    </span>
                  )}
                </button>
                {plan.optional && (
                  <span className="ml-1.5 rounded bg-tone-attention/25 px-1 py-px text-[9px] font-semibold tracking-wide text-tone-attention-fg uppercase">
                    Optional
                  </span>
                )}
                {cascaded && <span className="ml-1.5 text-[11px] text-fg-faint">needs a section you removed</span>}
                {plan.optional && plan.optionalWhy && (
                  <div className="text-[11px] leading-relaxed text-tone-attention-fg">{plan.optionalWhy}</div>
                )}
                {/* Above the detail, not inside it: this changes whether
                    the owner wants the section at all. */}
                {summary.warnings?.map((w, k) => (
                  <div key={k} className="mt-0.5 text-[11px] leading-relaxed text-tone-attention-fg">
                    {w}
                  </div>
                ))}
                {open && hasDetail && (
                  <ul className="mt-1 space-y-0.5 border-l border-line pl-2.5">
                    {summary.lines.map((line, j) => (
                      <li key={j} className="text-[11px] leading-relaxed text-fg-muted">
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {blueprint.workflow.length > 0 && (
        <details className="group text-[11px]">
          <summary className="cursor-pointer list-none select-none text-fg-faint hover:text-fg-muted">
            <ChevronRight aria-hidden size={14} strokeWidth={2} className="inline shrink-0 align-[-2px] transition-transform duration-150 group-open:rotate-90" />
            How it flows
          </summary>
          <ol className="mt-1 space-y-1 pl-3.5">
            {blueprint.workflow.map((w, i) => (
              <li key={i} className="leading-relaxed text-fg-muted">
                {w.step}
                {w.who && <span className="text-fg-faint"> — {w.who}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}

      {(blueprint.unmet?.length ?? 0) > 0 && (
        <div className="text-[11px] leading-relaxed text-tone-attention-fg">
          <span className="font-medium">Not covered:</span> {blueprint.unmet!.join(" · ")}
        </div>
      )}

      {!done && (
        <div className="flex items-center gap-3 pt-0.5">
          <button
            onClick={() => onApprove(chosen)}
            disabled={chosen.length === 0}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-40"
          >
            Build {chosen.length === 1 ? "this" : `these ${chosen.length}`}
          </button>
          <button onClick={onAmend} className="text-xs text-fg-muted transition-colors hover:text-fg hover:underline">
            Change something
          </button>
        </div>
      )}
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
  onEditPrompt,
  onApply,
  onBuild,
  onDiscard,
  onUndo,
  onFix,
  autoBuild,
  onWaiting,
}: {
  /** Panel width above lg; below it the panel is a full-width drawer. */
  width: number;
  dragging: boolean;
  onResizeStart: (e: React.PointerEvent) => void;
  onResizeReset: () => void;
  /** Drawer state below lg; the panel is always visible above it. */
  open: boolean;
  onClose: () => void;
  /**
   * How many things are waiting on the merchant, whenever it changes.
   *
   * The count is worked out here because the requests are loaded
   * here, and the shell needs it for the button that opens this
   * panel on a phone — where the panel starts shut, so the bell,
   * the line above the composer and every other sign of it are
   * behind a drawer nobody has a reason to open.
   */
  onWaiting?: (count: number) => void;
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
  /**
   * Corrects a prompt already sent and runs it again. The shell owns
   * it because retiring the old exchange is a write, and because the
   * turn it starts is the same one the box starts.
   */
  onEditPrompt?: (messageId: string, text: string) => void | Promise<void>;
  onApply: (plan: AssistantPlan, planId: string) => void;
  /** Applies an approved blueprint's plans directly, with no model round trip. */
  onBuild: (
    plans: AssistantPlan[],
    requestId?: string,
    requestText?: string,
    next?: NextStep[]
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
  // While they type, the composer's border carries a beam in the page's
  // ink, and each keystroke flares it; it goes a moment after they stop.
  const [typing, setTyping] = useState(false);
  const [strokes, setStrokes] = useState(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (typingTimer.current) clearTimeout(typingTimer.current);
  }, []);
  const [copied, setCopied] = useState(false);
  /** The bubble being corrected, and the words as they stand. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  /** The request asking to remove a section, and the name typed back. */
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
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
   * Changes waiting to go out to the merchant's actual shop.
   *
   * Kept apart from the designs above, and shown apart, because they
   * are a different yes: one builds a section in an app only they
   * see, the other tags an order in a business. Everything about
   * what a row means — what it does in words, whether it can be
   * taken back, what has to be tapped — comes off the registry
   * entry, so nothing here knows what any one change is called.
   */
  const [shopChanges, setShopChanges] = useState<
    Array<{
      id: string;
      action: string;
      summary: string;
      status: string;
      targets: Array<{ id: string }> | null;
      created_at: string;
      outcome: { done?: string[]; errors?: string[] } | null;
      shop_domain?: string | null;
    }>
  >([]);
  /** Which one is being sent right now, so it cannot be sent twice. */
  const [sending, setSending] = useState<string | null>(null);

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

  const loadShopChanges = useCallback(async () => {
    const { data } = await supabase
      .from("store_actions")
      .select("id, action, summary, status, targets, created_at, outcome, store_id, stores(shop_domain)")
      .eq("project_id", projectId)
      // Waiting ones always; ones that really went out for a week,
      // because this is the only place a merchant can see what
      // Warmluke did to their shop. A dismissed one is neither: they
      // said no, and a receipt for something that never happened is
      // just the card refusing to leave.
      .or(
        `status.in.(pending,approved,running),and(status.in.(done,partly_done,failed),created_at.gte.${new Date(
          Date.now() - 7 * 864e5
        ).toISOString()})`
      )
      .order("created_at", { ascending: false })
      .limit(20);
    setShopChanges(
      ((data ?? []) as Array<Record<string, unknown>>).map((a) => ({
        id: a.id as string,
        action: a.action as string,
        summary: a.summary as string,
        status: a.status as string,
        targets: (a.targets ?? null) as Array<{ id: string }> | null,
        created_at: a.created_at as string,
        outcome: (a.outcome ?? null) as { done?: string[]; errors?: string[] } | null,
        shop_domain:
          (a.stores as { shop_domain?: string } | null)?.shop_domain ?? null,
      }))
    );
  }, [projectId]);
  useEffect(() => {
    loadShopChanges();
  }, [loadShopChanges]);
  useEffect(
    () =>
      watchRows(`shop-changes:${projectId}`, [
        { table: "store_actions", filter: `project_id=eq.${projectId}`, onChange: loadShopChanges },
      ]),
    [projectId, loadShopChanges]
  );

  /**
   * The merchant's yes, and the change going out — one call, because
   * it is one act. The panel never decides whether it is allowed;
   * the route and the database do, and whatever they say is what is
   * shown.
   */
  async function sendShopChange(id: string, what: "run" | "dismiss") {
    setSending(id);
    try {
      const { ok, data } = await apiFetch("/api/store-actions", { actionId: id, do: what });
      if (!ok) {
        // Not a red box: the usual way to see this is a second tab,
        // or a second tap on something already gone. Reloading shows
        // what is really there, which is the answer either way.
        console.warn("store change refused:", data?.error);
      }
    } finally {
      setSending(null);
      loadShopChanges();
    }
  }

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
    // Typed, not tapped. Their assistant may ask for a section to go;
    // it may not be the thing that makes it go.
    const removing = removalsIn(r.plans);
    if (removing.length && confirmText.trim() !== removing.join(", ")) return;
    setConfirmFor(null);
    setConfirmText("");
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
  // Whether the steps already taken are shown under the current one.
  const [stepsOpen, setStepsOpen] = useState(false);
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
    // Back to one row once the words have gone.
    if (inputRef.current) inputRef.current.style.height = "auto";
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
  // Both kinds, because the bell, the tab and the line above the
  // composer are all answering one question: is anything waiting on
  // me. A merchant whose Claude asked for a tag and got no number
  // anywhere would find it by accident or not at all.
  const pendingCount =
    requests.filter((r) => r.status === "pending" || r.status === "partly_built").length +
    shopChanges.filter((a) => a.status === "pending").length;
  /**
   * Which ones are waiting, as one string.
   *
   * The line above the composer is dismissed against this rather
   * than against a boolean: cleared once, it stays cleared for these
   * requests and comes back by itself the moment a different one
   * turns up. A boolean would either nag after they had said no, or
   * go quiet for good.
   */
  const waitingKey = [
    ...requests.filter((r) => r.status === "pending" || r.status === "partly_built").map((r) => r.id),
    ...shopChanges.filter((a) => a.status === "pending").map((a) => a.id),
  ].join(",");

  // On the tab, not only in the panel. A merchant is not sitting here
  // when their assistant proposes something — they are in another tab,
  // doing the job this app is meant to help with, and the bell they
  // never see is no better than nothing.
  useEffect(() => {
    showWaiting(pendingCount);
    return () => showWaiting(0);
  }, [pendingCount]);
  useEffect(() => {
    onWaiting?.(pendingCount);
  }, [pendingCount, onWaiting]);

  // Arrived from a link their assistant gave them. It names the
  // request, and the only promise the link makes is that the thing
  // is in front of them when they land — so the bell opens itself.
  // The id is not looked up: if it was dealt with in the meantime
  // the bell simply opens on whatever is there, which is the truth
  // at that moment.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).get("waiting")) return;
    setBellOpen(true);
  }, []);
  /** Requests that turned up just now, floating over the panel. */
  const [toasts, setToasts] = useState<string[]>([]);
  /** The set of waiting requests the line above the composer was cleared for. */
  const [noticeCleared, setNoticeCleared] = useState("");
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

  /**
   * One row per assistant, not per registration.
   *
   * Claude registers itself afresh every time the connector is added,
   * so a merchant who set it up on a laptop and again on a phone had
   * five identical rows called "Claude", each with its own Disconnect
   * and nothing to tell them apart. The list read as five strangers
   * holding keys. They are one assistant that has knocked five times.
   *
   * Grouped by name here rather than in SQL: the consents are real and
   * separate, revoking still works one at a time, and this is only how
   * they are shown.
   */
  const assistants = useMemo(() => {
    const by = new Map<string, typeof clients>();
    for (const c of clients) {
      const list = by.get(c.name);
      if (list) list.push(c);
      else by.set(c.name, [c]);
    }
    return [...by.entries()]
      .map(([name, list]) => ({
        name,
        ids: list.map((c) => c.client_id),
        // The newest of them: one assistant, whichever registration
        // it happened to use last.
        lastCall: list
          .map((c) => c.last_call)
          .filter((d): d is string => !!d)
          .sort()
          .at(-1) ?? null,
        calls24h: list.reduce((n, c) => n + Number(c.calls_24h ?? 0), 0),
        count: list.length,
      }))
      .sort((a, b) => (b.lastCall ?? "").localeCompare(a.lastCall ?? ""));
  }, [clients]);

  async function revoke(assistant: { name: string; ids: string[] }) {
    setRevoking(assistant.name);
    // Every registration it made, or the row comes back with one
    // fewer and the merchant taps Disconnect again and again.
    for (const client_id of assistant.ids) {
      await supabase.rpc("abo_oauth_revoke", { p_client: client_id });
    }
    setRevoking(null);
    loadClients();
  }

  return (
    <aside
      style={{ ["--chat-w" as string]: `${width}px` }}
      className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] shrink-0 flex-col overflow-hidden border-l border-line bg-surface lg:relative lg:w-[var(--chat-w)] lg:max-w-none lg:translate-x-0 lg:rounded-card lg:border-l-0 lg:shadow-card ${
        dragging ? "" : "transition-transform duration-200"
      } ${open ? "translate-x-0" : "translate-x-full"}`}
    >
      <div
        onPointerDown={onResizeStart}
        onDoubleClick={onResizeReset}
        title="Drag to resize · double-click to reset"
        className={resizeHandleClass("right", dragging)}
      />
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <LukeMark state={busy ? "thinking" : "idle"} />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-fg">Luke</div>
            <div className="truncate text-[11px] text-fg-faint">{LUKE_COPY.tagline}</div>
          </div>
          <div ref={menus} className="relative ml-auto flex items-center gap-1">
            {/* What their own AI asked for is a notification, not a
                turn in the conversation. It lived in the stream and
                sat there through every reload, taller than the chat
                and describing something already dealt with. Twice we
                moved where it sat; what was wrong was what it was. */}
            {/* Always there, so it is found in the same place whether or
                not anything is waiting; an empty bell says so when opened. */}
            <button
                onClick={() => {
                  setBellOpen((o) => !o);
                  setThreadsOpen(false);
                }}
                title="What your AI asked for"
                aria-expanded={bellOpen}
                aria-label={pendingCount > 0 ? `${pendingCount} want your attention` : "Nothing waiting on you"}
                className={`relative inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-control px-1.5 transition-colors hover:bg-surface-hover hover:text-fg ${bellOpen ? "bg-surface-hover text-fg" : "text-fg-muted"}`}
              >
                <Bell aria-hidden size={16} strokeWidth={1.75} />
                {pendingCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-signal-critical px-1 text-[9px] font-semibold text-white ring-2 ring-surface">
                    {pendingCount}
                  </span>
                )}
              </button>
            {/* A fresh conversation, the one before kept under History.
                Offered once there is one to leave: on an empty thread it
                would do nothing. */}
            {messages.length > 0 && (
              <button
                onClick={onNewThread}
                title="Start a new conversation (this one stays in History)"
                aria-label="New conversation"
                className="relative inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-control px-1.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
              >
                <SquarePen aria-hidden size={16} strokeWidth={1.75} />
              </button>
            )}
            {threads.length > 0 && (
              <button
                onClick={() => {
                  setThreadsOpen((o) => !o);
                  setBellOpen(false);
                }}
                title="Past conversations"
                aria-label="Past conversations"
                className="relative inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-control px-1.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
              >
                <History aria-hidden size={16} strokeWidth={1.75} />
                <span className="text-[11px] tabular-nums">{threads.length}</span>
              </button>
            )}
            {bellOpen && (
              <div className="pop thin-scroll absolute top-full right-0 z-50 mt-1.5 max-h-96 w-80 space-y-2 overflow-y-auto rounded-card bg-surface p-2 shadow-popover">
        {requests.length === 0 && shopChanges.length === 0 && (
          <div className="flex flex-col items-center px-4 py-6 text-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-canvas text-fg-faint">
              <Bell aria-hidden size={16} strokeWidth={1.75} />
            </span>
            <div className="mt-2.5 text-[13px] font-medium text-fg">Nothing waiting on you</div>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">
              When your own AI asks for a section or a change to your shop, it shows up here for your yes.
            </p>
          </div>
        )}
        {/* Changes to the shop, above the designs. Not a different
            colour — a different first line. The words are what say
            this one leaves the building, and a second palette would
            only be one more thing to learn. */}
        {shopChanges.map((a) => {
          const spec = actionSpec(a.action);
          const waiting = a.status === "pending";
          const going = a.status === "approved" || a.status === "running";
          const busy = sending === a.id;
          const touched = a.targets?.length ?? 0;
          // Fails closed. An entry that asks for a word to be typed
          // has nowhere here to type it, and running it anyway would
          // skip the whole reason it asked.
          const canRun = waiting && !!spec && spec.confirm === "list";
          return (
            <div
              key={a.id}
              className={`rounded-xl border px-2.5 py-2 ${
                waiting || going ? "border-tone-attention bg-tone-attention/25" : "border-line bg-surface-subdued"
              }`}
            >
              <div className="text-[10px] font-semibold tracking-widest text-tone-attention-fg">
                IN YOUR SHOP{a.shop_domain ? ` · ${a.shop_domain}` : ""}
              </div>
              <div className="mt-1 text-[12px] leading-relaxed text-fg">{a.summary}</div>
              <div className="mt-1 text-[10px] text-fg-muted">
                {touched > 0 ? `${touched} ${touched === 1 ? "thing" : "things"}` : "nothing named"}
                {spec ? (spec.undo ? " · can be undone" : " · cannot be undone") : " · not recognised"}
              </div>
              {spec?.undoNote && !spec.undo && (
                <div className="mt-1 text-[10px] leading-relaxed text-fg-muted">{spec.undoNote}</div>
              )}
              {!spec && (
                <div className="mt-1 text-[10px] leading-relaxed text-tone-critical-fg">
                  Warmluke does not recognise this change, so it cannot be done from here.
                </div>
              )}
              {spec && waiting && spec.confirm !== "list" && (
                <div className="mt-1 text-[10px] leading-relaxed text-tone-critical-fg">
                  This one has to be confirmed in a way this panel does not offer yet.
                </div>
              )}
              {going && <div className="mt-1 text-[10px] text-tone-attention-fg">Going out to the shop…</div>}
              {(a.status === "done" || a.status === "partly_done" || a.status === "failed") && (
                <div className="mt-1 text-[10px] leading-relaxed text-fg-muted">
                  {a.status === "done"
                    ? `Done · ${(a.outcome?.done ?? []).length} changed`
                    : a.status === "partly_done"
                      ? `Partly done · ${(a.outcome?.done ?? []).length} changed, ${(a.outcome?.errors ?? []).length} did not`
                      : "Did not happen"}
                  {(a.outcome?.errors ?? []).length > 0 && (
                    <div className="mt-1 text-tone-critical-fg">{(a.outcome?.errors ?? [])[0]}</div>
                  )}
                </div>
              )}
              {waiting && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {canRun && (
                    <button
                      onClick={() => sendShopChange(a.id, "run")}
                      disabled={busy}
                      className="rounded-lg bg-primary px-2 py-1 text-[10px] font-medium text-white hover:bg-primary-hover disabled:opacity-40"
                    >
                      {busy ? "Sending…" : WAITING_BUTTONS.runStoreAction}
                    </button>
                  )}
                  <button
                    onClick={() => sendShopChange(a.id, "dismiss")}
                    disabled={busy}
                    className="ml-auto text-[10px] text-tone-attention-fg hover:underline disabled:opacity-40"
                  >
                    Not now
                  </button>
                </div>
              )}
            </div>
          );
        })}
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
                className="space-y-1 rounded-lg border border-tone-attention/70 bg-tone-attention/25 px-2.5 py-2"
              >
                <div className="text-[11px] font-medium text-tone-attention-fg">
                  <TriangleAlert aria-hidden size={13} className="mr-1 inline align-[-2px]" />Only part of this was built
                </div>
                <div className="text-[11px] text-fg-muted">{r.request}</div>
                {missed.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-4 text-[10px] text-tone-attention-fg">
                    {missed.slice(0, 3).map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
                <div className="text-[10px] text-fg-muted">
                  Ask for the missing part again — this one cannot be finished.
                </div>
                <button
                  onClick={() => dismissRequest(r.id)}
                  className="text-[10px] text-fg-muted hover:underline"
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
                className="flex items-center gap-2 rounded-lg border border-line bg-surface-subdued px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-[10px] text-fg-faint">
                  Built by your AI
                  {r.built_at ? ` · ${new Date(r.built_at).toLocaleDateString()}` : ""} ·{" "}
                  {r.request}
                </span>
                <button
                  onClick={() => setOpenBuilt((p) => ({ ...p, [r.id]: true }))}
                  className="shrink-0 text-[10px] text-fg-muted hover:underline"
                >
                  Show
                </button>
                <button
                  onClick={() => dismissRequest(r.id)}
                  aria-label="Hide this"
                  className="shrink-0 text-[11px] text-fg-faint hover:text-fg-muted"
                >
                  <X aria-hidden size={14} strokeWidth={2} />
                </button>
              </div>
            );
          }
          return (
            <div
              key={r.id}
              className={`rounded-xl border px-3 py-2.5 ${
                done ? "border-line bg-surface-subdued" : "border-tone-attention/70 bg-tone-attention/25"
              }`}
            >
              <div
                className={`text-[10px] font-semibold tracking-widest uppercase ${
                  done ? "text-fg-faint" : "text-tone-attention-fg"
                }`}
              >
                {done
                  ? `Built by your AI${r.built_at ? ` · ${new Date(r.built_at).toLocaleString()}` : ""}`
                  : "Asked for by your AI"}
              </div>
              <div className="mt-2">
              <p className={`text-[11px] leading-relaxed font-medium ${done ? "text-fg" : "text-tone-attention-fg"}`}>{r.request}</p>
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
                          className={`text-[11px] font-semibold ${done ? "text-fg" : "text-tone-attention-fg"}`}
                        >
                          {d.title}
                        </div>
                        {d.warnings?.map((w, k) => (
                          <div
                            key={k}
                            className="mt-1 rounded border border-tone-attention bg-tone-attention/40 px-2 py-1.5 text-[11px] leading-relaxed text-tone-attention-fg"
                          >
                            {w}
                          </div>
                        ))}
                        {d.lines.length > 0 && (
                          <details className="mt-1">
                            <summary
                              className={`cursor-pointer list-none text-[10px] hover:underline ${
                                done ? "text-fg-muted" : "text-tone-attention-fg"
                              }`}
                            >
                              {done ? "What was built" : "Show details"}
                            </summary>
                            <ul
                              className={`mt-1 space-y-0.5 text-[11px] leading-relaxed ${
                                done ? "text-fg-muted" : "text-tone-attention-fg/90"
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
                      className={`text-[11px] leading-relaxed ${done ? "text-fg-muted" : "text-tone-attention-fg"}`}
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
                    <div className="rounded-lg border border-tone-attention bg-tone-attention/40 px-2 py-1.5 text-[11px] leading-relaxed text-tone-attention-fg">
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
                  <div className="mt-1.5 rounded-lg bg-surface/70 px-2.5 py-2 text-[11px] leading-relaxed whitespace-pre-wrap text-tone-attention-fg">
                    {r.summary}
                  </div>
                )
              )}
              {!done && (
              // Wrapping, because the confirm step puts five things on
              // this row — a name to type, Remove it, Cancel, Change
              // it first, Dismiss — and the panel is 300px at its
              // narrowest. Without it the row ran off the side and
              // took a horizontal scrollbar with it, so the button
              // that says "Change it first" sat outside the card.
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {r.plans?.length ? (
                  removalsIn(r.plans).length ? (
                    confirmFor === r.id ? (
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <input
                          autoFocus
                          value={confirmText}
                          onChange={(e) => setConfirmText(e.target.value)}
                          placeholder={removalsIn(r.plans).join(", ")}
                          aria-label={`Type ${removalsIn(r.plans).join(", ")} to confirm removing it`}
                          // Shrinks rather than pushing the row wide:
                          // the name being typed is short, and the
                          // buttons beside it are what must stay
                          // reachable.
                          className="w-36 min-w-0 max-w-full flex-shrink rounded-lg border border-tone-attention px-2 py-1 text-[10px] text-tone-attention-fg outline-none placeholder:text-fg-faint"
                        />
                        <button
                          onClick={() => buildRequest(r)}
                          disabled={busy || confirmText.trim() !== removalsIn(r.plans).join(", ")}
                          className="rounded-lg bg-critical px-2 py-1 text-[10px] font-medium text-white hover:bg-critical-hover disabled:opacity-40"
                        >
                          {WAITING_BUTTONS.confirmRemoval}
                        </button>
                        <button
                          onClick={() => {
                            setConfirmFor(null);
                            setConfirmText("");
                          }}
                          className="text-[10px] text-tone-attention-fg hover:underline"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setConfirmFor(r.id);
                          setConfirmText("");
                        }}
                        disabled={busy}
                        className="rounded-lg border border-tone-critical px-2 py-1 text-[10px] font-medium text-tone-critical-fg hover:bg-tone-critical/40 disabled:opacity-40"
                      >
                        {WAITING_BUTTONS.openRemoval}
                      </button>
                    )
                  ) : (
                    <button
                      onClick={() => buildRequest(r)}
                      disabled={busy}
                      className="rounded-lg bg-primary px-2 py-1 text-[10px] font-medium text-white hover:bg-primary-hover disabled:opacity-40"
                    >
                      {WAITING_BUTTONS.build}
                    </button>
                  )
                ) : null}
                {features.chat && (
                  <button
                    onClick={() => openRequest(r)}
                    disabled={opening !== null}
                    className="rounded-lg border border-tone-attention px-2 py-1 text-[10px] font-medium text-tone-attention-fg hover:bg-tone-attention/40 disabled:opacity-50"
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
                  className="ml-auto text-[10px] text-tone-attention-fg hover:underline"
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
              <div className="pop thin-scroll absolute top-full right-0 z-50 mt-1.5 max-h-72 w-64 overflow-y-auto rounded-card bg-surface p-1 shadow-popover">
                {threads.length === 0 && (
                  <div className="px-3 py-2 text-[11px] text-fg-faint">No past conversations.</div>
                )}
                {threads.map((t) => (
                  <div
                    key={t.id}
                    className={`flex items-center gap-1 px-1.5 transition-colors hover:bg-surface-hover ${
                      t.id === conversationId ? "bg-surface-hover" : ""
                    }`}
                  >
                    <button
                      onClick={() => {
                        onPickThread(t.id);
                        setThreadsOpen(false);
                      }}
                      className={`min-w-0 flex-1 px-1.5 py-2 text-left text-[11px] ${
                        t.id === conversationId ? "font-medium text-fg" : "text-fg-muted"
                      }`}
                    >
                      <div className="truncate font-medium">{t.title ?? "Untitled"}</div>
                      <div className="text-[10px] text-fg-faint">
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
                          className="font-medium text-tone-critical-fg hover:underline"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setConfirmThread(null)}
                          className="text-fg-faint hover:underline"
                        >
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmThread(t.id)}
                        aria-label={`Delete ${t.title ?? "this conversation"}`}
                        className="shrink-0 rounded px-1.5 py-1 text-[11px] text-fg-faint hover:bg-tone-critical/40 hover:text-tone-critical-fg"
                      >
                        <X aria-hidden size={14} strokeWidth={2} />
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
            className="rounded-lg px-2 py-1 text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg-muted lg:hidden"
          >
            <X aria-hidden size={14} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        className="flex-1 space-y-4 overflow-y-auto px-4 py-4 thin-scroll"
      >
        {/* Four invented problems used to sit here — a double-booked
            slot, parts coming off a job. They were written to show what
            the engine can do, and to a shop selling phone cases they
            read as a product for somebody else. A prompt for their own
            words is the honest opening. */}
        {messages.length === 0 && (
          <div className="rise flex min-h-[55%] flex-col items-center justify-center px-4 text-center">
            <LukeMark size="lg" />
            <h2 className="mt-4 text-lg font-semibold text-fg">{LUKE_COPY.emptyTitle}</h2>
            <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed text-fg-muted">{LUKE_COPY.emptyBody}</p>
          </div>
        )}

        {messages.map((m, i) => {
          // A card with anything after it was already answered. Derived
          // from position, not remembered: resolvedCards is session
          // state, so a reloaded thread came back with every old
          // clarify and blueprint looking live again.
          const answered = i < messages.length - 1;
          if (m.role === "user") {
            const editing = editingId === m.id;
            const send = () => {
              const said = editText.trim();
              if (!said || busy) return;
              setEditingId(null);
              void onEditPrompt?.(m.id, said);
            };
            return (
              <div key={m.id} className="rise group flex flex-col items-end" style={RISE}>
                {m.viaClient && (
                  <div className="mb-0.5 pr-1 text-[10px] tracking-wide text-fg-faint uppercase">
                    Asked through your AI
                  </div>
                )}
                {editing ? (
                  <div className="w-full max-w-[85%] rounded-2xl rounded-br-sm border border-line-strong bg-surface p-2">
                    <textarea
                      autoFocus
                      rows={2}
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          send();
                        }
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="w-full resize-none bg-transparent text-sm break-words text-fg outline-none"
                    />
                    <div className="mt-1 flex items-center justify-end gap-3 text-[11px]">
                      <button
                        onClick={() => setEditingId(null)}
                        className="text-fg-muted hover:text-fg"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={send}
                        disabled={!editText.trim() || busy}
                        className="font-medium text-link hover:text-link disabled:text-fg-faint"
                      >
                        Send again
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={`flex max-w-[85%] items-start gap-2 ${m.superseded ? "opacity-45" : ""}`}>
                    {/* Their own words only. A request their assistant
                        made was never typed here, and editing it would
                        put words in Claude's mouth. */}
                    {onEditPrompt && !m.viaClient && !m.superseded && !busy && (
                      <button
                        onClick={() => {
                          setEditingId(m.id);
                          setEditText(m.text ?? "");
                        }}
                        aria-label="Edit this message and send it again"
                        className="mt-2 shrink-0 text-[11px] text-fg-faint opacity-0 transition group-hover:opacity-100 focus:opacity-100 hover:text-fg-muted"
                      >
                        Edit
                      </button>
                    )}
                    {/* break-words, because a request is not always made of
                        words: "(Pending/Packed/Verified/Discrepancy)" is one
                        unbreakable token, and without this it ran straight
                        off the right edge of the panel and was cut in half.
                        Same for a pasted URL or a list of SKUs. */}
                    <div className="rounded-2xl rounded-br-md bg-canvas px-3 py-2 text-[13px] leading-relaxed break-words text-fg">
                      {m.text}
                    </div>
                  </div>
                )}
                {m.superseded && !editing && (
                  <div className="mt-0.5 pr-1 text-[10px] text-fg-faint">replaced by an edit</div>
                )}
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
            // A line of what happened — building, stopped, discarded —
            // in the margin's voice, not a box in the conversation.
            return (
              <div key={m.id} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-fg-faint">
                <span className="w-3.5 shrink-0 text-center">·</span>
                <div className="min-w-0">
                  <div className="break-words">{m.text}</div>
                  {m.errors && m.errors.length > 0 && (
                    <ul className="mt-0.5 list-disc space-y-0.5 pl-4">
                      {m.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            );
          }

          if (m.questions) {
            return (
              <div key={m.id} className="space-y-1">
                {m.trace && <TraceLine trace={m.trace} />}
                <ClarifyCard
                  message={m.text ?? ""}
                  questions={m.questions}
                  done={!!resolvedCards[m.id] || answered || busy}
                  reply={messages[i + 1]?.role === "user" ? messages[i + 1].text : undefined}
                  onSubmit={(composed) => resolveCard(m.id, composed)}
                />
              </div>
            );
          }

          if (m.blueprint) {
            return (
              <div key={m.id} className="space-y-1">
                {m.trace && <TraceLine trace={m.trace} />}
                <BlueprintCard
                  message={m.text ?? ""}
                  blueprint={m.blueprint}
                  modules={modules}
                  currentColumns={currentSchema?.columns}
                  storeFacts={storeFacts}
                  done={!!resolvedCards[m.id] || answered}
                  onApprove={(chosen) => {
                    setResolvedCards((prev) => ({ ...prev, [m.id]: true }));
                    onBuild(chosen, undefined, undefined, m.blueprint?.next);
                  }}
                  onAmend={() => {
                    setInput("Change this in the design: ");
                    inputRef.current?.focus();
                  }}
                />
              </div>
            );
          }

          // Luke talking: an answer, a receipt of a build, a line of
          // history. Plain text, no bubble — the owner's words are the
          // ones in a bubble; Luke's read like the page.
          if (!m.plan) {
            return (
              <div key={m.id} className="space-y-1">
                {m.trace && <TraceLine trace={m.trace} />}
                <div className="text-[13px] leading-relaxed break-words whitespace-pre-line text-fg">{m.text}</div>
                {/* Under the build, which is where they find out it
                    happened — a change made with nobody watching is
                    read here first, and this is the moment they want
                    to say no. It names what goes back, because "undo"
                    on its own does not say how much. */}
                {m.undo && onUndo && (
                  <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-fg-faint">
                    <button
                      onClick={() => putItBack(m.undo!.messageId)}
                      disabled={undoing !== null}
                      className="text-fg-muted transition-colors hover:text-fg hover:underline disabled:opacity-50"
                    >
                      {undoing === m.undo.messageId ? "Putting it back…" : "Put it back"}
                    </button>
                    <span>{m.undo.what.join(", ")}</span>
                  </div>
                )}
                {/* What the design said could come next — said, not
                    offered as buttons: a row of options reads as the
                    only things allowed, and the owner can ask for
                    anything. Only on the last thing in the thread;
                    after a question or a put-back, a suggestion about
                    the app as it was is stale. */}
                {m.next && m.next.length > 0 && i === messages.length - 1 && !busy && (
                  <div className="text-[11px] leading-relaxed text-fg-faint">
                    Next, if you like: {m.next.map((n) => n.label).join(" · ")}
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
                className="rounded-xl border border-line bg-surface-subdued px-3 py-2 text-xs text-fg-muted"
              >
                <span className="font-medium text-fg-muted">Out of date</span> — “
                {plan.newModule?.nav_label ?? plan.explanation}” already changed since this was
                proposed, so there is nothing left to apply.
              </div>
            );
          }

          return (
            <div key={m.id} className="space-y-2.5">
              {m.trace && <TraceLine trace={m.trace} />}
              <div className="text-[11px] tracking-wide text-fg-faint uppercase">
                Proposed change · {plan.changeType.replace("_", " ").toLowerCase()}
              </div>

              <div className="space-y-2.5">
                {m.text ? (
                  <p className="text-[13px] leading-relaxed text-fg">{m.text}</p>
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
                          <p className="text-xs font-medium text-fg">{summary.title}</p>
                          {summary.lines.length > 0 && (
                            <ul className="mt-1 space-y-0.5">
                              {summary.lines.map((line, j) => (
                                <li key={j} className="text-[11px] leading-relaxed text-fg-muted">
                                  {line}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      );
                    })()}
                    <p className="mt-1 text-[11px] text-fg-faint">{plan.explanation}</p>
                  </>
                )}

                {(plan.changeType === "UI_CHANGE" || plan.changeType === "FIELD_ADD") && (
                  <GenericRenderer schema={plan.newSchema} records={records} preview />
                )}

                {plan.changeType === "NEW_MODULE" && plan.newModule && (
                  <>
                    <div className="flex items-center gap-2 rounded-lg bg-surface-subdued px-3 py-2 text-xs text-fg-muted">
                      <Icon name={plan.newModule.icon} size={16} />
                      New module: <b>{plan.newModule.nav_label}</b>
                      <span className="text-fg-faint">({plan.newModule.name})</span>
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
                  <div className="space-y-1.5 rounded-lg bg-surface-subdued px-3 py-2 text-xs text-fg-muted">
                    {plan.moduleUpdate.nav_label && (
                      <div>
                        <Pencil aria-hidden size={12} className="mr-1 inline align-[-1px]" />Rename: <b>{targetModule?.nav_label}</b> → <b>{plan.moduleUpdate.nav_label}</b>
                      </div>
                    )}
                    {plan.moduleUpdate.icon && (
                      <div>
                        Icon: <Icon name={targetModule?.icon} size={14} className="inline" /> →{" "}
                        <Icon name={plan.moduleUpdate.icon} size={14} className="inline" />
                      </div>
                    )}
                    {plan.moduleUpdate.sort_order !== undefined && (
                      <div>↕ Sidebar position: sort_order {plan.moduleUpdate.sort_order}</div>
                    )}
                  </div>
                )}

                {plan.changeType === "MODULE_DELETE" && targetModule && (
                  <div className="rounded-lg border border-tone-critical/70 bg-tone-critical/40 px-3 py-2 text-xs text-tone-critical-fg">
                    <div className="font-semibold">
                      <TriangleAlert aria-hidden size={13} className="mr-1 inline align-[-2px]" />Delete “{targetModule.nav_label}” and all its records?
                    </div>
                    <div className="mt-1">
                      Type <b>“{targetModule.nav_label}”</b> below to confirm.
                    </div>
                  </div>
                )}

                {plan.changeType === "FEATURE_UPDATE" && (
                  <>
                    <ul className="space-y-1 rounded-lg bg-surface-subdued px-3 py-2 text-xs text-fg-muted">
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
                  <div className="rounded-lg border border-tone-success bg-tone-success/30 px-3 py-2.5">
                    <div className="text-[11px] font-semibold text-tone-success-fg">
                      <Zap aria-hidden size={12} className="mr-1 inline align-[-1px]" />{plan.automation.name}
                    </div>
                    <ul className="mt-1 space-y-0.5">
                      {describeAutomation(plan.automation, modules).map((line, i) => (
                        <li key={i} className="text-[11px] leading-relaxed text-tone-success-fg">
                          {line}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-1.5 text-[10px] text-tone-success-fg/70">
                      Runs on every change to this section, from anywhere.
                    </div>
                  </div>
                )}

                {plan.changeType === "AUTOMATION_REMOVE" && (
                  <div className="rounded-lg border border-line bg-surface-subdued px-3 py-2 text-[11px] text-fg-muted">
                    Turns off the rule “{plan.automationRemoveName}”. Its history stays visible.
                  </div>
                )}

                {plan.changeType === "RECORD_SEED" && (
                  <div className="overflow-x-auto rounded-lg border border-line thin-scroll">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-line bg-surface-subdued text-fg-muted">
                          {Object.keys(plan.newRecords?.[0] ?? {}).map((k) => (
                            <th key={k} className="px-2.5 py-1.5 font-semibold">
                              {k}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(plan.newRecords ?? []).map((row, i) => (
                          <tr key={i} className="border-b border-line last:border-0">
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
                      className="w-full rounded-lg border border-tone-critical/70 px-3 py-1.5 text-xs outline-none focus:border-tone-critical focus:ring-2 focus:ring-tone-critical/60"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => apply(plan, m.id)}
                        disabled={
                          isPending ||
                          (deleteConfirm[m.id] ?? "").trim().toLowerCase() !==
                            targetModule.nav_label.toLowerCase()
                        }
                        className="flex-1 rounded-lg bg-critical px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-critical-hover disabled:opacity-40"
                      >
                        {answered ? "Dealt with" : isPending ? "Deleting…" : "Delete module"}
                      </button>
                      <button
                        onClick={() => onDiscard(m.id)}
                        disabled={isPending}
                        className="flex-1 rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-hover disabled:opacity-50"
                      >
                        Discard
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => apply(plan, m.id)}
                      disabled={isPending}
                      className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
                    >
                      {answered ? "Dealt with" : isPending ? "Applying…" : "Apply this"}
                    </button>
                    <button
                      onClick={() => onDiscard(m.id)}
                      disabled={isPending}
                      className="text-xs text-fg-muted transition-colors hover:text-fg hover:underline disabled:opacity-50"
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
          <div className="text-[11px] text-fg-faint">
            {/* One line: the step the server is on right now, with the
                seconds climbing beside it, and the steps already taken
                behind a caret. Nothing here is on a timer — a turn
                that stalls shows a line that stays put. */}
            <button
              onClick={() => setStepsOpen((o) => !o)}
              className="flex max-w-full items-center gap-1.5 text-left hover:text-fg-muted"
            >
              <LukeMark size="xs" state="thinking" />
              <span className="shimmer min-w-0 truncate">
                {steps.length ? stepWords(steps[steps.length - 1]) : "Working on it…"}
              </span>
              {stepSeconds >= 2 && <span className="shrink-0 tabular-nums text-fg-faint">{stepSeconds}s</span>}
              {steps.length > 1 && (
                <ChevronRight aria-hidden size={13} strokeWidth={2} className={`shrink-0 text-fg-faint transition-transform duration-150 ${stepsOpen ? "rotate-90" : ""}`} />
              )}
            </button>
            {stepsOpen && steps.length > 1 && (
              <ul className="mt-1 space-y-0.5 pl-3 text-fg-faint">
                {steps.slice(0, -1).map((s, i) => (
                  <li key={i} className="flex items-center gap-1.5 truncate"><Check aria-hidden size={12} strokeWidth={2.25} className="shrink-0 text-tone-success-fg" />{stepWords(s)}</li>
                ))}
              </ul>
            )}
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
                className="pointer-events-auto rounded-xl border border-tone-attention bg-tone-attention/25 p-3 shadow-lg"
              >
                <div className="flex items-start gap-2">
                  <Sparkles aria-hidden size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-tone-attention-fg" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-semibold tracking-widest text-tone-attention-fg uppercase">
                      Your AI asked for this
                    </div>
                    <p className="mt-0.5 line-clamp-3 text-[11px] leading-relaxed text-tone-attention-fg">
                      {r.request}
                    </p>
                  </div>
                  <button
                    onClick={() => setToasts((p) => p.filter((x) => x !== id))}
                    aria-label="Later"
                    className="shrink-0 text-[11px] text-tone-attention-fg hover:text-tone-attention-fg"
                  >
                    <X aria-hidden size={14} strokeWidth={2} />
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {/* Not offered for a design that removes a section.
                      buildRequest refuses one until the name has been
                      typed, and there is nowhere to type it here — so
                      the button did nothing at all when it was
                      tapped. "See it" opens the card that can. */}
                  {r.plans?.length && !removalsIn(r.plans).length ? (
                    <button
                      onClick={() => {
                        setToasts((p) => p.filter((x) => x !== id));
                        buildRequest(r);
                      }}
                      disabled={busy}
                      className="rounded-lg bg-primary px-2 py-1 text-[10px] font-medium text-white hover:bg-primary-hover disabled:opacity-40"
                    >
                      {WAITING_BUTTONS.build}
                    </button>
                  ) : null}
                  <button
                    onClick={() => {
                      setToasts((p) => p.filter((x) => x !== id));
                      setBellOpen(true);
                    }}
                    className="rounded-lg border border-tone-attention px-2 py-1 text-[10px] font-medium text-tone-attention-fg hover:bg-tone-attention/40"
                  >
                    See it
                  </button>
                  <button
                    onClick={() => {
                      setToasts((p) => p.filter((x) => x !== id));
                      dismissRequest(r.id);
                    }}
                    className="ml-auto text-[10px] text-tone-attention-fg hover:underline"
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
          className="group/ai border-t border-line px-3 py-2.5"
          open={ownAiOpen || !features.chat}
          onToggle={(e) => setOwnAiOpen((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="flex cursor-pointer list-none items-center gap-2.5 text-xs text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden">
            {/* The marks of what is connected; before anything is, the two
                it can be. */}
            <span aria-hidden className="flex -space-x-1.5">
              {(() => {
                const theirs = [...new Set(assistants.map((c) => assistantLogo(c.name)).filter((l): l is string => !!l))];
                return theirs.length ? theirs : ["/logos/claude.svg", "/logos/openai.svg"];
              })().map((src) => (
                <span key={src} className="flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface shadow-card">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a small SVG, nothing to optimise */}
                  <img src={src} alt="" width={13} height={13} className="h-3.5 w-3.5 object-contain" />
                </span>
              ))}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-fg">{LUKE_COPY.ownAi}</span>
            {assistants.length > 0 && (
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-fg-muted">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    assistants.some((c) => c.calls24h > 0) ? "bg-signal-success" : "bg-line-strong"
                  }`}
                />
                {assistants.length} connected
              </span>
            )}
            <ChevronRight
              aria-hidden
              size={14}
              strokeWidth={2}
              className="shrink-0 text-fg-faint transition-transform duration-150 group-open/ai:rotate-90"
            />
          </summary>

          <div className="mt-2.5 space-y-2.5">
            <p className="text-xs leading-relaxed text-fg-muted">
              Add Warmluke as a custom connector with this address. It reads your store, and
              anything it wants to build comes back here for you to approve.
            </p>
            <div className="flex items-center gap-1 rounded-control border border-line bg-surface-subdued py-1 pr-1 pl-2.5">
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg" title={mcpUrl}>
                {mcpUrl}
              </code>
              <button
                onClick={() =>
                  navigator.clipboard
                    ?.writeText(mcpUrl)
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1600);
                    })
                    .catch(() => {})
                }
                className={button("secondary", "sm")}
              >
                {copied ? (
                  <Check aria-hidden size={13} strokeWidth={2.25} className="text-signal-success" />
                ) : (
                  <Copy aria-hidden size={13} strokeWidth={2} />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            {assistants.length > 0 && (
              <ul className="overflow-hidden rounded-card border border-line">
                {assistants.map((c) => {
                  const working = c.calls24h > 0;
                  const logo = assistantLogo(c.name);
                  // Working, as opposed to merely allowed: a key unused
                  // for a month looks the same as one in use, and only
                  // one of those is worth keeping.
                  const status = c.lastCall
                    ? `${working ? "Working" : "Quiet"} · last used ${since(c.lastCall)}${working ? ` · ${c.calls24h} today` : ""}`
                    : "Connected, not used yet";
                  return (
                    <li key={c.name} className="flex items-center gap-2.5 border-b border-line px-2.5 py-2 last:border-b-0">
                      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-line bg-surface">
                        {logo ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a small SVG, nothing to optimise
                          <img src={logo} alt="" width={16} height={16} className="h-4 w-4 object-contain" />
                        ) : (
                          <Plug aria-hidden size={14} strokeWidth={1.75} className="text-fg-muted" />
                        )}
                        <span
                          className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${
                            working ? "bg-signal-success" : "bg-line-strong"
                          }`}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium text-fg">{c.name}</span>
                          {/* Said once, here, because otherwise five rows
                              appear and look like five separate grants. */}
                          {c.count > 1 && (
                            <span
                              title={`${c.count} connections, disconnected together`}
                              className="shrink-0 rounded-full bg-surface-subdued px-1.5 text-[10px] text-fg-muted tabular-nums"
                            >
                              ×{c.count}
                            </span>
                          )}
                        </div>
                        <div className="truncate text-[11px] text-fg-faint" title={status}>
                          {status}
                        </div>
                      </div>
                      {/* Worth a pause (the assistant stops mid-sentence and
                          reconnecting means consent again), so the second
                          tap is the confirmation. */}
                      {confirmRevoke === c.name ? (
                        <span className="flex shrink-0 items-center gap-1">
                          <button
                            onClick={() => {
                              setConfirmRevoke(null);
                              revoke(c);
                            }}
                            className={button("critical", "sm")}
                          >
                            Disconnect
                          </button>
                          <button onClick={() => setConfirmRevoke(null)} className={button("plain", "sm")}>
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmRevoke(c.name)}
                          disabled={revoking === c.name}
                          className={button("critical-plain", "sm")}
                        >
                          {revoking === c.name ? "Disconnecting…" : "Disconnect"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </details>
      )}

      {/* What their own AI asked for, where they are already looking.
          It is not a turn in the conversation — that was tried, and a
          card that cannot be scrolled past is worse than a bell
          nobody taps — and it is not a toast either, because a toast
          only fires for something that arrives while the tab is
          open, and the usual case is the opposite: they were in
          Claude, and they come here afterwards. So: one line, above
          the composer, outside the scroll, gone the moment they say
          so. */}
      {pendingCount > 0 && !bellOpen && waitingKey !== noticeCleared && (
        <div className="flex items-center gap-2 border-t border-tone-attention/70 bg-tone-attention/25 px-3 py-1.5 text-[11px] text-tone-attention-fg">
          <span className="min-w-0 flex-1 truncate">
            Your AI asked for {pendingCount} {pendingCount === 1 ? "change" : "changes"}
          </span>
          <button
            onClick={() => setBellOpen(true)}
            className="shrink-0 font-medium text-tone-attention-fg underline underline-offset-2 hover:text-tone-attention-fg"
          >
            Open
          </button>
          <button
            onClick={() => setNoticeCleared(waitingKey)}
            aria-label="Hide this until something else arrives"
            className="shrink-0 px-1 text-tone-attention-fg hover:text-tone-attention-fg"
          >
            <X aria-hidden size={14} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* Input */}
      {turns && !turns.unlimited && turns.used >= turns.free && features.chat ? (
        // Not a locked door with a price on it. What they can still
        // do is the larger half — reading their store never costs us
        // anything — so it is offered first, by name.
        <div className="border-t border-line p-3">
          <div className="rounded-xl border border-line bg-surface-subdued p-3">
            <div className="text-[11px] font-semibold text-fg">
              You have used all {turns.free} included {turns.free === 1 ? "design" : "designs"}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">
              Asking about your store still works, and anything already designed can still
              be built. Designing something new is the part that needs Warmluke AI.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setWantsPlan(true)}
                className="rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-primary-hover"
              >
                Get Warmluke AI
              </button>
              {features.mcp && (
                <button
                  onClick={() => {
                    setWantsPlan(false);
                    setOwnAiOpen(true);
                  }}
                  className="rounded-lg border border-line-strong px-2.5 py-1.5 text-[11px] font-medium text-fg hover:bg-surface"
                >
                  Use your own Claude
                </button>
              )}
            </div>
            {wantsPlan && (
              <div className="mt-2.5 rounded-lg border border-line bg-surface px-2.5 py-2 text-[11px] leading-relaxed text-fg-muted">
                Still being built — it releases soon. Until then your own Claude or ChatGPT
                does the asking, and Warmluke keeps building what you have already approved.
                <button
                  onClick={() => setWantsPlan(false)}
                  className="mt-1.5 block text-[10px] text-fg-faint hover:underline"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      ) : !features.chat ? (
        <div className="border-t border-line p-3 text-[11px] leading-relaxed text-fg-muted">
          Luke is off for this account.{" "}
          {features.mcp
            ? "Your own AI can still design changes, and you approve them above."
            : "Ask us to turn Luke on for you."}
        </div>
      ) : (
      <div className="border-t border-line p-3">
        {/* One quiet box: the words inside it, the send inside it. A
            thick ring and a labelled button made the composer the
            loudest thing on the panel, and the conversation should be. */}
        {/* While Luke works, a beam of its colour goes round the box;
            while they type, a beam in the page's ink, flaring with each
            key. Focused, the border takes Luke's colour. */}
        <div
          data-stroke={strokes % 2}
          className={`flex items-end gap-2 rounded-2xl border border-line bg-surface px-3 py-2 shadow-card transition-all duration-150 focus-within:border-luke-light focus-within:shadow-[0_0_0_3px_rgb(139_126_255/0.14)] ${
            busy ? "beam" : typing ? "beam beam-ink" : ""
          }`}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setStrokes((n) => n + 1);
              setTyping(true);
              if (typingTimer.current) clearTimeout(typingTimer.current);
              typingTimer.current = setTimeout(() => setTyping(false), 1200);
              // Grows with what is typed, up to a few lines, and
              // shrinks back; a fixed two rows was mostly empty.
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            placeholder={LUKE_COPY.placeholder}
            className="max-h-40 flex-1 resize-none bg-transparent py-0.5 text-[13px] leading-6 text-fg outline-none placeholder:text-fg-faint"
          />
          <button
            onClick={() => (canStop ? onStop() : send())}
            disabled={busy && !canStop ? true : !canStop && !input.trim()}
            aria-label={canStop ? "Stop" : "Send"}
            title={canStop ? "Stop" : busy ? "Building…" : "Send"}
            className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary transition-all duration-150 hover:bg-primary-hover active:scale-95 disabled:bg-line-strong disabled:text-surface"
          >
            {canStop ? (
              <Square aria-hidden size={11} strokeWidth={0} fill="currentColor" />
            ) : (
              <ArrowUp aria-hidden size={16} strokeWidth={2.25} />
            )}
          </button>
        </div>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 text-[10px] text-fg-faint">
          <span>{LUKE_COPY.promise}</span>
          {/* From the engine's own registry, one tap away rather than
              repeated on every design. The assistant is told to flag
              anything it cannot do, but a prompt instruction is not a
              guarantee; the list is here whether or not it mentions it. */}
          <details className="group">
            <summary className="cursor-pointer list-none select-none hover:text-fg-muted">
              What Luke can&rsquo;t do
<ChevronRight aria-hidden size={11} strokeWidth={2} className="ml-0.5 inline align-[-1px] transition-transform duration-150 group-open:rotate-90" />
            </summary>
            <ul className="mt-1 space-y-0.5 pl-3">
              {NOT_SUPPORTED.map((n) => (
                <li key={n.id}>{n.label}</li>
              ))}
            </ul>
          </details>
        </div>
      </div>
      )}
    </aside>
  );
}
