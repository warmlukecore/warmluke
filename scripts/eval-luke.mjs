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
//   node scripts/eval-luke.mjs --label before --max-usd 1.5 [--cases rto-new,low-stock] [--design-model <name>]
//
// Run from the repository's root. The check project only (CHECK_PROJECT=1):
// each case makes a throwaway project with the seeded shop in it, and
// removes it at the end. The model key is read from the environment, or
// the env file when the environment has none.
//
// Everything above main() is pure, so check-eval-harness can test it.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { SCORE_KEYS, casePassed, summarise } from "../src/lib/eval-report.ts";
import { priceOf } from "../src/lib/model-prices.ts";

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
  const designModel = value("--design-model") ?? null;
  if (!label || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(label)) {
    return { error: "--label is required: lowercase letters, digits and dashes (before, after-prompt-fix)" };
  }
  // The whole budget for every eval is $10: a cap above it is a typo.
  if (!(maxUsd > 0 && maxUsd <= 10)) return { error: "--max-usd is required: dollars, more than 0 and at most 10" };
  if (designModel !== null && !/^[a-z0-9][a-z0-9.-]*$/.test(designModel)) {
    return { error: "--design-model is a model's id, as the panel names it (claude-sonnet-5)" };
  }
  const cases = only
    ? only
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  return { label, maxUsd, cases, designModel };
}

// ── Cases ───────────────────────────────────────────────────────────

const KEYS = ["id", "title", "language", "persona", "before", "opening", "facts", "success", "must_not", "max_turns"];
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
  if (!Array.isArray(c.before) || c.before.some((pl) => !pl || typeof pl.changeType !== "string")) {
    p.push("before: a list of plans, each with a changeType");
  }
  const facts = c.facts && typeof c.facts === "object" && !Array.isArray(c.facts) ? Object.values(c.facts) : [];
  if (facts.length === 0 || !facts.every(words)) p.push("facts: topics, each with what the owner would answer");
  for (const k of ["success", "must_not"]) {
    if (!Array.isArray(c[k]) || c[k].length === 0 || !c[k].every(words)) p.push(`${k}: a list of sentences`);
  }
  for (const s of COMMON_SUCCESS)
    if (!Array.isArray(c.success) || !c.success.includes(s)) p.push(`success lacks "${s}"`);
  for (const s of COMMON_MUST_NOT)
    if (!Array.isArray(c.must_not) || !c.must_not.includes(s)) p.push(`must_not lacks "${s}"`);
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
const columnLine = (c) =>
  `${c?.label ?? c?.field} [${c?.field}] (${c?.type}${Array.isArray(c?.options) ? `: ${c.options.join(" / ")}` : ""}${c?.hidden ? ", hidden from the table" : ""}${c?.compute ? ", worked out when read" : ""})`;

/** A design as lines: what the simulated owner sees on a card, and the transcript keeps. */
export function planLines(plans) {
  return plans.flatMap((p) => [
    `- ${p?.changeType}${p?.newModule?.nav_label ? ` "${p.newModule.nav_label}"` : ""}: ${p?.explanation ?? ""}`,
    ...(p?.newSchema?.columns?.length ? [`  fields: ${p.newSchema.columns.map(columnLine).join(" · ")}`] : []),
    ...(p?.automation?.name ? [`  rule: ${p.automation.name}`] : []),
  ]);
}

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
    if (s.columns?.length) out.push(`  Fields: ${s.columns.map(columnLine).join(" · ")}`);
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

You default to "not met". A criterion is met only when the conversation or the app shows it, and every yes needs evidence: an exact quote of a few words, copied character for character from THE APP BEFORE, THE CONVERSATION or WHAT IS IN THE APP NOW, written in double quotes, with no speaker's name and no remark around it. No quote, no yes; a paraphrase is not evidence. A must-not item is hit when the material shows it; quote that too. When you cannot tell, it is not met, and a must-not you cannot rule out is hit.

