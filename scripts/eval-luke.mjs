// Luke in whole conversations, against a running app, graded, under a
// dollar cap.
//
// A check asks one thing and reads one answer. What goes wrong with Luke
// goes wrong over a conversation: the RTO tangle took four turns, each
// reasonable on its own. So each case here is an owner with a problem
// (evals/cases/*.json). The opening goes to the running app as the panel
// sends it; a simulated owner answers Luke only from the case's facts and
// says yes when the plan fits; the yes is built as the panel builds it;
// and what is left in the app is graded, by code for the signs 0175 lists
// and by a grader model for the rest.
//
// Model tier, by hand, never CI: every case spends real money. Not named
// check-*, so run-checks.mjs never starts it. It stops before it would
// pass --max-usd: every model call and every turn is estimated before it
// is made, and a run that stops writes what finished, marked partial.
// Runs land in evals/runs/ and are committed: the console's Evals page
// reads them with no database (evals/README.md).
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 \
//   EVAL_SIM_MODEL=claude-haiku-4-5 EVAL_GRADE_MODEL=claude-haiku-4-5 \
//   node scripts/eval-luke.mjs --label before --max-usd 1.5 [--set smoke|real|full-a|full-b|full | --cases a,b] [--design-model <name>]
//
// Run from the repository's root. The check project only (CHECK_PROJECT=1):
// each case makes a throwaway project with the seeded shop in it, and
// removes it at the end. The model key is read from the environment, or
// the env file when the environment has none.
//
// Since 12 Oct a case may run on another kind of shop (`shop`, from
// scripts/fixtures/shops.ts), and is graded by code first (`expect`, worked
// out from that shop in evals/expect.mjs): the number in the answer, the rows
// a build points at, a question asked first, a plain "I can't" only where the
// platform can't. The grader model then reads tone and helpfulness. A case
// scores out of 10; `--set smoke` runs the six cheap ones.
//
// Everything above main() is pure, so check-eval-harness can test it.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { SCORE_KEYS, casePassed, scoreOf, summarise } from "../src/lib/eval-report.ts";
import { priceOf } from "../src/lib/model-prices.ts";
import { EXPECT, expectationFor, viewOf } from "../evals/expect.mjs";
import { SHOPS } from "./fixtures/shops.ts";

export const CASES_DIR = new URL("../evals/cases/", import.meta.url);
export const RUNS_DIR = new URL("../evals/runs/", import.meta.url);

/**
 * A Luke turn, before one is measured: Opus 5.5 designed twenty asks for
 * $3.63 with its plan step and critic (docs/reference/environment.md), so
 * $0.18 a design; half again for a repair or a lookup. A case's own
 * average is used once it is dearer: its first turn is a cheap plan in
 * words, and an average of that alone would under-guess the build.
 */
export const LUKE_TURN_USD = 0.3;
/** What a reply is counted at before it is written: an owner's line, a grader's verdict. */
const SIM_OUT_TOKENS = 400;
const GRADE_OUT_TOKENS = 2000;
/** What the grader reads, before it is measured: a conversation and a build. */
const GRADE_IN_CHARS = 40_000;
/** How long a turn may take to settle: past the durable turn's longest legs. */
const SETTLE_MS = 6 * 60_000;

export const COMMON_SUCCESS = [
  "the plan is said in plain words before anything is built, with no field names or types",
  "ends by asking whether to build",
];
export const COMMON_MUST_NOT = ['jargon such as "boolean" or "set_fields" in what the owner reads'];
/** How a simulated owner says a plain yes: words isGoAhead (lib/plan.ts) takes as one. */
const YES = { hinglish: "haan bana do", english: "yes build it" };
/** And what it says to a question its facts do not answer. */
const DECIDE = { hinglish: "aap decide karo", english: "you decide" };

// ── Arguments ───────────────────────────────────────────────────────

export function parseArgs(argv) {
  const value = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const label = value("--label");
  const maxUsd = Number(value("--max-usd"));
  const only = value("--cases");
  const set = value("--set") ?? null;
  const designModel = value("--design-model") ?? null;
  if (!label || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(label)) {
    return { error: "--label is required: lowercase letters, digits and dashes (before, after-prompt-fix)" };
  }
  // The whole budget for every eval is $10: a cap above it is a typo.
  if (!(maxUsd > 0 && maxUsd <= 10)) return { error: "--max-usd is required: dollars, more than 0 and at most 10" };
  if (designModel !== null && !/^[a-z0-9][a-z0-9.-]*$/.test(designModel)) {
    return { error: "--design-model is a model's id, as the panel names it (claude-sonnet-5)" };
  }
  if (set !== null && !SETS.includes(set)) return { error: `--set is one of ${SETS.join(", ")}` };
  if (set !== null && only) return { error: "--set or --cases, not both" };
  const cases = only
    ? only
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  return { label, maxUsd, cases, set, designModel };
}

// ── Cases ───────────────────────────────────────────────────────────

const KEYS = [
  "id",
  "title",
  "language",
  "kind",
  "shop",
  "persona",
  "before",
  "opening",
  "facts",
  "success",
  "must_not",
  "max_turns",
  "expect",
  "follow_ups",
  "smoke",
  "meeting",
];
/** build: something is made (the common criteria apply); question: one answer from the store; vague: a question first; limit: a plain no; meet: the first meeting (lib/meet), Luke speaking first. */
export const KINDS = ["build", "question", "vague", "limit", "meet"];
const EXPECT_KEYS = ["answer", "effect", "exercise", "asks_first", "honest", "builds", "edited", "opens", "talks"];
/** The runs a --set names: the six cheap cases, the real owners' asks, everything, or everything in two halves under one cap each. */
export const SETS = ["smoke", "real", "onboarding", "full", "full-a", "full-b"];
const words = (v) => typeof v === "string" && v.trim().length > 0;

/** What is wrong with a case file, in a line each; none when it is whole. */
export function caseProblems(c, file) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return ["not an object"];
  const p = [];
  for (const k of Object.keys(c)) if (!KEYS.includes(k)) p.push(`unknown key "${k}"`);
  if (typeof c.id !== "string" || !/^[a-z0-9-]+$/.test(c.id)) p.push("id: lowercase words and dashes");
  if (file && `${c.id}.json` !== file) p.push(`id "${c.id}" is not its file's name`);
  for (const k of ["title", "persona", "opening"]) if (!words(c[k])) p.push(`${k}: some words`);
  if (!["hinglish", "english"].includes(c.language)) p.push('language: "hinglish" or "english"');
  const kind = c.kind ?? "build";
  if (!KINDS.includes(kind)) p.push(`kind: one of ${KINDS.join(", ")}`);
  if (c.shop !== undefined && c.shop !== "seed" && !SHOPS[c.shop])
    p.push(`shop: "seed" or one of ${Object.keys(SHOPS).join(", ")}`);
  const e = c.expect;
  if (e !== undefined) {
    if (!e || typeof e !== "object" || Array.isArray(e)) p.push("expect: an object");
    else {
      for (const k of Object.keys(e)) if (!EXPECT_KEYS.includes(k)) p.push(`expect: unknown key "${k}"`);
      for (const k of ["answer", "effect", "exercise"])
        if (e[k] !== undefined && !EXPECT[e[k]]) p.push(`expect.${k}: no expectation "${e[k]}"`);
      if (e.builds !== undefined && !(Number.isInteger(e.builds) && e.builds >= 1))
        p.push("expect.builds: a whole number of builds");
    }
  }
  if (kind !== "build" && !e) p.push(`a ${kind} case is graded by its expect`);
  if ((kind === "meet") !== (c.meeting === true)) p.push('a meet case, and only one, has "meeting": true');
  if (e?.talks !== undefined && !(Number.isInteger(e.talks) && e.talks >= 1))
    p.push("expect.talks: a whole number of replies");
  if (c.follow_ups !== undefined && (!Array.isArray(c.follow_ups) || !c.follow_ups.every(words))) {
    p.push("follow_ups: what the owner says after a build, in order");
  }
  if (!Array.isArray(c.before) || c.before.some((pl) => !pl || typeof pl.changeType !== "string")) {
    p.push("before: a list of plans, each with a changeType");
  }
  const facts = c.facts && typeof c.facts === "object" && !Array.isArray(c.facts) ? Object.values(c.facts) : [];
  if (facts.length === 0 || !facts.every(words)) p.push("facts: topics, each with what the owner would answer");
  // A build is said in words first, whatever else it is graded on; other kinds may be graded by code alone.
  for (const k of ["success", "must_not"]) {
    if (!Array.isArray(c[k]) || (kind === "build" && c[k].length === 0) || !c[k].every(words)) {
      p.push(`${k}: a list of sentences`);
    }
  }
  if (kind === "build") {
    for (const s of COMMON_SUCCESS)
      if (!Array.isArray(c.success) || !c.success.includes(s)) p.push(`success lacks "${s}"`);
    for (const s of COMMON_MUST_NOT)
      if (!Array.isArray(c.must_not) || !c.must_not.includes(s)) p.push(`must_not lacks "${s}"`);
  }
  if (!Number.isInteger(c.max_turns) || c.max_turns < 1 || c.max_turns > 8) p.push("max_turns: a whole number, 1 to 8");
  return p;
}

