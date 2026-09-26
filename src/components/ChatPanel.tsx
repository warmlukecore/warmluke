"use client";

// ─────────────────────────────────────────────────────────────
// ChatPanel — presentational assistant panel. State and actions
// live in AppShell so the first-build flow can drive messages.
// Deletion always requires typing the module's name.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  ThreadSummary,
  TurnEvent,
  UiSchema,
} from "@/lib/types";
import { ago, dayGroup } from "@/lib/when";
import { TITLE_MAX } from "@/lib/types";
import { Icon } from "@/components/ui/Icon";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Check,
  ChevronRight,
  Circle,
  Columns3,
  CircleDot,
  Copy,
  CornerDownRight,
  Hand,
  History,
  LayoutGrid,
  ListChecks,
  LoaderCircle,
  type LucideIcon,
  Minus,
  Pencil,
  Plug,
  Rows3,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  SquareCheck,
  SquarePen,
  Store,
  Table,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
  Zap,
  ZapOff,
} from "lucide-react";
import { button, fieldOf } from "@/components/ui/controls";
import { LukeMark } from "@/components/ui/LukeMark";
import { Markdown } from "@/components/ui/Markdown";
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
  /** Two questions that do not lean on each other, asked at once. */
  together?: boolean;
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
  /** A build from the chat still running, as its thread says, and since when. */
  building?: { startedAt: string };
  /** On a design card: what became of its build, as its thread recorded it. */
  built?: BuildRecord;
}

/**
 * A build of a design card, as the server wrote it into the thread
 * (/api/apply): which of the card's plans were sent, and how it ended.
 * "unknown" is one that never said how it ended.
 */
export type BuildRecord = {
  status: "building" | "built" | "refused" | "unknown";
  sent: number[];
  failedAt?: number;
  errors?: string[];
};

/**
 * The steps a turn took, folded into one quiet line above the reply:
 * "Read your store · thought it through · 14s", with every step behind
 * a caret. The words are this panel's; the steps and the time are not.
 */