A perfect score is suspicious. Before giving any 5, look again for what could be simpler or clearer; give 5 only when nothing could.

Scores, 1 to 5:
- discussed: did Luke say the plan and get the owner's yes before building? 1 built straight away; 5 said the plan, asked only what was unclear, built on the yes.
- plain: were Luke's words plain for an owner, with no field names, types or technical terms?
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
  const cases = all.map((x) => x.case).filter((c) => !args.cases || args.cases.includes(c.id));

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

  async function runCase(c) {
    const me = await signIn();
    const token = me.session.access_token;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const project = await throwawayProject(admin, me.user.id, `eval ${c.id}`);
    try {
      // The seeded shop, as e2e/shop.ts makes it: every case has a store to build on.
      const now = new Date().toISOString();
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
      await seedShop(admin, store.id);
      const nodes = seedNodes();
      await admin.from("import_runs").insert(
        RESOURCES.map((resource) => ({
          store_id: store.id,
          resource,
          status: "done",
          imported: nodes[resource].length,
          started_at: new Date(Date.parse(now) - 60_000).toISOString(),
          finished_at: now,
        }))
      );

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
      if (c.before.length) {
        const made = await build(c.before, null);
        if (!made.ok) throw new Error(`${c.id}: its "before" would not build: ${made.errors.join("; ")}`);
      }

      const lines = [];
      const lukeCosts = [];
      const turnMs = [];
      const jargon = new Set();
      let conversationId = null;
      let message = c.opening;
      let built = false;
      // The loop ends at the first build, so a plan said at all came before it.
      let proposed = false;
      let pushedBack = false;
      let simSpent = 0;

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
      // The reply carries its usage only for the team; the trace keeps it for everyone, a moment later.
      const usageOf = async (reply, id) => {
        if (reply.usage) return reply.usage;
        for (let i = 0; i < 20; i++) {
          const { data } = await admin.from("turn_traces").select("usage").eq("turn_id", id).maybeSingle();
          if (data) return data.usage ?? null;
          await pause(500);
        }
        return null;
      };

      for (let turn = 1; turn <= c.max_turns; turn++) {
        const estimate = lukeEstimate(lukeCosts);
        meter.before(estimate + gradeReserve, `Luke's turn ${turn} of ${c.id}`);
        lines.push({ who: "owner", text: message });
        const t0 = Date.now();
        const res = await fetch(`${APP}/api/chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            projectId: project.id,
            message,
            conversationId,
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
        conversationId = accepted?.conversationId ?? read.data.conversationId ?? conversationId;
        const answerId = accepted?.turn ?? read.data.replyId;
        if (!answerId) throw new Error(`${c.id}: the turn named no line for its answer`);
        const reply = await settle(answerId);
        turnMs.push(Date.now() - t0);
        const usage = await usageOf(reply, answerId);
        if (!usage) console.log(`  (turn ${turn} of ${c.id} left no usage; counted at its estimate)`);
        else if (usage.partial)
          console.log(`  (turn ${turn} of ${c.id} used a model with no price; its cost is short)`);
        const spent = usage?.usd ?? estimate;
        meter.add(spent);
        lukeCosts.push(spent);

        lines.push({ who: "luke", text: replyText(reply).slice(0, 2000) });
        for (const w of jargonIn(ownerText(reply))) jargon.add(w);
        if (isProposal(reply)) proposed = true;
        if (reply.type === "unanswered" || reply.type === "stopped") break;

        const plans = plansOf(reply);
        const buildIt = async () => {
          const next = reply.next ?? reply.blueprint?.next;
          const done = await build(plans, { conversationId, designId: answerId, sent: plans.map((_, i) => i), next });
          lines.push({ who: "app", text: done.ok ? "Built." : `The build was refused: ${done.errors.join("; ")}` });
          built = done.ok;
        };
        // Agreed in words and drawn: built at once, as the panel does.
        if (plans.length && reply.approved) {
          await buildIt();
          break;
        }
        if (turn === c.max_turns) break;

        const sim = await ask(
          simModel,
          simSystem(c, pushedBack),
          simInput(lines),
          SIM_OUT_TOKENS,
          "the simulated owner",
          gradeReserve
        );
        simSpent += sim.spent;
        const said = parseSim(sim.raw);
        if (said.pushback) pushedBack = true;
        // A drawn design they agree to is the card's Build button.
        if (plans.length && said.agree) {
          lines.push({ who: "owner", text: "(taps Build)" });
          await buildIt();
          break;
        }
        // A yes to a plan in words is said as the panel's "Build it" would be: plainly.
        message =
          said.agree && isProposal(reply)
            ? YES[c.language]
            : said.say || (said.agree ? YES[c.language] : DECIDE[c.language]);
      }

      // What is in the app now, read past RLS: every section's newest schema, every rule.
      const { data: mods } = await admin.from("modules").select("*").eq("project_id", project.id);
      const sections = [];
      for (const m of mods ?? []) {
        const { data: s } = await admin
          .from("ui_schemas")
          .select("schema_json")
          .eq("module_id", m.id)
          .order("version", { ascending: false })
          .limit(1)
          .maybeSingle();
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

      const beforeText = c.before.length ? describeBuild(sectionsOfPlans(c.before), []) : "(nothing of their own)";
      const nowText = describeBuild(sections, rules ?? []);
      const graded = await ask(
        gradeModel,
        GRADE_SYSTEM,
        gradeInput(c, beforeText, lines, nowText),
        GRADE_OUT_TOKENS,
        `the grader on ${c.id}`,
        0
      );
      const verdict = parseGrade(
        graded.raw,
        c.success,
        c.must_not,
        [beforeText, transcriptLines(lines), nowText].join("\n")
      );
      if (!verdict.ok) console.log(`  (the grader's answer on ${c.id} was not JSON: every criterion is unmet)`);

      return {
        id: c.id,
        title: c.title,
        turns: turnMs.length,
        built,
        signs: { workarounds: workaroundSigns(sections, rules ?? []), jargon: [...jargon], proposed_first: proposed },
        criteria: verdict.criteria,
        must_not: verdict.must_not,
        scores: verdict.scores,
        cost: Math.round((lukeCosts.reduce((a, b) => a + b, 0) + simSpent + graded.spent) * 1e4) / 1e4,
        ms: turnMs.reduce((a, b) => a + b, 0),
        transcript: lines,
      };
    } finally {
      await project.remove();
    }
  }

  const started = new Date().toISOString();
  const done = [];
  let stopped = null;
  let failed = null;
  try {
    for (const c of cases) {
      const r = await runCase(c);
      done.push(r);
      console.log(
        `${casePassed(r) ? "pass" : "FAIL"}  ${c.id.padEnd(18)} ${r.turns} turn${r.turns === 1 ? "" : "s"}, ${r.built ? "built" : "not built"}, ${usd(r.cost)}, ${Math.round(r.ms / 1000)}s   spent ${usd(meter.spent)} of $${args.maxUsd}`
      );
      for (const x of r.criteria) if (!x.met) console.log(`      unmet: ${x.text}`);
      for (const x of r.must_not) if (x.hit) console.log(`      hit:   ${x.text}`);
    }
  } catch (e) {
    if (e instanceof CapReached) stopped = e.message;
    else failed = e;
  } finally {
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
    summary: summarise(done),
  };
  if (stopped) console.log(`\n${stopped}`);
  if (failed) console.log(`\nthe run failed: ${failed instanceof Error ? failed.message : failed}`);
  if (done.length || meter.spent > 0) {
    const file = writeRun(run);
    const s = run.summary;
    console.log(
      `\n${done.length} of ${cases.length} case${cases.length === 1 ? "" : "s"}${run.partial ? " (partial)" : ""} · passed ${Math.round(s.pass_rate * 100)}% · signs ${s.signs_total} · spent ${usd(run.spent)} → evals/runs/${file}`
    );
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