/** Emails, phone numbers (eight digits or more) and ids in a text: the repository is public. */
export function privateBits(text) {
  return [
    ...(text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []),
    // A date is not a phone number, and must not join one either side of it into one.
    ...(text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "·").match(/\+?\d[\d\s-]{6,}\d/g) ?? []).filter(
      (m) => m.replace(/\D/g, "").length >= 8
    ),
    ...(text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? []),
  ];
}

/** The cases a run is asked for: named ones, a set, or all. */
export function selectCases(all, { cases = null, set = null } = {}) {
  if (cases) return all.filter((c) => cases.includes(c.id));
  if (set === "smoke") return all.filter((c) => c.smoke === true);
  // The asks real owners made that went wrong in production (r-…, 15 Oct).
  if (set === "real") return all.filter((c) => c.id.startsWith("r-"));
  // The first meeting, as a new owner meets Luke (sprint, 15 Oct).
  if (set === "onboarding") return all.filter((c) => c.meeting === true);
  const half = Math.ceil(all.length / 2);
  if (set === "full-a") return all.slice(0, half);
  if (set === "full-b") return all.slice(half);
  return all;
}

/** "{{days:+45}}" in a case's `before` is that many days from today, as a date in India. */
export function fillDates(v, now = Date.now()) {
  if (typeof v === "string") {
    return v.replace(/\{\{days:([+-]?\d+)\}\}/g, (_, n) =>
      new Date(now + 5.5 * 3_600_000 + Number(n) * 86_400_000).toISOString().slice(0, 10)
    );
  }
  if (Array.isArray(v)) return v.map((x) => fillDates(x, now));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDates(x, now)]));
  return v;
}

export function loadCases() {
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".json"))
    .toSorted()
    .map((file) => ({ file, case: JSON.parse(readFileSync(new URL(file, CASES_DIR), "utf8")) }));
}

// ── What a reply says, and what a design is ─────────────────────────

export const plansOf = (r) =>
  r?.type === "plans" && Array.isArray(r.plans)
    ? r.plans
    : r?.type === "blueprint" && Array.isArray(r.blueprint?.plans)
      ? r.blueprint.plans
      : [];
export const isProposal = (r) => r?.type === "answer" && r.kind === "proposal";

/** The words the owner reads in a reply: what jargon is looked for in. */
export function ownerText(r) {
  if (!r || typeof r !== "object") return "";
  const next = Array.isArray(r.next) ? r.next : Array.isArray(r.blueprint?.next) ? r.blueprint.next : [];
  return [
    r.message,
    r.blueprint?.summary,
    ...(Array.isArray(r.questions) ? r.questions : []).flatMap((q) => [q?.question, q?.why, ...(q?.suggestions ?? [])]),
    ...next.map((n) => n?.label),
  ]
    .filter(words)
    .join("\n");
}

const short = (v, n = 300) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const columnLine = (c, keys = true) =>
  `${c?.label ?? c?.field}${keys ? ` [${c?.field}]` : ""} (${c?.type}${Array.isArray(c?.options) ? `: ${c.options.join(" / ")}` : ""}${c?.hidden ? ", hidden from the table" : ""}${c?.compute ? ", worked out when read" : ""})`;

/**
 * A design as lines: what the simulated owner sees on a card, and the
 * transcript keeps. Labels only, as the card shows them: with each key
 * beside its label, the grader marked Luke down for words the owner
 * never reads (4 Oct). The kind in brackets is for the reader.
 */
export function planLines(plans) {
  return plans.flatMap((p) => [
    `- ${p?.changeType}${p?.newModule?.nav_label ? ` "${p.newModule.nav_label}"` : ""}: ${p?.explanation ?? ""}`,
    ...(p?.newSchema?.columns?.length
      ? [`  fields: ${p.newSchema.columns.map((c) => columnLine(c, false)).join(" · ")}`]
      : []),
    ...(p?.automation?.name ? [`  rule: ${p.automation.name}`] : []),
  ]);
}

/**
 * A step of Luke's turn as one short line, as the run file keeps the
 * trace: "model 3/4", "critic redo 2 missing", "ux redo screenshot".
 * The turn's trace is gone with the case's project; this is what is left.
 */
export const stepLine = (s) =>
  [
    s?.step,
    s?.road,
    s?.verdict,
    s?.how,
    s?.attempt != null ? `${s.attempt}/${s.of}` : null,
    s?.missing ? `${s.missing} missing` : null,
    s?.problems ? `${s.problems} problems` : null,
  ]
    .filter((x) => x != null && x !== "")
    .join(" ");

/** A reply as the owner meets it, for the transcript and the simulated owner. */
export function replyText(r) {
  if (!r || typeof r !== "object") return "(no reply)";
  if (r.type === "unanswered" || r.type === "stopped") return `(Luke did not answer: ${r.message ?? r.type})`;
  const lines = [r.message, r.type === "blueprint" ? r.blueprint?.summary : null];
  for (const q of Array.isArray(r.questions) ? r.questions : []) {
    lines.push(`- ${q?.question}${q?.suggestions?.length ? ` (${q.suggestions.join(" / ")})` : ""}`);
  }
  const plans = plansOf(r);
  if (plans.length) {
    lines.push(r.approved ? "[The design, built on the owner's yes:]" : "[A design, with a Build button:]");
    lines.push(...planLines(plans));
  }
  return lines.filter(words).join("\n");
}

/** Sections as a plan would make them: what a case's `before` leaves in the app. */
export const sectionsOfPlans = (plans) =>
  plans
    .filter((p) => p?.newModule)
    .map((p) => ({ nav_label: p.newModule.nav_label, columns: p.newSchema?.columns ?? [], features: p.features }));

const WHEN = {
  record_created: "when a row is added",
  record_updated: "when a row changes",
  before_save: "before a row is saved",
  store_row_added: "when the store brings in a row",
};