function TraceLine({ trace }: { trace: { steps: TurnEvent[]; ms: number } }) {
  const parts: string[] = [];
  const store = trace.steps.find((s) => s.step === "store");
  if (store) parts.push(store.shop ? "Read your store" : "Read your app");
  const looked = trace.steps.filter((s) => s.step === "lookup").length;
  if (looked) parts.push(looked === 1 ? "looked one thing up" : `looked ${looked} things up`);
  if (trace.steps.some((s) => s.step === "proposed")) parts.push("asked for your yes");
  const tries = trace.steps.filter((s) => s.step === "model").length;
  if (tries === 1) parts.push("thought it through");
  else if (tries > 1) parts.push(`took ${tries} tries`);
  if (trace.steps.some((s) => s.step === "gaps")) parts.push("checked for gaps");
  if (parts.length === 0) return null;
  const secs = Math.max(1, Math.round(trace.ms / 1000));
  return (
    <details className="group text-[11px] text-fg-faint">
      <summary className="cursor-pointer list-none select-none truncate hover:text-fg-muted">
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={2}
          className="inline shrink-0 align-[-2px] transition-transform duration-150 group-open:rotate-90"
        />
        {parts.join(" · ")} · {secs}s
      </summary>
      <ul className="mt-0.5 space-y-0.5 pl-3.5 text-fg-faint">
        {trace.steps.map((s, i) => (
          <StepRow key={i} step={s} />
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

/** Past conversations found by name once there are more than this many. */
const THREADS_BEFORE_SEARCH = 5;

/** Under a past conversation's name: when it last moved, and what it holds. */
function threadLine(t: ThreadSummary, now: number): string {
  const built = t.built ?? 0;
  const answers = t.answers ?? 0;
  return [
    ago(t.updated_at, now),
    built > 0 ? `${built} built` : null,
    answers > 0 ? `${answers} answer${answers === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

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
/** What each step of a turn was, as a mark beside its words. */
const STEP_MARK: Record<TurnEvent["step"], LucideIcon> = {
  accepted: CornerDownRight,
  store: Store,
  context: LayoutGrid,
  model: Sparkles,
  lookup: Search,
  proposed: Hand,
  checked: ShieldCheck,
  gaps: ListChecks,
};

/** A step already taken: its mark and its words, in the margin's voice. */
function StepRow({ step }: { step: TurnEvent }) {
  const Mark = step.step === "checked" && step.problems > 0 ? TriangleAlert : STEP_MARK[step.step];
  return (
    <li className="flex items-center gap-1.5 truncate">
      <Mark aria-hidden size={12} strokeWidth={2} className="shrink-0 text-fg-faint" />
      {stepWords(step)}
    </li>
  );
}

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
    case "lookup":
      return `Looked up ${step.about}`;
    case "proposed":
      return `Asked for your yes: ${step.summary}`;
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
function answersFromReply(text: string, questions: ClarifyQuestion[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { q, a } of answerPairs(text) ?? []) {
    const match = questions.find((x) => x.question.trim() === q);
    if (match && a && a !== SKIPPED) out[match.id] = a;
  }
  return out;
}

/** What a skipped question is sent as. */
const SKIPPED = "(skipped)";

/**
 * A reply to Luke's questions, as the pairs it was sent in ("Question"
 * and "→ answer" under it, a blank line between), or null for any
 * other message.
 */
function answerPairs(text: string): Array<{ q: string; a: string }> | null {
  const pairs = text.split("\n\n").map((block) => {
    const at = block.indexOf("\n\u2192 ");
    return at < 0 ? null : { q: block.slice(0, at).trim(), a: block.slice(at + 3).trim() };
  });
  return pairs.length > 0 && pairs.every((x) => x !== null) ? (pairs as Array<{ q: string; a: string }>) : null;
}

/**
 * Their answers in their bubble: each question small, its answer under
 * it. Sent as "Question\n→ answer" so Luke reads which answer is whose;
 * shown that way it was one run-on line of arrows.
 */
function AnswerSummary({ pairs }: { pairs: Array<{ q: string; a: string }> }) {
  return (
    <dl className="space-y-1.5">
      {pairs.map(({ q, a }, k) => (
        <div key={k}>
          <dt className="text-[11px] leading-snug text-fg-muted">{q}</dt>
          <dd className={a === SKIPPED ? "text-fg-faint" : ""}>{a === SKIPPED ? "Skipped" : a}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Luke's words, to paste elsewhere: as written, Markdown and all, the way chat apps copy. */
function CopyReply({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      onClick={() =>
        navigator.clipboard
          ?.writeText(text)
          .then(() => setCopied(true))
          .catch(() => {})
      }
      aria-label={copied ? "Copied" : "Copy this reply"}
      title={copied ? "Copied" : "Copy"}
      className="-ml-1 inline-flex h-6 items-center gap-1 rounded-control px-1 text-[11px] text-fg-faint transition-colors hover:bg-surface-hover hover:text-fg-muted"
    >
      {copied ? <Check aria-hidden size={13} strokeWidth={2} /> : <Copy aria-hidden size={13} strokeWidth={2} />}
      {copied && <span>Copied</span>}
    </button>
  );
}

/** What is being written once the words are done, in the panel's words. */
const PHASE_WORDS: Record<string, string> = {
  questions: "Writing the questions…",
  design: "Laying out the design…",
  change: "Writing the change…",
  next: "Picking what you might ask next…",
};

/**
 * What they might ask next, as Luke offered it: a line of words each,
 * with the way to send it, sent as written when tapped. Lines rather
 * than a row of chips, which read as the only things allowed; the box
 * below still takes anything.
 */
function FollowUps({ next, onPick }: { next: NextStep[]; onPick: (prompt: string) => void }) {
  return (
    <div role="group" aria-label="Ask next" className="space-y-1 pt-1">
      {next.map((n) => (
        <button
          key={n.prompt}
          onClick={() => onPick(n.prompt)}
          title={n.prompt}
          aria-label={`Ask: ${n.prompt}`}
          className="group flex w-full items-center gap-2 rounded-control border border-line bg-surface px-2.5 py-1.5 text-left text-[12px] text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
        >
          <span className="min-w-0 flex-1 truncate">{n.label}</span>
          <ArrowUp
            aria-hidden
            size={13}
            strokeWidth={2}
            className="shrink-0 text-fg-faint transition-colors group-hover:text-fg"
          />
        </button>
      ))}
    </div>
  );
}

/**
 * Luke's questions, asked the way they depend on each other: one
 * question on its own; two that do not lean on each other together; any
 * other two, and three or more, one at a time, because an answer to an
 * earlier one changes what the later ones mean. Each question is its
 * suggestions as rows to pick, one or several as the question says, and
 * a line of their own for anything else. Still a message, not a form:
 * Luke's words, then the question, then small actions.
 */
function ClarifyCard({
  message,
  questions,
  together,
  done,
  reply,
  onSubmit,
}: {
  message: string;
  questions: ClarifyQuestion[];
  together?: boolean;
  done: boolean;
  reply?: string;
  onSubmit: (composed: string) => void;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [at, setAt] = useState(0);
  const prior = useMemo(() => (reply ? answersFromReply(reply, questions) : {}), [reply, questions]);
  const stepped = questions.length > 2 || (questions.length === 2 && !together);
  const answerOf = (id: string) => [...(picked[id] ?? []), (typed[id] ?? "").trim()].filter(Boolean).join(", ");
  const shown = (id: string) => answerOf(id) || (prior[id] ?? "");
  const answered = questions.filter((q) => answerOf(q.id));

  const choose = (q: ClarifyQuestion, option: string) =>
    setPicked((prev) => {
      const cur = prev[q.id] ?? [];
      const on = cur.includes(option);
      const next = q.multi ? (on ? cur.filter((x) => x !== option) : [...cur, option]) : on ? [] : [option];
      return { ...prev, [q.id]: next };
    });

  function submit() {
    if (answered.length === 0) return;
    const composed = questions
      .map((q) => {
        const a = answerOf(q.id);
        return `${q.question}\n→ ${a || SKIPPED}`;
      })
      .join("\n\n");
    onSubmit(composed);
  }

  if (done) {
    return (
      <div className="space-y-2">
        <Markdown>{message}</Markdown>
        <ul className="space-y-1">
          {questions.map((q) => (
            <li key={q.id} className="text-[12px] leading-relaxed">
              <span className="text-fg-muted">{q.question}</span>{" "}
              <span className="text-fg">→ {shown(q.id) || "Skipped"}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // Number keys pick a suggestion of the question in view, and Enter on
  // one moves on. Only while the card has focus, so typing in the
  // composer is never read as a pick; their own line keeps its keys.
  const keysFor = (q: ClarifyQuestion, onEnter: () => void) => (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
    const options = q.suggestions ?? [];
    const n = Number(e.key);
    if (Number.isInteger(n) && n >= 1 && n <= Math.min(options.length, 9)) {
      e.preventDefault();
      choose(q, options[n - 1]);
    } else if (e.key === "Enter" && /^(radio|checkbox)$/.test(target.getAttribute("role") ?? "")) {
      e.preventDefault();
      onEnter();
    }
  };

  const ask = (q: ClarifyQuestion, onEnter: () => void, numbered = false) => (
    <QuestionRows
      key={q.id}
      numbered={numbered}
      question={q}
      picked={picked[q.id] ?? []}
      typed={typed[q.id] ?? ""}
      onChoose={(o) => choose(q, o)}
      onType={(t) => setTyped((prev) => ({ ...prev, [q.id]: t }))}
      onEnter={onEnter}
    />
  );

  if (!stepped) {
    const one = questions.length === 1;
    return (
      <div
        role="group"
        aria-label="Luke's questions"
        onKeyDown={one ? keysFor(questions[0], submit) : undefined}
        className="space-y-3"
      >
        <Markdown>{message}</Markdown>
        {questions.map((q) => ask(q, submit, one))}
        <button onClick={submit} disabled={answered.length === 0} className={button("primary", "sm")}>
          {questions.length === 1 ? "Send answer" : "Send answers"}
        </button>
      </div>
    );
  }

  const q = questions[at];
  const last = at === questions.length - 1;
  const forward = () => (last ? submit() : setAt(at + 1));
  return (
    <div role="group" aria-label="Luke's questions" onKeyDown={keysFor(q, forward)} className="space-y-3">
      <Markdown>{message}</Markdown>
      <div className="flex items-center gap-2 text-[11px] text-fg-faint" aria-live="polite">
        <span className="tabular-nums">
          {at + 1} of {questions.length}
        </span>
        <span aria-hidden className="flex gap-1">
          {questions.map((x, k) => (
            <span
              key={x.id}
              className={`h-1 w-3 rounded-full ${k === at ? "bg-fg-muted" : answerOf(x.id) ? "bg-fg-faint" : "bg-line"}`}
            />
          ))}
        </span>
      </div>
      {ask(q, forward, true)}
      <div className="flex items-center gap-2">
        {at > 0 && (
          <button onClick={() => setAt(at - 1)} className={button("plain", "sm")}>
            Back
          </button>
        )}
        <span className="flex-1" />
        {!answerOf(q.id) && !last && (
          <button onClick={() => setAt(at + 1)} className={button("plain", "sm")}>
            Skip
          </button>
        )}
        <button
          onClick={forward}
          disabled={last ? answered.length === 0 : false}
          className={button(answerOf(q.id) || last ? "primary" : "secondary", "sm")}
        >
          {last ? "Send answers" : "Next"}
        </button>
      </div>
    </div>
  );
}

/**
 * One question: its suggestions as rows to pick, a round mark for one
 * answer and a square for several, and a line for anything else. Enter
 * in that line moves on.
 */
function QuestionRows({
  question,
  numbered = false,
  picked,
  typed,
  onChoose,
  onType,
  onEnter,
}: {
  question: ClarifyQuestion;
  /** Each suggestion shows the number key that picks it. */
  numbered?: boolean;
  picked: string[];
  typed: string;
  onChoose: (option: string) => void;
  onType: (text: string) => void;
  onEnter: () => void;
}) {
  const many = question.multi === true;
  return (
    <div className="space-y-1.5">
      <div className="text-[13px] leading-relaxed font-medium text-fg">{question.question}</div>
      {question.why && <div className="text-[11px] leading-relaxed text-fg-faint">{question.why}</div>}
      <div role={many ? "group" : "radiogroup"} aria-label={question.question} className="space-y-1">
        {(question.suggestions ?? []).map((option, k) => {
          const on = picked.includes(option);
          const Mark = many ? (on ? SquareCheck : Square) : on ? CircleDot : Circle;
          return (
            <button
              key={option}
              role={many ? "checkbox" : "radio"}
              aria-checked={on}
              onClick={() => onChoose(option)}
              className={`flex w-full items-center gap-2 rounded-control border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                on
                  ? "border-fg-muted bg-surface-subdued font-medium text-fg"
                  : "border-line text-fg-muted hover:border-line-strong hover:text-fg"
              }`}
            >
              <Mark aria-hidden size={14} strokeWidth={2} className={`shrink-0 ${on ? "text-fg" : "text-fg-faint"}`} />
              <span className="min-w-0 flex-1">{option}</span>
              {numbered && k < 9 && (
                <kbd
                  aria-hidden
                  className="shrink-0 font-sans text-[10px] text-fg-faint tabular-nums pointer-coarse:hidden"
                >
                  {k + 1}
                </kbd>
              )}
            </button>
          );
        })}
      </div>
      <input
        value={typed}
        onChange={(e) => onType(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
        placeholder={(question.suggestions?.length ?? 0) > 0 ? "Something else…" : "Type your answer"}
        aria-label={`Your own answer: ${question.question}`}
        className={`${fieldOf("sm")} w-full`}
      />
      {many && <div className="text-[10px] text-fg-faint">Pick any that apply</div>}
    </div>
  );
}

/**
 * Where one plan of a design stands. Each state carries only what is
 * true in it (a reason only where something was refused), and the line
 * that draws it is an exhaustive switch, so a state cannot be added
 * without saying what it looks like.
 */
type PlanStatus =
  | { kind: "ready" }
  /** Unticked, or it needs a section that was. */
  | { kind: "left-out" }
  /** Built since the design was written. */
  | { kind: "already-there" }
  /** The section it changes was removed since. */
  | { kind: "section-gone" }
  | { kind: "building" }
  | { kind: "built" }
  | { kind: "refused"; why: string }
  /** Built, then undone because a later one was refused: a design stands whole or not at all. */
  | { kind: "put-back" }
  /** After the refused one, so never tried. */
  | { kind: "not-tried" }
  /** The answer never came back. */
  | { kind: "unknown" };

/**
 * Whether the world has moved on from this plan, as the single-plan
 * card already asks: a section it would make is there, or the one it
 * changes is gone. A "#slug" is a section made earlier in the same
 * design, so it is not looked for here.
 */
function staleness(plan: AssistantPlan, modules: ModuleRow[]): "already-there" | "section-gone" | null {
  if (plan.changeType === "NEW_MODULE") {
    return plan.newModule && modules.some((m) => m.name === plan.newModule!.name) ? "already-there" : null;
  }
  const target = plan.targetModuleId;
  return target && !target.startsWith("#") && !modules.some((m) => m.id === target) ? "section-gone" : null;
}

/** A plan's state in words, with a mark that says the same. */
function PlanStatusLine({ status }: { status: PlanStatus }) {
  const line = (Mark: LucideIcon, text: string, tone: string, spin = false) => (
    <div className={`mt-0.5 flex items-start gap-1 text-[11px] leading-relaxed ${tone}`}>
      <Mark
        aria-hidden
        size={12}
        strokeWidth={2}
        className={`mt-[3px] shrink-0 ${spin ? "motion-safe:animate-spin" : ""}`}
      />
      <span className="min-w-0 line-clamp-2" title={text}>
        {text}
      </span>
    </div>
  );
  switch (status.kind) {
    case "ready":
    case "left-out":
      return null;
    case "already-there":
      return line(Check, "Already in your app", "text-fg-faint");
    case "section-gone":
      return line(TriangleAlert, "Its section was removed, so this is left out", "text-tone-attention-fg");
    case "building":
      return line(LoaderCircle, "Building", "text-fg-muted", true);
    case "built":
      return line(Check, "Built", "text-tone-success-fg");
    case "refused":
      return line(X, `Did not fit: ${status.why}`, "text-tone-critical-fg");
    case "put-back":
      return line(Undo2, "Put back, so nothing is left half built", "text-fg-faint");
    case "not-tried":
      return line(Minus, "Not built", "text-fg-faint");
    case "unknown":
      return line(TriangleAlert, "Not known yet: reload to see", "text-tone-attention-fg");
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

/**
 * A build the thread says is running, with the seconds it has run. Read
 * from the thread, so a panel opened mid-build shows it too; the line
 * is replaced by the receipt when the thread says how it ended.
 */
/** The list's padding (py-4), and how far below its top a sent message is pinned. */
const LIST_PAD = 16;
const PIN_GAP = 12;

function BuildingLine({ text, startedAt }: { text: string; startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000));
  return (
    <div role="status" className="flex items-center gap-1.5 text-[12px] text-fg-muted">
      <LoaderCircle aria-hidden size={13} strokeWidth={2} className="shrink-0 motion-safe:animate-spin" />
      <span>{text}</span>
      {Number.isFinite(seconds) && <span className="text-fg-faint tabular-nums">{seconds}s</span>}
    </div>
  );
}

/** A recorded build, as the outcome the card reads for one it built itself. */
function outcomeOf(r: BuildRecord): BuildOutcome | undefined {
  switch (r.status) {
    case "building":
      return undefined;
    case "built":
      return { applied: r.sent.map(() => ({})), errors: [] };
    case "refused":
      return { applied: [], errors: r.errors ?? [], ...(r.failedAt !== undefined ? { failedAt: r.failedAt } : {}) };
    case "unknown":
      return { applied: [], errors: [], unknown: true };
    default: {
      const unreachable: never = r.status;
      return unreachable;
    }
  }
}

/** What kind of change a plan is: the mark its row leads with, and the word under its name. */
const PLAN_KIND: Record<AssistantPlan["changeType"], { mark: LucideIcon; word: string }> = {
  NEW_MODULE: { mark: Table, word: "New section" },
  FIELD_ADD: { mark: Columns3, word: "New fields" },
  UI_CHANGE: { mark: Columns3, word: "Layout" },
  MODULE_UPDATE: { mark: Pencil, word: "Section settings" },
  MODULE_DELETE: { mark: Trash2, word: "Removed with its rows" },
  FEATURE_UPDATE: { mark: SlidersHorizontal, word: "How it works" },
  RECORD_SEED: { mark: Rows3, word: "Rows" },
  AUTOMATION_ADD: { mark: Zap, word: "Rule" },
  AUTOMATION_REMOVE: { mark: ZapOff, word: "Rule turned off" },
};

/** "a rule", "3 rules". */
const say = (n: number, one: string) => (n === 1 ? `a ${one}` : `${n} ${one}s`);

/** The build button, saying what it builds: "Build 2 sections and a rule". */
function buildLabel(chosen: AssistantPlan[]): string {
  const sections = chosen.filter((p) => p.changeType === "NEW_MODULE").length;
  const rules = chosen.filter((p) => p.changeType === "AUTOMATION_ADD").length;
  const other = chosen.length - sections - rules;
  const parts = [
    sections > 0 ? say(sections, "section") : null,
    rules > 0 ? say(rules, "rule") : null,
    other > 0 ? say(other, "change") : null,
  ].filter((x): x is string => x !== null);
  const last = parts.pop() ?? "it";
  return `Build ${parts.length ? `${parts.join(", ")} and ${last}` : last}`;
}

/** A plan's row: its own name where it has one, and what kind of thing it is. */
function planHeading(plan: AssistantPlan, title: string): { name: string; sub: string } {
  const word = PLAN_KIND[plan.changeType]?.word ?? "Change";
  switch (plan.changeType) {
    case "NEW_MODULE": {
      const n = plan.newSchema?.columns?.length ?? 0;
      return {
        name: plan.newModule?.nav_label ?? title,
        sub: n > 0 ? `${word} · ${n} field${n === 1 ? "" : "s"}` : word,
      };
    }
    case "AUTOMATION_ADD":
      return { name: plan.automation?.name ?? title, sub: word };
    default:
      return { name: title, sub: word };
  }
}

function BlueprintCard({
  message,
  blueprint,
  modules,
  currentColumns,
  storeFacts,
  done,
  recorded,
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
  /** What became of this card's build, as its thread recorded it. */
  recorded?: BuildRecord;
  /** Receives the exact plans the owner ticked, and where each sits in the design. */
  onApprove: (plans: AssistantPlan[], sent: number[]) => Promise<BuildOutcome>;
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
    blueprint.plans.map((p, i) => (dropped[i] ? p.newModule?.name : null)).filter((n): n is string => !!n)
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
    return refs.some((r) => typeof r === "string" && r.startsWith("#") && droppedSlugs.has(r.slice(1)));
  };

  // What the last Build did, by each plan's place in the design: which
  // were sent, what was already stale then, and what came back. Session
  // state; a reloaded card is told by the receipt after it instead.
  const [run, setRun] = useState<{
    sent: number[];
    stale: Record<number, "already-there" | "section-gone">;
    outcome?: BuildOutcome;
  } | null>(null);
  const building = !!run && !run.outcome;
  // Asked only while the card can still be acted on: once it is built,
  // every section it made is "already there".
  const staleOf = (p: AssistantPlan) => (done || run ? null : staleness(p, modules));

  const chosenAt = blueprint.plans
    .map((p, i) => (!dropped[i] && !referencesDropped(p) && !staleOf(p) ? i : -1))
    .filter((i) => i >= 0);
  const chosen = chosenAt.map((i) => blueprint.plans[i]);
  const nothingLeft = chosen.length === 0 && blueprint.plans.some((p) => staleOf(p));

  // A card read back from the thread has no session of its own: what
  // its build did comes from the record the server wrote.
  const kept: typeof run = run ?? (recorded ? { sent: recorded.sent, stale: {}, outcome: outcomeOf(recorded) } : null);
  const statusOf = (i: number): PlanStatus => {
    const plan = blueprint.plans[i];
    if (kept) {
      const k = kept.sent.indexOf(i);
      if (k === -1) return kept.stale[i] ? { kind: kept.stale[i] } : { kind: "left-out" };
      const o = kept.outcome;
      if (!o) return { kind: "building" };
      if (o.unknown) return { kind: "unknown" };
      if (o.applied.length > 0) return k < o.applied.length ? { kind: "built" } : { kind: "not-tried" };
      if (o.failedAt === undefined) return { kind: "not-tried" };
      if (k < o.failedAt) return { kind: "put-back" };
      if (k === o.failedAt) return { kind: "refused", why: o.errors[0] ?? "it did not fit" };
      return { kind: "not-tried" };
    }
    if (dropped[i] || referencesDropped(plan)) return { kind: "left-out" };
    const stale = staleOf(plan);
    return stale ? { kind: stale } : { kind: "ready" };
  };

  // One build at a time from a card: a second tap while the first is
  // out does nothing, rather than sending the same design twice.
  const approve = async () => {
    if (building || chosen.length === 0) return;
    const stale: Record<number, "already-there" | "section-gone"> = {};
    blueprint.plans.forEach((p, i) => {
      const s = staleness(p, modules);
      if (s) stale[i] = s;
    });
    setRun({ sent: chosenAt, stale });
    const outcome = await onApprove(chosen, chosenAt);
    // Nothing started (another build was running): back as it was.
    setRun(outcome.skipped ? null : { sent: chosenAt, stale, outcome });
  };

  const row = (plan: AssistantPlan, i: number) => {
    const summary = describePlan(plan, modules, currentColumns, storeFacts);
    const status = statusOf(i);
    const off = status.kind === "left-out" || status.kind === "already-there" || status.kind === "section-gone";
    const cascaded = !dropped[i] && referencesDropped(plan);
    const canUntick = !!plan.optional && !done && !run && !cascaded && !staleOf(plan);
    const hasDetail = summary.lines.length > 0;
    const open = !!expanded[i];
    const toggleDetail = () => hasDetail && setExpanded((p) => ({ ...p, [i]: !p[i] }));
    const { name, sub } = planHeading(plan, summary.title);
    const Mark = PLAN_KIND[plan.changeType]?.mark ?? Table;
    return (
      <li
        key={i}
        data-status={status.kind}
        className={`flex items-start gap-2.5 px-3 py-2.5 ${off ? "opacity-50" : ""}`}
      >
        <span
          className={`mt-px flex h-7 w-7 shrink-0 items-center justify-center rounded-control bg-surface-subdued ${
            plan.changeType === "MODULE_DELETE" ? "text-tone-critical-fg" : "text-fg-muted"
          }`}
        >
          {plan.changeType === "NEW_MODULE" ? (
            <Icon name={plan.newModule?.icon} size={15} />
          ) : (
            <Mark aria-hidden size={15} strokeWidth={1.75} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <button
            onClick={toggleDetail}
            aria-expanded={hasDetail ? open : undefined}
            className={`group/row flex w-full items-start gap-1 text-left ${hasDetail ? "" : "cursor-default"}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-snug font-medium text-fg">{name}</span>
              <span className="block text-[11px] leading-snug text-fg-faint">{sub}</span>
            </span>
            {hasDetail && (
              <ChevronRight
                aria-hidden
                size={14}
                strokeWidth={2}
                className={`mt-0.5 shrink-0 text-fg-faint transition-transform duration-150 group-hover/row:text-fg-muted ${open ? "rotate-90" : ""}`}
              />
            )}
          </button>
          {cascaded && <div className="mt-0.5 text-[11px] text-fg-faint">Needs a section you left out</div>}
          <PlanStatusLine status={status} />
          {canUntick && plan.optionalWhy && (
            <div className="mt-0.5 text-[11px] leading-relaxed text-fg-muted">{plan.optionalWhy}</div>
          )}
          {/* Above the detail, not inside it: this changes whether
                the owner wants the section at all. Two lines until the
                row is opened, and the whole of it then. */}
          {summary.warnings?.map((w, k) => (
            <div
              key={k}
              title={w}
              className="mt-0.5 flex items-start gap-1 text-[11px] leading-relaxed text-tone-attention-fg"
            >
              <TriangleAlert aria-hidden size={12} strokeWidth={2} className="mt-[3px] shrink-0" />
              <span className={open ? "" : "line-clamp-2"}>{w}</span>
            </div>
          ))}
          {open && hasDetail && (
            <ul className="mt-1.5 space-y-0.5 border-l border-line pl-2.5">
              {summary.lines.map((line, j) => (
                <li key={j} className="text-[11px] leading-relaxed text-fg-muted">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
        {canUntick && (
          <button
            role="checkbox"
            aria-checked={!dropped[i]}
            aria-label={`Include ${name}`}
            onClick={() => setDropped((prev) => ({ ...prev, [i]: !prev[i] }))}
            className="mt-1 shrink-0 rounded text-fg-muted transition-colors hover:text-fg"
          >
            {dropped[i] ? (
              <Square aria-hidden size={16} strokeWidth={1.75} />
            ) : (
              <SquareCheck aria-hidden size={16} strokeWidth={1.75} />
            )}
          </button>
        )}
      </li>
    );
  };

  // The parts it needs, then what it could do without; each keeps its
  // place in the design, which is how a build says which part did what.
  const placed = blueprint.plans.map((p, i) => [p, i] as const);
  const core = placed.filter(([p]) => !p.optional);
  const extra = placed.filter(([p]) => p.optional);

  // A design reads as a message: what Luke said, then one row per thing
  // it would build (its mark, its name, what kind of thing it is), the
  // detail behind the row, what it does not cover, and two actions. The
  // summary under the message said the same again, and a badge and a
  // coloured line on each optional part made three rows read as ten.
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-relaxed text-fg">{message.trim() || blueprint.summary}</p>

      {core.length > 0 && (
        <ul className="divide-y divide-line rounded-card border border-line">{core.map(([p, i]) => row(p, i))}</ul>
      )}
      {/* What the design could do without, apart, each with its own tick. */}
      {extra.length > 0 && (
        <div role="group" aria-label="Also suggested" className="space-y-1.5">
          <div className="text-[11px] font-medium text-fg-faint">Also suggested</div>
          <ul className="divide-y divide-line rounded-card border border-line">{extra.map(([p, i]) => row(p, i))}</ul>
        </div>
      )}

      {blueprint.workflow.length > 0 && (
        <details className="group text-[11px]">
          <summary className="cursor-pointer list-none select-none text-fg-faint hover:text-fg-muted">
            <ChevronRight
              aria-hidden
              size={14}
              strokeWidth={2}
              className="inline shrink-0 align-[-2px] transition-transform duration-150 group-open:rotate-90"
            />
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
        <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-tone-attention-fg">
          <TriangleAlert aria-hidden size={12} strokeWidth={2} className="mt-[3px] shrink-0" />
          <span>
            <span className="font-medium">Not covered:</span> {blueprint.unmet!.join(" · ")}
          </span>
        </div>
      )}

      {!done && nothingLeft && (
        <div className="text-[11px] text-fg-faint">Nothing left to build: all of this is already in your app.</div>
      )}
      {!done && !nothingLeft && (
        <div className="flex items-center gap-1.5">
          <button onClick={approve} disabled={chosen.length === 0 || building} className={button("primary", "sm")}>
            {building ? "Building…" : buildLabel(chosen)}
          </button>
          <button onClick={onAmend} className={button("plain", "sm")}>
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
  currentSchema,
  records,
  messages,
  busy,
  threads,
  threadsMore = false,
  conversationId,
  onNewThread,
  onPickThread,
  onDeleteThread,
  onRenameThread,
  onStop,
  canStop,
  steps = [],
  draft = "",
  phase = null,
  threadOpening = false,
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
  currentSchema: UiSchema | null;
  records: RecordRow[];
  messages: ChatMessage[];
  /** Past threads for this project, newest first. */
  threads: ThreadSummary[];
  /** Older threads exist beyond this first page. */
  threadsMore?: boolean;
  conversationId: string | null;
  /** The last conversation is still loading, so the empty screen is not shown yet. */
  threadOpening?: boolean;
  onNewThread: () => void;
  onPickThread: (id: string) => void;
  onDeleteThread: (id: string) => void;
  /** Names a thread for good: Luke's replies no longer rename it. */
  onRenameThread: (id: string, title: string) => void;
  onStop: () => void;
  /** Only a model call can be stopped. Applying a build must not be
   *  interrupted halfway, and there is nothing to abort during it. */
  canStop: boolean;
  busy: boolean;
  /** What the running turn has done so far, oldest first. Empty until
   *  the server has taken the turn, and while a build is applied. */
  steps?: TurnEvent[];
  /** What Luke is saying while it says it; the reply replaces it. */
  draft?: string;
  /** What is being written once the draft's words are done ("questions"). */
  phase?: string | null;
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
    next?: NextStep[],
    design?: { id: string; sent: number[] }
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
  useEffect(
    () => () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
    },
    []
  );
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
  const whyItIsAsking = (r: { outcome: { applied?: unknown[]; errors?: string[] } | null }): string | null => {
    const errors = r.outcome?.errors ?? [];
    if (errors.length === 0) return null;
    return `it was tried on its own and did not go in — ${errors.slice(0, 2).join("; ")}`;
  };

  /** Requests that turned up just now, floating over the panel. */
  const [toasts, setToasts] = useState<string[]>([]);
  /** What was already waiting last time we looked. Null = never looked. */
  const seen = useRef<Set<string> | null>(null);
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
        shop_domain: (a.stores as { shop_domain?: string } | null)?.shop_domain ?? null,
      }))
    );
  }, [projectId]);
  useEffect(() => {
    loadShopChanges();
  }, [loadShopChanges]);
  // Luke asked for a change this turn: the request is already written,
  // so the card is read now rather than left to the realtime channel,
  // which a dropped connection would leave silent.
  const proposedNow = steps.filter((s) => s.step === "proposed").length;
  useEffect(() => {
    if (proposedNow > 0) loadShopChanges();
  }, [proposedNow, loadShopChanges]);
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
  const [threadQuery, setThreadQuery] = useState("");
  /** When the list of past conversations was opened: what "3 h ago" and "Today" are counted from. */
  const [threadsAt, setThreadsAt] = useState(0);
  /** Pages of past conversations below the first, as "Show older" brings them. */
  const [olderThreads, setOlderThreads] = useState<ThreadSummary[]>([]);
  const [olderMore, setOlderMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Every conversation whose name has the words searched for, as the server found them. */
  const [foundThreads, setFoundThreads] = useState<{ q: string; list: ThreadSummary[] } | null>(null);
  const [renamingThread, setRenamingThread] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  const listedThreads = useMemo(() => {
    const first = new Set(threads.map((t) => t.id));
    return [...threads, ...olderThreads.filter((t) => !first.has(t.id))];
  }, [threads, olderThreads]);
  const moreThreads = olderThreads.length > 0 ? olderMore : threadsMore;
  const showOlderThreads = async () => {
    const last = listedThreads[listedThreads.length - 1];
    if (!last || loadingOlder) return;
    setLoadingOlder(true);
    const { ok, data } = await apiFetch(
      `/api/chat?${new URLSearchParams({ projectId, before: last.updated_at })}`,
      null,
      "GET"
    ).catch(() => ({ ok: false, data: {} as Record<string, unknown> }));
    setLoadingOlder(false);
    if (!ok) return;
    setOlderThreads((prev) => [...prev, ...((data.threads as ThreadSummary[] | undefined) ?? [])]);
    setOlderMore(data.more === true);
  };
  // Searched over every thread, a moment after they stop typing.
  useEffect(() => {
    const q = threadQuery.trim();
    if (!q) return;
    const stop = new AbortController();
    const t = setTimeout(() => {
      apiFetch(`/api/chat?${new URLSearchParams({ projectId, q })}`, null, "GET", stop.signal)
        .then(({ ok, data }) => {
          if (ok) setFoundThreads({ q, list: (data.threads as ThreadSummary[] | undefined) ?? [] });
        })
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(t);
      stop.abort();
    };
  }, [threadQuery, projectId]);
  const saveRename = (id: string) => {
    const title = renameText.trim().slice(0, TITLE_MAX);
    setRenamingThread(null);
    if (!title) return;
    onRenameThread(id, title);
    const named = (t: ThreadSummary) => (t.id === id ? { ...t, title } : t);
    setOlderThreads((prev) => prev.map(named));
    setFoundThreads((prev) => prev && { ...prev, list: prev.list.map(named) });
  };
  const forgetThread = (id: string) => {
    onDeleteThread(id);
    setOlderThreads((prev) => prev.filter((t) => t.id !== id));
    setFoundThreads((prev) => prev && { ...prev, list: prev.list.filter((t) => t.id !== id) });
  };
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
      // An Escape something inside already took (leaving a rename) is not
      // for the menu. Next hydrates the whole document, so React's handlers
      // sit on the same node as this one and cannot stop it reaching here.
      if (e instanceof KeyboardEvent && (e.key !== "Escape" || e.defaultPrevented)) return;
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

  // ── Where the list sits ─────────────────────────────────────────
  // A sent message is pinned near the top, and the reply grows below it
  // into room kept for it, so nothing above it moves while Luke writes.
  // The list used to be pulled to the bottom on every change, each
  // streamed word included: the prompt jumped when the reply arrived,
  // and nobody could scroll up to read while it streamed. Only a list
  // already at its newest follows what arrives, and only downwards;
  // otherwise it stays put and offers the way down.
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerRef = useRef<HTMLDivElement>(null);
  const keptRoom = useRef<ResizeObserver | null>(null);
  const listWas = useRef({ typed: 0, total: 0, thread: conversationId });
  const [awayFromNewest, setAwayFromNewest] = useState(false);
  const motion = (): ScrollBehavior =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  /** Scrolled so the end of what is written, not of the room kept below it, is in view. */
  const newestTop = useCallback(() => {
    const el = listRef.current;
    const content = contentRef.current;
    if (!el || !content) return 0;
    return Math.max(0, content.offsetTop + content.offsetHeight + LIST_PAD - el.clientHeight);
  }, []);
  const release = useCallback(() => {
    keptRoom.current?.disconnect();
    keptRoom.current = null;
    if (spacerRef.current) spacerRef.current.style.height = "0px";
  }, []);
  const pin = useCallback(
    (id: string) => {
      const el = listRef.current;
      const content = contentRef.current;
      const spacer = spacerRef.current;
      const bubble = content?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
      if (!el || !content || !spacer || !bubble) return;
      release();
      // The bubble and everything after it, against a screen's height:
      // the rest is kept as room, and given back as the reply fills it.
      const fit = () => {
        const used = content.offsetTop + content.offsetHeight - bubble.offsetTop;
        spacer.style.height = `${Math.max(0, el.clientHeight - PIN_GAP - used - LIST_PAD)}px`;
      };
      fit();
      keptRoom.current = new ResizeObserver(fit);
      keptRoom.current.observe(content);
      requestAnimationFrame(() => el.scrollTo({ top: Math.max(0, bubble.offsetTop - PIN_GAP), behavior: motion() }));
    },
    [release]
  );
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const typed = messages.filter((m) => m.role === "user").length;
    const was = listWas.current;
    listWas.current = { typed, total: messages.length, thread: conversationId };
    const last = messages[messages.length - 1];
    // Another thread opened, or this one read in for the first time: its
    // newest in view, nothing pinned. A thread this turn just started is
    // the same conversation, not another one.
    const switched = was.thread !== null && conversationId !== null && was.thread !== conversationId;
    if (switched || (was.total === 0 && messages.length > 0 && last?.role !== "user")) {
      release();
      el.scrollTop = el.scrollHeight;
      return;
    }
    if (typed > was.typed && last?.role === "user") pin(last.id);
    else if (messages.length === 0) release();
  }, [messages, conversationId, pin, release]);
  // A card their AI raised, arriving at the end: followed only by a list
  // already at its newest, and only down. Not a reply: that grows below
  // the pinned question, and following it would push the question away.
  const away = useRef(false);
  useEffect(() => {
    const el = listRef.current;
    if (!el || away.current) return;
    const top = newestTop();
    if (top > el.scrollTop) el.scrollTo({ top, behavior: motion() });
  }, [requests.length, newestTop]);
  // Whether the newest is out of view, as the list scrolls or grows.
  useEffect(() => {
    const el = listRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const check = () => {
      // More than a line or two below: a line's worth is not worth a button.
      away.current = newestTop() - el.scrollTop > 40;
      setAwayFromNewest(away.current);
    };
    el.addEventListener("scroll", check, { passive: true });
    const grows = new ResizeObserver(check);
    grows.observe(content);
    return () => {
      el.removeEventListener("scroll", check);
      grows.disconnect();
    };
  }, [newestTop]);
  useEffect(() => release, [release]);

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
  /** The set of waiting requests the line above the composer was cleared for. */
  const [noticeCleared, setNoticeCleared] = useState("");

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
        lastCall:
          list
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
      aria-label="Luke"
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
                  setThreadQuery("");
                  setThreadsAt(Date.now());
                  setBellOpen(false);
                }}
                title="Past conversations"
                aria-label="Past conversations"
                className="relative inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-control px-1.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
              >
                <History aria-hidden size={16} strokeWidth={1.75} />
                <span className="text-[11px] tabular-nums">
                  {threads.length}
                  {threadsMore ? "+" : ""}
                </span>
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
                        waiting || going
                          ? "border-tone-attention bg-tone-attention/25"
                          : "border-line bg-surface-subdued"
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
                              className="rounded-lg bg-primary px-2 py-1 text-[10px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40"
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
                          <TriangleAlert aria-hidden size={13} className="mr-1 inline align-[-2px]" />
                          Only part of this was built
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
                          {r.built_at ? ` · ${new Date(r.built_at).toLocaleDateString()}` : ""} · {r.request}
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
                        <p
                          className={`text-[11px] leading-relaxed font-medium ${done ? "text-fg" : "text-tone-attention-fg"}`}
                        >
                          {r.request}
                        </p>
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
                                <span className="font-semibold">Not covered:</span> {r.unmet.join(" · ")}
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
                                <span className="font-semibold">Waiting for you:</span> {whyItIsAsking(r)}
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
                                  className="rounded-lg bg-primary px-2 py-1 text-[10px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40"
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
                                {opening === r.id ? "Designing…" : r.plans?.length ? "Change it first" : "Design it"}
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
              <div className="pop thin-scroll absolute top-full right-0 z-50 mt-1.5 max-h-96 w-72 overflow-y-auto rounded-card bg-surface p-1 shadow-popover">
                {/* Found by name once there are more than a screenful; the
                    names are the model's own summaries of each thread, or
                    what the owner renamed it. Every thread is searched, not
                    only the pages already here. It covers the popover's own
                    padding too, or rows scroll into view above it. */}
                {(listedThreads.length > THREADS_BEFORE_SEARCH || threadsMore) && (
                  <div className="sticky -top-1 z-10 -mx-1 -mt-1 bg-surface px-2 pt-2 pb-1">
                    <input
                      type="search"
                      value={threadQuery}
                      onChange={(e) => setThreadQuery(e.target.value)}
                      placeholder="Search conversations"
                      aria-label="Search conversations"
                      autoFocus
                      className={`${fieldOf("sm")} w-full`}
                    />
                  </div>
                )}
                {(() => {
                  const now = threadsAt;
                  const q = threadQuery.trim();
                  // Those already here at once, then the server's answer over all of them.
                  const found = foundThreads?.q === q ? foundThreads.list : null;
                  const shown = q
                    ? (found ?? listedThreads.filter((t) => (t.title ?? "").toLowerCase().includes(q.toLowerCase())))
                    : listedThreads;
                  if (shown.length === 0) {
                    return (
                      <div className="px-3 py-2 text-[11px] text-fg-faint">
                        {q ? "No conversation by that name." : "No past conversations."}
                      </div>
                    );
                  }
                  // Newest first already, so each day's group comes out in order.
                  const groups = new Map<string, ThreadSummary[]>();
                  for (const t of shown) {
                    const g = dayGroup(t.updated_at, now);
                    groups.set(g, [...(groups.get(g) ?? []), t]);
                  }
                  return (
                    <>
                      {[...groups].map(([label, list]) => (
                        <div key={label} role="group" aria-label={label}>
                          <div className="px-2.5 pt-2 pb-1 text-[10px] font-medium text-fg-faint">{label}</div>
                          {list.map((t) => (
                            <div
                              key={t.id}
                              className={`flex items-center gap-0.5 rounded-[6px] px-1 transition-colors hover:bg-surface-hover ${
                                t.id === conversationId ? "bg-surface-hover" : ""
                              }`}
                            >
                              {renamingThread === t.id ? (
                                <div className="min-w-0 flex-1 py-1 pr-1">
                                  <input
                                    value={renameText}
                                    onChange={(e) => setRenameText(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        e.preventDefault();
                                        saveRename(t.id);
                                      } else if (e.key === "Escape") {
                                        e.preventDefault();
                                        setRenamingThread(null);
                                      }
                                    }}
                                    maxLength={TITLE_MAX}
                                    aria-label="Name this conversation"
                                    autoFocus
                                    className={`${fieldOf("sm")} w-full`}
                                  />
                                  <div className="mt-0.5 px-0.5 text-[10px] text-fg-faint">
                                    Enter to keep it · Esc to leave it
                                  </div>
                                </div>
                              ) : (
                                <button
                                  onClick={() => {
                                    onPickThread(t.id);
                                    setThreadsOpen(false);
                                  }}
                                  className="min-w-0 flex-1 px-1.5 py-1.5 text-left"
                                >
                                  <div
                                    className={`truncate text-[12px] text-fg ${t.id === conversationId ? "font-medium" : ""}`}
                                  >
                                    {t.title ?? "Untitled"}
                                  </div>
                                  <div className="truncate text-[10px] text-fg-faint">{threadLine(t, now)}</div>
                                </button>
                              )}
                              {/* Threads accumulate — six of them called "hello"
                                  before there was any way to be rid of one. */}
                              {renamingThread === t.id ? null : confirmThread === t.id ? (
                                <span className="flex shrink-0 items-center gap-1 pr-1 text-[10px]">
                                  <button
                                    onClick={() => {
                                      setConfirmThread(null);
                                      forgetThread(t.id);
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
                                <>
                                  <button
                                    onClick={() => {
                                      setRenamingThread(t.id);
                                      setRenameText(t.title ?? "");
                                    }}
                                    aria-label={`Rename ${t.title ?? "this conversation"}`}
                                    title="Rename"
                                    className="shrink-0 rounded px-1 py-1 text-fg-faint transition-colors hover:bg-surface-subdued hover:text-fg-muted"
                                  >
                                    <Pencil aria-hidden size={12} strokeWidth={2} />
                                  </button>
                                  <button
                                    onClick={() => setConfirmThread(t.id)}
                                    aria-label={`Delete ${t.title ?? "this conversation"}`}
                                    title="Delete"
                                    className="shrink-0 rounded px-1 py-1 text-fg-faint hover:bg-tone-critical/40 hover:text-tone-critical-fg"
                                  >
                                    <X aria-hidden size={14} strokeWidth={2} />
                                  </button>
                                </>
                              )}
                            </div>
                          ))}
                        </div>
                      ))}
                      {/* The first page is the newest thirty; older ones come
                          when asked for, not all at once. */}
                      {!q && moreThreads && (
                        <button
                          onClick={showOlderThreads}
                          disabled={loadingOlder}
                          className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-[6px] px-2 py-1.5 text-[11px] text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg disabled:opacity-60"
                        >
                          {loadingOlder && (
                            <LoaderCircle aria-hidden size={12} strokeWidth={2} className="motion-safe:animate-spin" />
                          )}
                          {loadingOlder ? "Loading…" : "Show older"}
                        </button>
                      )}
                    </>
                  );
                })()}
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
        role="log"
        aria-label="Conversation"
        className="relative flex-1 overflow-y-auto px-4 py-4 thin-scroll"
      >
        {/* Four invented problems used to sit here — a double-booked
            slot, parts coming off a job. They were written to show what
            the engine can do, and to a shop selling phone cases they
            read as a product for somebody else. A prompt for their own
            words is the honest opening. */}
        {/* The last conversation is on its way: its shape, not the empty
            screen's welcome, which read as the thread being gone. */}
        {messages.length === 0 && threadOpening && (
          <div role="status" aria-label="Opening your conversation" className="space-y-3 pt-1">
            <div className="ml-auto h-9 w-3/5 rounded-2xl bg-surface-subdued motion-safe:animate-pulse" />
            <div className="h-3 w-5/6 rounded bg-surface-subdued motion-safe:animate-pulse" />
            <div className="h-3 w-2/3 rounded bg-surface-subdued motion-safe:animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-surface-subdued motion-safe:animate-pulse" />
          </div>
        )}
        {messages.length === 0 && !threadOpening && (
          <div className="rise flex min-h-[55%] flex-col items-center justify-center px-4 text-center">
            <LukeMark size="lg" />
            <h2 className="mt-4 text-lg font-semibold text-fg">{LUKE_COPY.emptyTitle}</h2>
            <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed text-fg-muted">{LUKE_COPY.emptyBody}</p>
          </div>
        )}

        <div ref={contentRef} className="space-y-4">
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
                <div key={m.id} data-message-id={m.id} className="rise group flex flex-col items-end" style={RISE}>
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
                        <button onClick={() => setEditingId(null)} className="text-fg-muted hover:text-fg">
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
                        {(() => {
                          const pairs = answerPairs(m.text ?? "");
                          return pairs ? <AnswerSummary pairs={pairs} /> : m.text;
                        })()}
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
                    together={m.together}
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
                    recorded={m.built}
                    onApprove={async (chosen, sent) => {
                      setResolvedCards((prev) => ({ ...prev, [m.id]: true }));
                      const outcome = await onBuild(chosen, undefined, undefined, m.blueprint?.next, {
                        id: m.id,
                        sent,
                      });
                      // Nothing started, so nothing was answered: the card is live again.
                      if (outcome.skipped) setResolvedCards((prev) => ({ ...prev, [m.id]: false }));
                      return outcome;
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
            if (m.building) {
              return <BuildingLine key={m.id} text={m.text ?? "Building…"} startedAt={m.building.startedAt} />;
            }

            if (!m.plan) {
              return (
                <div key={m.id} className="space-y-1">
                  {m.trace && <TraceLine trace={m.trace} />}
                  <Markdown>{m.text ?? ""}</Markdown>
                  {m.text && <CopyReply text={m.text} />}
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
                  {/* What they might ask next, each sent as written when
                    tapped. Only on the last thing in the thread: after a
                    question or a put-back, a suggestion about the app as
                    it was is stale. */}
                  {m.next && m.next.length > 0 && i === messages.length - 1 && !busy && (
                    <FollowUps next={m.next} onPick={(prompt) => send(prompt)} />
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
                  {plan.newModule?.nav_label ?? plan.explanation}” already changed since this was proposed, so there is
                  nothing left to apply.
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
                          <Pencil aria-hidden size={12} className="mr-1 inline align-[-1px]" />
                          Rename: <b>{targetModule?.nav_label}</b> → <b>{plan.moduleUpdate.nav_label}</b>
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
                        <TriangleAlert aria-hidden size={13} className="mr-1 inline align-[-2px]" />
                        Delete “{targetModule.nav_label}” and all its records?
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
                        <Zap aria-hidden size={12} className="mr-1 inline align-[-1px]" />
                        {plan.automation.name}
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
                        onChange={(e) => setDeleteConfirm((prev) => ({ ...prev, [m.id]: e.target.value }))}
                        placeholder={`Type "${targetModule.nav_label}" to enable deletion`}
                        className="w-full rounded-lg border border-tone-critical/70 px-3 py-1.5 text-xs outline-none focus:border-tone-critical focus:ring-2 focus:ring-tone-critical/60"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => apply(plan, m.id)}
                          disabled={
                            isPending ||
                            (deleteConfirm[m.id] ?? "").trim().toLowerCase() !== targetModule.nav_label.toLowerCase()
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
                        className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
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
                  {draft ? "Writing…" : steps.length ? stepWords(steps[steps.length - 1]) : "Working on it…"}
                </span>
                {stepSeconds >= 2 && <span className="shrink-0 tabular-nums text-fg-faint">{stepSeconds}s</span>}
                {steps.length > 1 && (
                  <ChevronRight
                    aria-hidden
                    size={13}
                    strokeWidth={2}
                    className={`shrink-0 text-fg-faint transition-transform duration-150 ${stepsOpen ? "rotate-90" : ""}`}
                  />
                )}
              </button>
              {stepsOpen && steps.length > 1 && (
                <ul className="mt-1 space-y-0.5 pl-3 text-fg-faint">
                  {steps.slice(0, -1).map((s, i) => (
                    <StepRow key={i} step={s} />
                  ))}
                </ul>
              )}
            </div>
          )}
          {/* What Luke is saying, as it says it: the reply's own words, in
            the reply's own type. A draft, so a screen reader is not read
            every word; the reply that replaces it is. */}
          {busy && draft && (
            <div aria-hidden>
              <Markdown streaming>{draft}</Markdown>
            </div>
          )}
          {/* The words are done and the rest is still being written: said,
              so the panel does not go quiet before the questions arrive. */}
          {busy && draft && phase && PHASE_WORDS[phase] && (
            <div className="flex items-center gap-1.5 text-[11px] text-fg-faint">
              <Sparkles aria-hidden size={12} strokeWidth={2} className="shrink-0" />
              <span className="shimmer">{PHASE_WORDS[phase]}</span>
            </div>
          )}
        </div>
        {/* The room kept below a sent message for its reply (see pin). */}
        <div ref={spacerRef} aria-hidden />
        {/* Held at the foot of the list while the newest is out of view;
            takes no room, so it moves nothing when it comes and goes. */}
        {awayFromNewest && (
          <div className="pointer-events-none sticky bottom-0 flex h-0 justify-center">
            <button
              onClick={() => listRef.current?.scrollTo({ top: newestTop(), behavior: motion() })}
              aria-label="Go to the newest message"
              className="pointer-events-auto inline-flex -translate-y-[calc(100%+8px)] items-center gap-1 rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-medium text-fg-muted shadow-popover transition-colors hover:text-fg"
            >
              <ArrowDown aria-hidden size={13} strokeWidth={2} />
              Latest
            </button>
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
                      className="rounded-lg bg-primary px-2 py-1 text-[10px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40"
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
                const theirs = [
                  ...new Set(assistants.map((c) => assistantLogo(c.name)).filter((l): l is string => !!l)),
                ];
                return theirs.length ? theirs : ["/logos/claude.svg", "/logos/openai.svg"];
              })().map((src) => (
                <span
                  key={src}
                  className="flex h-6 w-6 items-center justify-center rounded-full border border-line bg-surface shadow-card"
                >
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
              Add Warmluke as a custom connector with this address. It reads your store, and anything it wants to build
              comes back here for you to approve.
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
                    <li
                      key={c.name}
                      className="flex items-center gap-2.5 border-b border-line px-2.5 py-2 last:border-b-0"
                    >
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
              Asking about your store still works, and anything already designed can still be built. Designing something
              new is the part that needs Warmluke AI.
            </p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setWantsPlan(true)}
                className="rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-medium text-on-primary hover:bg-primary-hover"
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
                Still being built — it releases soon. Until then your own Claude or ChatGPT does the asking, and
                Warmluke keeps building what you have already approved.
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
                <ChevronRight
                  aria-hidden
                  size={11}
                  strokeWidth={2}
                  className="ml-0.5 inline align-[-1px] transition-transform duration-150 group-open:rotate-90"
                />
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