/** What is in the app, as lines a grader can quote. */
export function describeBuild(sections, rules) {
  const out = [];
  const names = new Map(sections.map((s) => [s.id, s.nav_label]));
  for (const s of sections) {
    out.push(`Section "${s.nav_label}"${s.source ? ` (rows from the store's ${s.source})` : ""}`);
    if (s.columns?.length) out.push(`  Fields: ${s.columns.map((c) => columnLine(c)).join(" · ")}`);
    const f = s.features ?? {};
    const views = [f.view, ...(Array.isArray(f.tabs) ? f.tabs : [])].filter(Boolean);
    if (views.length) {
      out.push(
        `  Shown as: ${views.map((v) => (v.type === "custom" ? `a written screen "${v.title ?? v.label ?? ""}"` : `${v.type}${v.groupBy ? ` by ${v.groupBy}` : ""}`)).join(", ")}`
      );
    }
    for (const v of views)
      if (v.type === "custom") out.push(`  Written screen "${v.title ?? ""}": ${short(v.html, 3000)}`);
    if (f.filters?.length) {
      out.push(`  Filters: ${f.filters.map((x) => `${x.label} (${(x.options ?? []).join(" / ")})`).join(" · ")}`);
    }
    if (f.stats?.length) {
      out.push(
        `  Counters: ${f.stats.map((x) => `${x.label}: ${x.op}${x.where ? ` where ${short(x.where, 160)}` : ""}${x.by ? ` by ${x.by}` : ""}`).join(" · ")}`
      );
    }
    if (f.period) out.push(`  Dates: over ${f.period.field}, ${(f.period.presets ?? [7, 30, 90]).join("/")} days`);
    if (f.actions?.length) out.push(`  Buttons: ${f.actions.map((a) => a.label).join(" · ")}`);
  }
  for (const r of rules) {
    const t = r.definition?.trigger ?? {};
    const when =
      t.type === "schedule" ? `every ${t.every ?? "run"}${t.at ? ` at ${t.at}` : ""}` : (WHEN[t.type] ?? t.type);
    const does = (r.definition?.actions ?? []).map((a) =>
      a?.type === "set_fields"
        ? `sets ${short(a.set, 200)}`
        : a?.type === "alert"
          ? `alerts "${a.title}"`
          : a?.type === "refuse"
            ? `refuses: "${a.message}"`
            : a?.type === "create_record"
              ? `adds a row ${short(a.data, 200)}`
              : a?.type === "run_code"
                ? "runs its own code"
                : a?.type
    );
    const where = names.get(r.module_id);
    out.push(
      `Rule "${r.name}"${where ? ` on ${where}` : ""}${r.enabled === false ? " (off)" : ""}: ${when}${t.when ? `, only when ${short(t.when, 240)}` : ""}; ${does.join("; ")}`
    );
  }
  return out.length ? out.join("\n") : "(nothing)";
}

// ── The signs code can see (supabase/migrations/0175, in JavaScript) ─

/** Words a field name shares that say nothing about which fact it is. */
const NOT_A_FACT = new Set(["status", "state", "type", "flag", "stage", "kind"]);

/**
 * 0175's workaround signs over one app: a schedule writing fields with no
 * condition, three or more yes/no or status fields sharing a word, and a
 * written screen over rows a table can show.
 */
export function workaroundSigns(sections, rules) {
  const out = [];
  for (const r of rules) {
    const d = r?.definition ?? {};
    if (
      r?.enabled !== false &&
      d.trigger?.type === "schedule" &&
      d.trigger.when == null &&
      (d.actions ?? []).some((a) => a?.type === "set_fields")
    ) {
      out.push(`Rule "${r.name}" sets fields on every row, every run`);
    }
  }
  for (const s of sections) {
    const byWord = new Map();
    for (const c of s.columns ?? []) {
      if (!["boolean", "badge", "dropdown"].includes(c?.type)) continue;
      for (const w of String(c.field ?? "").split("_")) {
        if (w.length >= 3 && !NOT_A_FACT.has(w)) byWord.set(w, [...(byWord.get(w) ?? []), c.field]);
      }
    }
    for (const [w, fields] of byWord) {
      if (fields.length >= 3) out.push(`${s.nav_label} has ${fields.length} fields for "${w}": ${fields.join(", ")}`);
    }
    const f = s.features ?? {};
    const written = [f.view, ...(Array.isArray(f.tabs) ? f.tabs : [])].some((v) => v?.type === "custom");
    if (written && (s.columns ?? []).length > 0)
      out.push(`${s.nav_label} has a written screen over rows a table shows`);
  }
  return out;
}

const JARGON =
  /\b(boolean|set_fields|schema|enum|longtext|varchar|json|uuid|null|module_id|record_created|record_updated|before_save|store_row_added|run_code|changeType|source_table)\b/gi;
const SNAKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi;

/** Builder's words in what the owner reads: a type, a rule's insides, a field's own name. */
export function jargonIn(text) {
  const found = new Set();
  for (const m of text.matchAll(JARGON)) found.add(m[0].toLowerCase());
  for (const m of text.matchAll(SNAKE)) found.add(m[0].toLowerCase());
  return [...found];
}

// ── The outcome, as code sees it (12 Oct) ───────────────────────────

const MULTIPLIER = {
  k: 1e3,
  thousand: 1e3,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  lacs: 1e5,
  crore: 1e7,
  crores: 1e7,
  cr: 1e7,
};

/**
 * The numbers in what Luke said, as an owner would read them: "₹31,735",
 * "31735.00", "3,17,350" (Indian grouping), "₹31.7k", "1.2 lakh". A number
 * written with a multiplier is approximate.
 */
export function numbersIn(text) {
  const out = [];
  const re = /(\d{1,3}(?:,\d{2,3})+|\d+)(?:\.(\d+))?(?:\s?(k|thousand|lakhs?|lacs?|crores?|cr)\b)?/gi;
  for (const m of String(text ?? "").matchAll(re)) {
    const whole = Number(m[1].replace(/,/g, ""));
    const value = m[2] ? Number(`${whole}.${m[2]}`) : whole;
    const times = m[3] ? MULTIPLIER[m[3].toLowerCase()] : 1;
    out.push({ value: value * times, approx: times > 1 });
  }
  return out;
}

/** One number matches another: exactly for a count, to the rupee for money, to 1% when written with a multiplier. */
const near = (n, e) =>
  n.approx ? Math.abs(n.value - e) <= Math.max(1, e * 0.01) : Math.abs(n.value - e) <= (e >= 1000 ? 1 : 0);

/** What an answer must hold: each item a check of its own. */
export function answerChecks(text, items) {
  const said = String(text ?? "");
  const found = numbersIn(said);
  return items.map((it) => {
    if (Array.isArray(it.names)) {
      const missing = it.names.filter((n) => !said.toLowerCase().includes(n.toLowerCase()));
      return {
        name: `answer: ${it.label}`,
        ok: missing.length === 0,
        detail: missing.length ? `not named: ${missing.join(", ")}` : `named ${it.names.join(", ")}`,
      };
    }
    if (it.re) {
      const ok = new RegExp(it.re, "i").test(said);
      return { name: `answer: ${it.label}`, ok, detail: ok ? "said" : `nothing matching /${it.re}/` };
    }
    const hit = found.find((n) => it.any.some((e) => near(n, e)));
    return {
      name: `answer: ${it.label}`,
      ok: !!hit,
      detail: hit
        ? `said ${hit.value}`
        : `expected ${it.any.filter((e, i, a) => a.indexOf(e) === i).join(" or ")}; said ${
            found
              .map((n) => n.value)
              .slice(0, 12)
              .join(", ") || "no number"
          }`,
    };
  });
}

const CANT = [
  /\b(?:i|we)\s+(?:can(?:'|’)?t|cannot|am unable to|are unable to|am not able to|don(?:'|’)?t have (?:a way|the ability|access))\b/i,
  /\b(?:this platform|this app|warmluke|the app)\s+(?:can(?:'|’)?t|cannot|doesn(?:'|’)?t (?:support|let|allow|connect))/i,
  /\bnot (?:possible|supported) (?:here|in (?:this|the) app|on this platform|yet)\b/i,
  /\b(?:nahi|nahin|nhi)\s+(?:kar|bhej|dekh|jod|bana|padh)\s?(?:sakta|sakti|sakte|paunga|paaunga|payega)\b/i,
  /\b(?:possible|support)\s+nahi\b/i,
];

/** Where Luke says it cannot do something: the words, or none. */
export function cantIn(text) {
  const said = String(text ?? "");
  return CANT.map((re) => said.match(re)?.[0]).filter(Boolean);
}

/** No "I can't" where the platform can; a plain one where it can't. */
export const capableCheck = (text) => {
  const said = cantIn(text);
  return { name: "capable", ok: said.length === 0, detail: said.length ? `said "${said[0]}"` : "never said it can't" };
};
export const honestCheck = (text) => {
  const said = cantIn(text);
  return {
    name: "honest",
    ok: said.length > 0,
    detail: said.length ? `said "${said[0]}"` : "never said plainly that it can't",
  };
};

/** A vague ask is met with a question, and nothing drawn yet. */
export function asksFirstCheck(replies) {
  const r = replies[0];
  const asked = (Array.isArray(r?.questions) && r.questions.length > 0) || /\?/.test(ownerText(r));
  const drew = plansOf(r).length > 0;
  return {
    name: "asks first",
    ok: asked && !drew,
    detail: drew ? "drew a design before asking" : asked ? "asked first" : "neither asked nor drew",
  };
}

/** Reached the goal in at most `max` builds; on a change, edited what was there rather than made again. */
export function buildChecks(builds, builtPlans, { max, edited }) {
  const out = [];
  if (max !== undefined) {
    out.push({
      name: "builds",
      ok: builds >= 1 && builds <= max,
      detail: `${builds} build${builds === 1 ? "" : "s"}, at most ${max}`,
    });
  }
  if (edited) {
    const deleted = builtPlans.filter((p) => p?.changeType === "MODULE_DELETE");
    const made = builtPlans
      .filter((p) => p?.changeType === "NEW_MODULE")
      .map((p) => p.newModule?.nav_label ?? p.newModule?.name);
    const twice = made.filter((n, i) => made.indexOf(n) !== i);
    out.push({
      name: "edited, not made again",
      ok: deleted.length === 0 && twice.length === 0,
      detail: deleted.length
        ? "a section was deleted"
        : twice.length
          ? `"${twice[0]}" was made twice`
          : "changed in place",
    });
  }
  return out;
}

const own = (s, c) => !s.table || !!c.compute || !s.storeFields.has(c.field);
const marked = (v) => v === true || (typeof v === "string" && /^(true|yes|y)$/i.test(v.trim()));
const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/** The sections an expectation is about: over one of its store lists, or of the owner's with a matching name. */
export const sectionsFor = (sections, e) =>
  sections.filter((s) =>
    s.table ? (e.tables ?? []).includes(s.table) : !!e.own && new RegExp(e.own, "i").test(s.name)
  );

/**
 * The rows a build points at: some field of the owner's, or one worked out,
 * marks exactly the expected rows (a tick, one badge or choice, or text
 * filled in), or a counter shows how many, or a rule's dry run matches that
 * many. Whatever Luke named it. `sections`: { name, table, storeFields, columns, rows, stats }.
 */
export function effectCheck(sections, e, dryRuns = []) {
  const notes = [];
  for (const s of sectionsFor(sections, e)) {
    const expected = new Set(s.rows.filter((r) => e.match(r)).map((r) => r.id));
    if (expected.size !== e.count) notes.push(`${s.name} holds ${expected.size} of the ${e.count} expected rows`);
    for (const c of s.columns.filter((c) => own(s, c))) {
      const sets = new Map();
      for (const r of s.rows) {
        const v = r[c.field];
        if (c.type === "boolean" ? marked(v) : typeof v === "string" && v.trim() !== "") {
          const key = c.type === "boolean" ? "ticked" : v.trim();
          sets.set(key, (sets.get(key) ?? new Set()).add(r.id));
          if (c.type !== "boolean") sets.set("filled", (sets.get("filled") ?? new Set()).add(r.id));
        }
      }
      for (const [k, set] of sets)
        if (same(set, expected))
          return {
            name: "effect",
            ok: true,
            detail: `${s.name}: "${c.label}" (${k}) marks exactly ${e.labels.join(", ")}`,
          };
    }
    for (const st of s.stats ?? [])
      if (Number(st.value) === e.count)
        return { name: "effect", ok: true, detail: `${s.name}: the counter "${st.label}" shows ${e.count}` };
  }
  for (const d of dryRuns)
    if (d.matched === e.count)
      return { name: "effect", ok: true, detail: `the rule "${d.rule}" matches ${e.count} rows` };
  const looked = sectionsFor(sections, e).map((s) => s.name);
  return {
    name: "effect",
    ok: false,
    detail: `nothing marks exactly ${e.labels.join(", ")}${looked.length ? ` (looked at ${looked.join(", ")})` : " (no section over those rows)"}${notes.length ? `; ${notes.join("; ")}` : ""}`,
  };
}

/** After the owner's writes, the expected rows all show one of the expected values in some field of the owner's. */
export function valuesCheck(sections, t) {
  for (const s of sectionsFor(sections, t)) {
    const rows = s.rows.filter((r) => t.match(r));
    if (!rows.length) continue;
    // The field that ties a row to its blank holds words, never one of these numbers: no need to set it aside.
    for (const c of s.columns.filter((c) => own(s, c))) {
      if (rows.every((r) => t.equals.includes(Number(r[c.field]))))
        return {
          name: "works when used",
          ok: true,
          detail: `${s.name}: "${c.label}" shows ${rows.map((r) => r[c.field]).join(", ")} on ${t.labels.join(", ")}`,
        };
    }
  }
  return {
    name: "works when used",
    ok: false,
    detail: `no field shows ${t.equals.join(" or ")} on ${t.labels.join(", ")}`,
  };
}

/** A column of the owner's whose name or label fits `pattern`, not one already taken. */
export const pickColumn = (columns, pattern, taken = new Set()) =>
  columns.find((c) => !taken.has(c.field) && new RegExp(pattern, "i").test(`${c.field} ${c.label}`)) ?? null;

/** The checks a case's expectation asks for, from what was said and built and what the app now holds. */
export function outcomeChecks(c, x, { replies, builds, builtPlans, sections = [], dryRuns = [], exercised = null }) {
  const text = replies.map(replyText).join("\n");
  const e = c.expect ?? {};
  const kind = c.kind ?? "build";
  const out = [];
  if (x.answer) out.push(...answerChecks(text, x.answer));
  if (x.effect) out.push(effectCheck(sections, x.effect, dryRuns));
  if (x.exercise) out.push(exercised ?? { name: "works when used", ok: false, detail: "not exercised" });
  if (e.asks_first) out.push(asksFirstCheck(replies));
  if (kind === "limit" || e.honest) out.push(honestCheck(text));
  else out.push(capableCheck(text));
  out.push(...buildChecks(builds, builtPlans, { max: e.builds, edited: e.edited }));
  if (e.opens) out.push({ name: "opens their store when asked", ok: replies.some((r) => r?.open_store === true) });
  if (e.talks) {
    const early = replies.slice(0, e.talks);
    out.push({
      name: `talks for ${e.talks} replies before drawing anything`,
      ok: early.every((r) => plansOf(r).length === 0 && r?.type !== "blueprint" && r?.type !== "plans"),
    });
  }
  return out;
}

// ── The simulated owner and the grader ──────────────────────────────

/** The JSON object in a model's reply, fenced or not; null when there is none. */
export function jsonOf(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/```(?:json)?/gi, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(s.slice(a, b + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const transcriptLines = (lines) =>
  lines
    .map((l, i) => `${i + 1}. ${l.who === "owner" ? "Owner" : l.who === "luke" ? "Luke" : "App"}: ${l.text}`)
    .join("\n");
const factLines = (c) =>
  Object.entries(c.facts)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

export function simSystem(c, pushedBack) {
  const hinglish = c.language === "hinglish";
  return [
    "You play a shop owner talking to Luke, the assistant that builds their business app. Stay in character: you are the owner, not an assistant.",
    `Who you are: ${c.persona}`,
    hinglish
      ? "Write in Hinglish (Hindi in Latin letters, mixed with English), short, like a busy owner on a phone."
      : "Write in plain English, short, like a busy owner on a phone.",
    // A simulated owner once pushed back on a rule over every row by asking for
    // no rule at all, a hand tick: the case's own need gone, and Luke graded on
    // the need it then did not build (12 Oct). Pushback corrects the how.
    `What you asked for, which stays your need the whole way: "${c.opening}". Your answers and your pushback never drop it or swap it for something else; they only correct how it is done.`,
    `What you know. Answer Luke's questions only from this:\n${factLines(c)}`,
    `When Luke asks something not covered above, say "${hinglish ? "aap decide karo" : "you decide"}". Never invent anything else.`,
    `What would be wrong for you:\n${c.must_not.map((s) => `- ${s}`).join("\n")}`,
    [
      "How to answer:",
      "- Answer what Luke asked, in a line or two, with no technical words: no field types and no field names.",
      "- When Luke has said a plan or shown a design that fits what you asked for, agree.",
      pushedBack
        ? "- You have pushed back once already. Do not push back again: agree with the plan as it stands."
        : '- When it plainly does something on your wrong list, push back once, in plain words, as an owner would ("no, not a separate status, just one tick"), and do not agree in the same message.',
    ].join("\n"),
    'Reply with JSON only: {"agree": true or false, "pushback": true or false, "say": "what you write to Luke"}',
  ].join("\n\n");
}

export const simInput = (lines) =>
  `The conversation so far:\n${transcriptLines(lines)}\n\nLuke's reply is the last line. Write your answer.`;

/** What the simulated owner said; a reply that is not JSON is taken as words, not a yes. */
export function parseSim(raw) {
  const j = jsonOf(raw);
  if (!j) return { agree: false, pushback: false, say: String(raw ?? "").trim() };
  return { agree: j.agree === true, pushback: j.pushback === true, say: typeof j.say === "string" ? j.say.trim() : "" };
}

export const GRADE_SYSTEM = `You are a strict reviewer grading one conversation between a shop owner and Luke, the assistant that designs their business app, and what is in the app at the end.

You default to "not met". A criterion is met only when the conversation or the app shows it, and every yes needs evidence: an exact quote of a few words, copied character for character from THE APP BEFORE, THE CONVERSATION or WHAT IS IN THE APP NOW, written in double quotes, with no speaker's name and no remark around it. No quote, no yes; a paraphrase is not evidence. A must-not item is hit when the material shows it; quote that too. When you cannot tell, it is not met, and a must-not you cannot rule out is hit. A criterion that begins with "if" is judged only when its condition happened; when it did not, it is met, with a quote that shows it did not (the app's list of what was built, say).

Two items are judged over the whole conversation, not its last message. "Ends by asking whether to build" is met when the turn before the design was built ended by asking for the owner's yes; the message after the build need not ask again. A must-not about what is built (a rule, a field, a section) is judged on WHAT IS IN THE APP NOW: an idea Luke offered and dropped when the owner said no is not a hit. A must-not about Luke's words is judged on everything Luke said.

A perfect score is suspicious. Before giving any 5, look again for what could be simpler or clearer; give 5 only when nothing could.

Scores, 1 to 5:
- discussed: did Luke say the plan and get the owner's yes before building? 1 built straight away; 5 said the plan, asked only what was unclear, built on the yes.
- plain: were Luke's words plain for an owner, with no field names, types or technical terms? The lines under "[A design…]" are the card the app draws, not Luke's words: the owner sees each field's label there, and the kind in brackets is only for you.
- better_idea: did Luke offer a simpler or better way than what was literally asked, where there was one? 3 when there was nothing better to offer.
- simplest: is what was built the simplest design that does the job: fewest fields, no fact kept twice, no rule where a setting does, no written screen where a table does?

Reply with JSON only, one entry per numbered item:
{"criteria":[{"n":1,"met":false,"evidence":""}],"must_not":[{"n":1,"hit":false,"evidence":""}],"scores":{"discussed":1,"plain":1,"better_idea":1,"simplest":1}}`;

export function gradeInput(c, beforeText, lines, nowText) {
  return [
    `CASE: ${c.title}`,
    `WHAT THE OWNER KNEW (the facts they answered from):\n${factLines(c)}`,
    `THE APP BEFORE:\n${beforeText}`,
    `THE CONVERSATION:\n${transcriptLines(lines)}`,
    `WHAT IS IN THE APP NOW:\n${nowText}`,
    `SUCCESS CRITERIA:\n${c.success.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
    `MUST NOT:\n${c.must_not.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
  ].join("\n\n");
}

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const unquote = (s) => s.replace(/^["'\s]+|["'\s.]+$/g, "");

/**
 * Whether the evidence quotes the material. A grader writes evidence as
 * Luke: 'a few words…' or with a remark around the quote, so the quoted
 * pieces are taken out and one of eight characters or more must be in the
 * material word for word (each piece split at ellipses). With nothing in
 * quotes, the evidence itself is the quote, less a speaker's name. The
 * whole evidence string held to that read every real quote as made up
 * (3 Oct: a pass rate of none, on yeses the transcript bore out).
 */
export function quoteFound(quote, material) {
  const seen = norm(material);
  const text = norm(String(quote ?? "")).replace(/^\s*(?:luke|owner|the owner|app)\s*:\s*/, "");
  const quoted = [...text.matchAll(/"([^"]{3,})"|'([^']{3,})'/g)].map((m) => m[1] ?? m[2]);
  const pieces = (quoted.length ? quoted : [unquote(text)])
    .flatMap((q) => q.split(/\s*(?:\.\.\.|…)\s*/))
    .map((p) => unquote(p).trim())
    .filter((p) => p.length >= 8);
  if (pieces.length === 0) {
    const whole = unquote(text);
    return whole.length >= 3 && seen.includes(whole);
  }
  return pieces.some((p) => seen.includes(p));
}

const score = (v) => {
  const n = Math.round(Number(v));
  return n >= 1 && n <= 5 ? n : 1;
};
const at = (list, n) => (Array.isArray(list) ? list.find((x) => Number(x?.n) === n) : null);
const evidenceOf = (a) => (typeof a?.evidence === "string" ? a.evidence.trim().slice(0, 300) : "");

/**
 * The grader's verdict, held to its own rules: a yes stands only with a
 * quote that is really in the material, a must-not stands clear only when
 * the grader said so, and a score it did not give is a 1.
 */
export function parseGrade(raw, success, mustNot, material) {
  const j = jsonOf(raw);
  const criteria = success.map((text, i) => {
    const a = at(j?.criteria, i + 1);
    const evidence = evidenceOf(a);
    const met = a?.met === true && quoteFound(evidence, material);
    const why =
      a?.met === true && !met
        ? evidence
          ? "(not counted: the quote is not in the material) "
          : "(not counted: no quote) "
        : "";
    // What the grader said, before its quote was checked: the same measure on every run, kept beside "met".
    return { text, met, said: a?.met === true, evidence: `${why}${evidence}` };
  });
  const must_not = mustNot.map((text, i) => {
    const a = at(j?.must_not, i + 1);
    return { text, hit: a?.hit !== false, evidence: a ? evidenceOf(a) : "(no answer from the grader)" };
  });
  const scores = Object.fromEntries(SCORE_KEYS.map((k) => [k, score(j?.scores?.[k])]));
  return { ok: !!j, criteria, must_not, scores };
}

/**
 * Every section of the app with its rows as the owner's screen and the
 * rules see them (lib/dry-run readSection, on the owner's client), its
 * store fields named so a field of the owner's can be told apart, and its
 * counters worked out by lib/expr over those rows. The app's modules come
 * in `d`, so a check can hand them in.
 */
export async function appSections(ctx, mods, schemas, d) {
  const out = [];
  for (const m of mods) {
    const at = d.sectionFor(ctx, [], m.id);
    if (!at || "made" in at) continue;
    const read = await d.readSection(ctx, at).catch(() => null);
    if (!read) continue;
    const stats = (schemas.get(m.id)?.features?.stats ?? [])
      .filter((st) => !st.by)
      .map((st) => {
        const rows = read.rows.filter((r) => st.where === undefined || d.truthy(d.evalExpr(st.where, r)));
        const nums = rows
          .map((r) => Number(st.value !== undefined ? d.evalExpr(st.value, r) : r[st.field]))
          .filter(Number.isFinite);
        const total = nums.reduce((a, b) => a + b, 0);
        const value =
          st.op === "count"
            ? rows.length
            : st.op === "sum"
              ? total
              : st.op === "avg"
                ? nums.length
                  ? total / nums.length
                  : null
                : nums.length
                  ? (st.op === "min" ? Math.min : Math.max)(...nums)
                  : null;
        return { label: st.label, value };
      });
    out.push({
      name: at.name,
      table: at.table,
      storeFields: new Set(
        at.table
          ? String(d.STORE_TABLES[at.table].select)
              .split(",")
              .map((f) => f.trim())
          : []
      ),
      columns: at.columns,
      rows: read.rows,
      stats,
    });
  }
  return out;
}

// ── The conversation ────────────────────────────────────────────────

/**
 * One case's conversation, as the panel has it: the opening, Luke's reply,
 * the simulated owner's answer, a design built on their yes; then, while
 * the case has follow-ups, the next one said after each build. Everything
 * it touches is in `io`, so check-eval-harness plays it with a Luke and an
 * owner of its own and no money is spent:
 *
 *   io.turn(n, costs)         before each of Luke's turns (the cap)
 *   io.chat(message, thread)  → { reply, conversationId, answerId, ms, usd, trace }
 *   io.build(plans, thread)   → { ok, errors }
 *   io.sim(lines, pushedBack) → { said: { agree, pushback, say }, usd }
 *   io.lines, io.trace        arrays to say and trace into, so a run the cap stops keeps them
 */
export async function converse(c, io) {
  const lines = io.lines ?? [];
  const trace = io.trace ?? [];
  const costs = [];
  const ms = [];
  const replies = [];
  const builtPlans = [];
  const jargon = new Set();
  const followUps = [...(c.follow_ups ?? [])];
  let conversationId = null;
  // The first meeting: Luke speaks first, then the owner's opening (lib/meet).
  let message = c.meeting ? "" : c.opening;
  let builds = 0;
  let proposed = false;
  let proposedFirst = null;
  let pushedBack = false;
  let simUsd = 0;

  for (let turn = 1; turn <= c.max_turns; turn++) {
    await io.turn?.(turn, costs);
    lines.push({ who: "owner", text: message || "(opens Warmluke for the first time)" });
    const t = await io.chat(message, conversationId);
    conversationId = t.conversationId ?? conversationId;
    ms.push(t.ms);
    costs.push(t.usd);
    trace.push({ turn, ...t.trace });
    const reply = t.reply;
    replies.push(reply);
    lines.push({ who: "luke", text: replyText(reply).slice(0, 2000) });
    for (const w of jargonIn(ownerText(reply))) jargon.add(w);
    if (isProposal(reply)) proposed = true;
    if (reply?.type === "unanswered" || reply?.type === "stopped") break;
    // They went into their store: the meeting is over.
    if (reply?.open_store === true) break;
    // Luke spoke first; now the owner's own first words.
    if (c.meeting && turn === 1) {
      message = c.opening;
      continue;
    }
    // A question is done once it is answered: another turn would only be paid for.
    if ((c.kind ?? "build") === "question" && !(Array.isArray(reply?.questions) && reply.questions.length)) break;

    const plans = plansOf(reply);
    const buildIt = async () => {
      const done = await io.build(plans, {
        conversationId,
        designId: t.answerId,
        sent: plans.map((_, i) => i),
        next: reply.next ?? reply.blueprint?.next,
      });
      lines.push({ who: "app", text: done.ok ? "Built." : `The build was refused: ${done.errors.join("; ")}` });
      if (!done.ok) return false;
      builds += 1;
      builtPlans.push(...plans);
      // Whether a plan in words came before the first build: what the signs count.
      if (proposedFirst === null) proposedFirst = proposed;
      return true;
    };

    let built = false;
    // Agreed in words and drawn: built at once, as the panel does.
    if (plans.length && reply.approved) built = await buildIt();
    else {
      if (turn === c.max_turns) break;
      const sim = await io.sim(lines, pushedBack);
      simUsd += sim.usd;
      const said = sim.said;
      if (said.pushback) pushedBack = true;
      // A drawn design they agree to is the card's Build button.
      if (plans.length && said.agree) {
        lines.push({ who: "owner", text: "(taps Build)" });
        built = await buildIt();
      } else {
        // A yes to a plan in words is said as the panel's "Build it" would be: plainly.
        message =
          said.agree && isProposal(reply)
            ? YES[c.language]
            : said.say || (said.agree ? YES[c.language] : DECIDE[c.language]);
        continue;
      }
    }
    // After a build: the case's next follow-up, said fresh, or the end.
    if (!built || followUps.length === 0) break;
    message = followUps.shift();
    pushedBack = false;
  }

  return {
    lines,
    trace,
    costs,
    ms,
    replies,
    builds,
    builtPlans,
    jargon: [...jargon],
    proposedFirst: proposedFirst ?? proposed,
    simUsd,
    conversationId,
  };
}

// ── The cap ─────────────────────────────────────────────────────────

export class CapReached extends Error {}

/** Spend kept against a cap: before() refuses, ahead of the call, whatever could pass it. */
export function capMeter(cap) {
  let spent = 0;
  return {
    get spent() {
      return spent;
    },
    before(estimate, what) {
      if (spent + estimate > cap) {
        throw new CapReached(
          `stopped before ${what}: it is counted at $${estimate.toFixed(3)}, and $${spent.toFixed(3)} is spent of $${cap}`
        );
      }
    },
    add(usd) {
      spent += usd;
    },
  };
}

/** Dollars a call could cost, from what is sent and the reply it is counted at; Infinity with no price. */
export function estimateUsd(model, inputChars, outputTokens) {
  const p = priceOf(model);
  if (!p) return Infinity;
  // About four characters a token in English; Hinglish and JSON run shorter. At the
  // cache-write price, which the first block of a call may pay.
  const input = Math.ceil(inputChars / 3.5);
  return (input * Math.max(p.input, p.cacheWrite) + outputTokens * p.output) / 1e6;
}

/** A Luke turn before it is made: the case's average so far when dearer than LUKE_TURN_USD. */
export const lukeEstimate = (caseTurns) =>
  Math.max(LUKE_TURN_USD, caseTurns.length ? caseTurns.reduce((a, b) => a + b, 0) / caseTurns.length : 0);

// ── Where a run is written ──────────────────────────────────────────

const two = (n) => String(n).padStart(2, "0");

/** evals/runs/<YYYYMMDD-HHMM>-<label>.json, in UTC. */
export function runFileName(t, label) {
  return `${t.getUTCFullYear()}${two(t.getUTCMonth() + 1)}${two(t.getUTCDate())}-${two(t.getUTCHours())}${two(t.getUTCMinutes())}-${label}.json`;
}

/** evals/runs/all.ts: every run file imported by name, for the page to read at build. */
export function runModule(files) {
  return [
    "// Written by scripts/eval-luke.mjs after every run; not edited by hand. Every",
    "// run file, imported, so the console's Evals page reads them with no database.",
    "",
    'import type { EvalRun } from "@/lib/eval-report";',
    ...files.map((f, i) => `import r${i} from "./${f}";`),
    "",
    files.length
      ? [
          "export const RUN_FILES: Record<string, EvalRun> = {",
          ...files.map((f, i) => `  "${f}": r${i} as unknown as EvalRun,`),
          "};",
        ].join("\n")
      : "export const RUN_FILES: Record<string, EvalRun> = {};",
    "",
  ].join("\n");
}

function writeRun(run) {
  const file = runFileName(new Date(run.started), run.label);
  writeFileSync(new URL(file, RUNS_DIR), `${JSON.stringify(run, null, 2)}\n`);
  const indexFile = new URL("index.json", RUNS_DIR);
  const index = JSON.parse(readFileSync(indexFile, "utf8")).filter((e) => e.file !== file);
  index.push({ file, label: run.label, started: run.started, summary: run.summary });
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(new URL("all.ts", RUNS_DIR), runModule(index.map((e) => e.file)));
  return file;
}

// ── The run ─────────────────────────────────────────────────────────

const usd = (n) => `$${n.toFixed(3)}`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const refuse = (why) => {
  console.log(`eval-luke: ${why}; nothing asked, nothing spent`);
  process.exit(2);
};
/** A Supabase project's ref, from its address. */
const ref = (u) => {
  try {
    return new URL(u).hostname.split(".")[0];
  } catch {
    return null;
  }
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) refuse(args.error);

  const envFile = process.env.ENV_FILE ?? ".env.check.local";
  let fromFile = {};
  try {
    fromFile = Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split("\n")
        .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")])
    );
  } catch {
    refuse(`${envFile} cannot be read`);
  }
  const env = { ...fromFile, ...process.env };
  if (env.CHECK_PROJECT !== "1") refuse(`${envFile} is not the check project's (CHECK_PROJECT=1), and this writes`);
  const APP = process.env.APP_URL;
  if (!APP) refuse("APP_URL is not set: name the running app (http://localhost:3101)");
  // Its own calls are never taped: a recording would put the simulated owner into tapes/.
  if (process.env.MODEL_TAPE) refuse("MODEL_TAPE is set; this makes its calls for real and records none, so unset it");
  const simModel = env.EVAL_SIM_MODEL;
  const gradeModel = env.EVAL_GRADE_MODEL;
  if (!simModel || !gradeModel) refuse("EVAL_SIM_MODEL and EVAL_GRADE_MODEL name the owner's and the grader's models");
  for (const m of [simModel, gradeModel]) {
    if (!priceOf(m)) refuse(`${m} has no price in src/lib/model-prices.ts, so no cap could be held`);
    const key = m.startsWith("gemini") ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
    if (!env[key]) refuse(`no ${key} for ${m}`);
  }
  // The model layer reads its key from the environment, as the server does.
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_API_URL", "GEMINI_API_KEY"]) {
    if (!process.env[k] && env[k]) process.env[k] = env[k];
  }

  const all = loadCases();
  const broken = all.flatMap(({ file, case: c }) => caseProblems(c, file).map((p) => `${file}: ${p}`));
  if (broken.length) refuse(`the cases are not whole:\n  ${broken.join("\n  ")}`);
  const unknown = (args.cases ?? []).filter((id) => !all.some((x) => x.case.id === id));
  if (unknown.length) refuse(`no case called ${unknown.join(", ")}`);
  const cases = selectCases(
    all.map((x) => x.case),
    args
  );
  if (cases.length === 0) refuse("no case to run");

  // The server must be on the env file's database, or every write lands somewhere else.
  const served = await fetch(`${APP}/.well-known/oauth-protected-resource`)
    .then((r) => r.json())
    .then((d) => ref(d.authorization_servers?.[0]))
    .catch(() => null);
  const mine = ref(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL);
  if (!served) refuse(`no app answers at ${APP}`);
  if (served !== mine) refuse(`the app at ${APP} is built for ${served}, but ${envFile} names ${mine}`);

  // The app's TypeScript ("@/lib/…") from here on.
  register("./ts-hook-resolve.mjs", import.meta.url);
  const { createClient } = await import("@supabase/supabase-js");
  const { signInAsCheckUser, throwawayProject } = await import("./owner-session.mjs");
  const { readTurn } = await import("./turn-lines.mjs");
  const { SEED_CURRENCY, SEED_TIMEZONE, seedNodes, seedShop } = await import("./fixtures/seed-shop.ts");
  const { seedBusiness, shopNodes } = await import("./fixtures/business-shop.ts");
  const { dryRunRules, readSection, sectionFor } = await import("../src/lib/dry-run.ts");
  const { STORE_TABLES } = await import("../src/lib/store-read.ts");
  const { evalExpr, truthy } = await import("../src/lib/expr.ts");
  const { RESOURCES } = await import("../src/lib/shopify-resources.ts");
  const { callModel } = await import("../src/lib/ai.ts");
  const { metered } = await import("../src/lib/usage.ts");

  const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
  const anon = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
  // Signed in again for each case: a session lasts about an hour, and a run can take longer.
  const signIn = async () => {
    const me = await signInAsCheckUser(anon, env);
    if (!me.session) throw new Error(`no check user: ${me.why}`);
    return me;
  };
  const first = await signIn();

  // The model the turns are made on, as the chat route will choose it: a pick
  // the account may not use is silently the default there, so it is refused here.
  const offer = await fetch(`${APP}/api/models`, {
    headers: { Authorization: `Bearer ${first.session.access_token}` },
  }).then((r) => r.json());
  const allowed = (offer.models ?? []).map((m) => m.id);
  if (args.designModel && !allowed.includes(args.designModel)) {
    refuse(`the check account may not use ${args.designModel}; it may use ${allowed.join(", ") || "none"}`);
  }
  const designModel = args.designModel ?? offer.default ?? "the server's default";

  const gradeReserve = estimateUsd(gradeModel, GRADE_IN_CHARS, GRADE_OUT_TOKENS);
  console.log(
    `Luke eval "${args.label}": ${cases.length} case${cases.length === 1 ? "" : "s"}, stops before $${args.maxUsd}`
  );
  console.log(`  cases: ${cases.map((c) => c.id).join(", ")}`);
  console.log(`  app: ${APP} (project ${served}) · design model: ${designModel}`);
  console.log(`  simulated owner: ${simModel} · grader: ${gradeModel}`);
  console.log(
    `  counted before measured: a Luke turn ${usd(LUKE_TURN_USD)}, an owner's line about ${usd(estimateUsd(simModel, 6000, SIM_OUT_TOKENS))}, a grading ${usd(gradeReserve)}`
  );

  // Designs are counted against an allowance; an eval must not run out halfway. Put back after.
  const { data: was } = await admin
    .from("account_settings")
    .select("turns_unlimited")
    .eq("user_id", first.user.id)
    .single();
  await admin.from("account_settings").update({ turns_unlimited: true }).eq("user_id", first.user.id);

  const meter = capMeter(args.maxUsd);

  /** A model call of the harness's own, metered and priced as Luke's are; `reserve` is kept back for grading. */
  const ask = async (model, system, content, outTokens, what, reserve) => {
    const estimate = estimateUsd(model, system.length + content.length, outTokens);
    meter.before(estimate + reserve, what);
    const [raw, took] = await metered(() => callModel({ system, turns: [{ role: "user", content }], model }));
    const spent = took()?.usd ?? estimate;
    meter.add(spent);
    return { raw, spent };
  };

  // The case being run, so a run the cap stops keeps what it said and traced (4 Oct: one did not).
  let inFlight = null;
  async function runCase(c) {
    const me = await signIn();
    const token = me.session.access_token;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const project = await throwawayProject(admin, me.user.id, `eval ${c.id}`);
    // A meeting case meets Luke as a new owner would: not yet let into a store, put back after.
    const { data: profile } = c.meeting
      ? await admin.from("profiles").select("met_luke_at").eq("user_id", me.user.id).maybeSingle()
      : { data: null };
    if (c.meeting) await admin.from("profiles").update({ met_luke_at: null }).eq("user_id", me.user.id);
    try {
      // The case's shop, as e2e/shop.ts makes the seed: every case has a store to build on.
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const shop = c.shop ?? "seed";
      const { data: store, error } = await admin
        .from("stores")
        .insert({
          project_id: project.id,
          provider: "shopify",
          status: "connected",
          shop_domain: `eval-${project.id.slice(0, 8)}.myshopify.com`,
          access_token: "eval-token-opens-nothing",
          currency: SEED_CURRENCY,
          timezone: SEED_TIMEZONE,
          country: "IN",
          connected_at: now,
          last_synced_at: now,
          granted_scopes: ["read_orders", "read_products", "read_customers", "read_inventory"],
        })
        .select("id")
        .single();
      if (error) throw new Error(`could not make the case's store: ${error.message}`);
      const nodes = shop === "seed" ? seedNodes(nowMs) : shopNodes(SHOPS[shop], nowMs);
      if (shop === "seed") await seedShop(admin, store.id, nowMs);
      else await seedBusiness(admin, store.id, SHOPS[shop], nowMs);
      await admin.from("import_runs").insert(
        RESOURCES.map((resource) => ({
          store_id: store.id,
          resource,
          status: "done",
          imported: nodes[resource].length,
          started_at: new Date(nowMs - 60_000).toISOString(),
          finished_at: now,
        }))
      );
      // What it expects, from the very nodes just seeded.
      const expected = expectationFor(c, viewOf(nodes, nowMs));

      // As AppShell's buildNow sends it: the plans, and the thread to write the build into.
      const build = async (plans, thread) => {
        const r = await fetch(`${APP}/api/apply`, {
          method: "POST",
          headers,
          body: JSON.stringify({ projectId: project.id, plans, ...(thread ? { thread } : {}) }),
        });
        const data = await r.json().catch(() => ({}));
        return { ok: r.ok && data.applied === true, errors: data.errors ?? (data.error ? [data.error] : []) };
      };
      const before = fillDates(c.before, nowMs);
      if (before.length) {
        const made = await build(before, null);
        if (!made.ok) throw new Error(`${c.id}: its "before" would not build: ${made.errors.join("; ")}`);
      }

      const lines = [];
      const trace = [];
      inFlight = { id: c.id, title: c.title, transcript: lines, trace };

      // The stream may end before a durable turn does: its answer's line is what settles it.
      const settle = async (id) => {
        const until = Date.now() + SETTLE_MS;
        while (Date.now() < until) {
          const { data } = await admin.from("messages").select("payload").eq("id", id).maybeSingle();
          if (data?.payload && data.payload.type !== "answering") return data.payload;
          await pause(1000);
        }
        throw new Error(`${c.id}: Luke's turn did not settle in ${SETTLE_MS / 60_000} minutes`);
      };
      // The turn's trace, a moment later: its usage (the reply carries it
      // only for the team), its steps, and what the validator refused.
      const traceOf = async (id) => {
        for (let i = 0; i < 20; i++) {
          const { data } = await admin
            .from("turn_traces")
            .select("usage, steps, repairs, repair_errors")
            .eq("turn_id", id)
            .maybeSingle();
          if (data) return data;
          await pause(500);
        }
        return null;
      };

      const talk = await converse(c, {
        lines,
        trace,
        turn: (turn, costs) => meter.before(lukeEstimate(costs) + gradeReserve, `Luke's turn ${turn} of ${c.id}`),
        chat: async (message, conversationId) => {
          const t0 = Date.now();
          const res = await fetch(`${APP}/api/chat`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              projectId: project.id,
              message,
              conversationId,
              ...(c.meeting ? { meet: true } : {}),
              ...(args.designModel ? { model: args.designModel } : {}),
            }),
          });
          // A server playing its calls back from tapes answers from the past: nothing measured.
          const tape = res.headers.get("x-model-tape");
          if (tape)
            throw new Error(
              `the app at ${APP} plays its model calls back (MODEL_TAPE=${tape}); start one that calls the model`
            );
          const read = await readTurn(res);
          if (read.status !== 200)
            throw new Error(`${c.id}: Luke refused the turn (${read.status}): ${read.data.error ?? ""}`);
          const accepted = read.steps.find((s) => s.step === "accepted");
          const answerId = accepted?.turn ?? read.data.replyId;
          if (!answerId) throw new Error(`${c.id}: the turn named no line for its answer`);
          const reply = await settle(answerId);
          const took = Date.now() - t0;
          const t = await traceOf(answerId);
          const usage = reply.usage ?? t?.usage ?? null;
          if (!usage) console.log(`  (a turn of ${c.id} left no usage; counted at its estimate)`);
          else if (usage.partial) console.log(`  (a turn of ${c.id} used a model with no price; its cost is short)`);
          const usdSpent = usage?.usd ?? LUKE_TURN_USD;
          meter.add(usdSpent);
          const step = {
            repairs: t?.repairs ?? 0,
            refused: (Array.isArray(t?.repair_errors) ? t.repair_errors : []).map((e) => String(e).slice(0, 300)),
            steps: (Array.isArray(t?.steps) ? t.steps : []).map(stepLine),
          };
          return {
            reply,
            conversationId: accepted?.conversationId ?? read.data.conversationId,
            answerId,
            ms: took,
            usd: usdSpent,
            trace: step,
          };
        },
        build,
        sim: async (sofar, pushedBack) => {
          const sim = await ask(
            simModel,
            simSystem(c, pushedBack),
            simInput(sofar),
            SIM_OUT_TOKENS,
            "the simulated owner",
            gradeReserve
          );
          return { said: parseSim(sim.raw), usd: sim.spent };
        },
      });

      // What is in the app now, read past RLS: every section's newest schema, every rule.
      const { data: mods } = await admin.from("modules").select("*").eq("project_id", project.id);
      const sections = [];
      const schemas = new Map();
      for (const m of mods ?? []) {
        const { data: s } = await admin
          .from("ui_schemas")
          .select("schema_json")
          .eq("module_id", m.id)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (s?.schema_json) schemas.set(m.id, s.schema_json);
        sections.push({
          id: m.id,
          nav_label: m.nav_label,
          source: m.source_table ?? null,
          columns: s?.schema_json?.columns ?? [],
          features: s?.schema_json?.features ?? null,
        });
      }
      const { data: rules } = await admin
        .from("automations")
        .select("name, enabled, definition, module_id")
        .eq("project_id", project.id);

      // The rows as the owner's screen and the rules see them, on the owner's own client.
      const ctx = {
        db: anon,
        projectId: project.id,
        store: null,
        modules: mods ?? [],
        schemas,
        ownerWords: "",
        understood: "",
        locale: "en-IN",
        currency: SEED_CURRENCY,
        uxModel: null,
      };
      const readApp = () =>
        appSections(ctx, mods ?? [], schemas, { sectionFor, readSection, STORE_TABLES, evalExpr, truthy });

      // Owner writes after the build, as the panel makes them, then what the rows show.
      let exercised = null;
      if (expected.exercise) {
        const notes = [];
        const write = async (moduleId, body) => {
          const r = await fetch(`${APP}/api/records`, {
            method: "POST",
            headers,
            body: JSON.stringify({ projectId: project.id, moduleId, ...body }),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok || data.error) notes.push(`a write was refused: ${data.error ?? r.status}`);
        };
        for (const step of expected.exercise.steps) {
          const app = await readApp();
          const modOf = (s) => (mods ?? []).find((m) => (m.nav_label || m.name) === s.name);
          if (step.tag) {
            const s = sectionsFor(app, step.tag).find((x) =>
              pickColumn(
                x.columns.filter((c) => !x.storeFields.has(c.field)),
                step.tag.field
              )
            );
            if (!s) {
              notes.push("no field of the owner's to tie a design to its blank");
              continue;
            }
            const col = pickColumn(
              s.columns.filter((c) => !s.storeFields.has(c.field)),
              step.tag.field
            );
            for (const r of s.rows.filter((x) => step.tag.match(x)))
              await write(modOf(s).id, {
                action: "update_store_row",
                storeRowId: r.id,
                data: { [col.field]: step.tag.value },
              });
          }
          if (step.add) {
            const s = app.find((x) => !x.table && new RegExp(step.add.own, "i").test(x.name));
            if (!s) {
              notes.push("no section of the owner's to put the blank's count in");
              continue;
            }
            const taken = new Set();
            const data = {};
            for (const [pattern, value] of step.add.values) {
              const col = pickColumn(s.columns, pattern, taken);
              if (col) {
                taken.add(col.field);
                data[col.field] = value;
              }
            }
            const keyField = Object.keys(data)[0];
            const there = keyField ? s.rows.find((r) => String(r[keyField] ?? "") === String(data[keyField])) : null;
            await write(
              modOf(s).id,
              there ? { action: "update", recordId: there.id, data } : { action: "create", data }
            );
          }
        }
        // A rule runs after the write's answer is out: a moment for it to land.
        let verdict = null;
        for (let i = 0; i < 10; i++) {
          await pause(2000);
          verdict = valuesCheck(await readApp(), expected.exercise.then);
          if (verdict.ok) break;
        }
        exercised = notes.length ? { ...verdict, detail: `${verdict.detail}; ${notes.join("; ")}` } : verdict;
      }

      const app = expected.effect ? await readApp() : [];
      const dryRuns =
        expected.effect && talk.builtPlans.length ? await dryRunRules(ctx, talk.builtPlans).catch(() => []) : [];
      const checks = outcomeChecks(c, expected, {
        replies: talk.replies,
        builds: talk.builds,
        builtPlans: talk.builtPlans,
        sections: app,
        dryRuns,
        exercised,
      });

      const beforeText = before.length ? describeBuild(sectionsOfPlans(before), []) : "(nothing of their own)";
      const nowText = describeBuild(sections, rules ?? []);
      const graded = await ask(
        gradeModel,
        GRADE_SYSTEM,
        gradeInput(c, beforeText, talk.lines, nowText),
        GRADE_OUT_TOKENS,
        `the grader on ${c.id}`,
        0
      );
      const verdict = parseGrade(
        graded.raw,
        c.success,
        c.must_not,
        [beforeText, transcriptLines(talk.lines), nowText].join("\n")
      );
      if (!verdict.ok) console.log(`  (the grader's answer on ${c.id} was not JSON: every criterion is unmet)`);

      const result = {
        id: c.id,
        title: c.title,
        kind: c.kind ?? "build",
        shop,
        turns: talk.ms.length,
        built: talk.builds > 0,
        signs: {
          workarounds: workaroundSigns(sections, rules ?? []),
          jargon: talk.jargon,
          proposed_first: talk.proposedFirst,
        },
        checks,
        criteria: verdict.criteria,
        must_not: verdict.must_not,
        scores: verdict.scores,
        cost: Math.round((talk.costs.reduce((a, b) => a + b, 0) + talk.simUsd + graded.spent) * 1e4) / 1e4,
        ms: talk.ms.reduce((a, b) => a + b, 0),
        transcript: talk.lines,
        trace: talk.trace.map((t) => ({ turn: t.turn, repairs: t.repairs, refused: t.refused, steps: t.steps })),
      };
      return { ...result, score10: scoreOf(result) };
    } finally {
      if (c.meeting) {
        await admin
          .from("profiles")
          .update({ met_luke_at: profile?.met_luke_at ?? new Date().toISOString() })
          .eq("user_id", me.user.id);
      }
      await project.remove();
    }
  }

  const started = new Date().toISOString();
  const done = [];
  let stopped = null;
  let failed = null;
  const unfinished = [];
  try {
    for (const c of cases) {
      const r = await runCase(c);
      done.push(r);
      inFlight = null;
      console.log(
        `${casePassed(r) ? "pass" : "FAIL"}  ${c.id.padEnd(20)} ${String(r.score10).padStart(4)}/10  ${r.turns} turn${r.turns === 1 ? "" : "s"}, ${r.built ? "built" : "not built"}, ${usd(r.cost)}, ${Math.round(r.ms / 1000)}s   spent ${usd(meter.spent)} of $${args.maxUsd}`
      );
      for (const x of r.checks) if (!x.ok) console.log(`      check: ${x.name}: ${x.detail}`);
      for (const x of r.criteria) if (!x.met) console.log(`      unmet: ${x.text}`);
      for (const x of r.must_not) if (x.hit) console.log(`      hit:   ${x.text}`);
    }
  } catch (e) {
    if (e instanceof CapReached) stopped = e.message;
    else failed = e;
  } finally {
    // Out of the pass rate, as it was never graded: kept to be read.
    if (inFlight)
      unfinished.push({ ...inFlight, stopped: stopped ?? (failed instanceof Error ? failed.message : String(failed)) });
    await admin
      .from("account_settings")
      .update({ turns_unlimited: was?.turns_unlimited ?? false })
      .eq("user_id", first.user.id);
  }

  const run = {
    label: args.label,
    started,
    design_model: designModel,
    sim_model: simModel,
    grade_model: gradeModel,
    cap: args.maxUsd,
    spent: Math.round(meter.spent * 1e4) / 1e4,
    partial: done.length < cases.length,
    cases: done,
    ...(unfinished.length ? { unfinished } : {}),
    summary: summarise(done),
  };
  if (stopped) console.log(`\n${stopped}`);
  if (failed) console.log(`\nthe run failed: ${failed instanceof Error ? failed.message : failed}`);
  for (const u of unfinished)
    console.log(`kept unfinished: ${u.id}, ${u.trace.length} turn${u.trace.length === 1 ? "" : "s"} said and traced`);
  if (done.length || meter.spent > 0) {
    const file = writeRun(run);
    const s = run.summary;
    console.log(
      `\n${done.length} of ${cases.length} case${cases.length === 1 ? "" : "s"}${run.partial ? " (partial)" : ""} · score ${s.score10}/10 · passed ${Math.round(s.pass_rate * 100)}% · signs ${s.signs_total} · spent ${usd(run.spent)} → evals/runs/${file}`
    );
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
