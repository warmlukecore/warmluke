// A rule's own code, run sealed off (automation action "run_code").
//
// When a rule needs logic the expressions cannot say (a slab rate, a
// table to look up, a sum across sections, a calendar of holidays),
// Luke writes it as a small function. It runs in a Vercel Sandbox: a
// microVM of its own, in Sydney beside the database, with every
// outbound connection denied, nothing of the app's in it, and a minute
// to finish. It is handed what it needs as JSON and hands back what to
// write; the writes are made by the section's own door (/api/records),
// under the owner's rights, as a button's would be (lib/code-rules.ts).
//
// On Vercel the sandbox is reached with the function's own identity
// (OIDC). Elsewhere it needs VERCEL_SANDBOX_TOKEN, VERCEL_TEAM_ID and
// VERCEL_PROJECT_ID; without them nothing runs, and the rule says so.

import { Sandbox } from "@vercel/sandbox";

/** What the code hands back: fields to set on rows it was given, rows to add to its own section. */
export type CodeResult = {
  /** section: the name a row came under in "sections"; left out, the rule's own section. */
  set: Array<{ id: string; fields: Record<string, unknown>; section?: string }>;
  add: Array<{ fields: Record<string, unknown> }>;
  /** A scheduled rule's next run, "YYYY-MM-DDTHH:MM" on the store's clock (0138). */
  next?: string;
  /** Writes it handed back past what one run may make, left unmade and said in its run (0206). */
  dropped?: number;
};

/** What one run may write: rows it sets, and rows it adds. */
export const SETS_MAX = 500;
export const ADDS_MAX = 100;

/** Past this a rule's code is not small. */
export const CODE_MAX = 20_000;
/**
 * A run's whole input, rows and all. Past it the rows go with only the
 * fields the code names (namesIn); past it still, the rule is asked to
 * read less, and its run says so.
 */
export const INPUT_MAX = 8_000_000;

/** Why a rule's code would not be run, or null when it may be. */
export function codeProblem(code: unknown): string | null {
  if (typeof code !== "string" || !code.trim()) return 'A run_code action needs its "code".';
  if (code.length > CODE_MAX) return `The code is ${code.length} characters; keep it under ${CODE_MAX}.`;
  if (!/export\s+default\s+(async\s+)?function/.test(code)) {
    return 'The code must export its function: "export default function run({ row, previous, sections, today }) { … }".';
  }
  return null;
}

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Reads what the code handed back; anything else is no result. */
export function parseResult(raw: unknown): CodeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { set?: unknown; add?: unknown; next?: unknown };
  const set = Array.isArray(r.set)
    ? r.set
        .filter(
          (s): s is { id: string; fields: Record<string, unknown>; section?: unknown } =>
            obj(s) && typeof s.id === "string" && obj(s.fields)
        )
        .map((s) => ({ id: s.id, fields: s.fields, ...(typeof s.section === "string" ? { section: s.section } : {}) }))
    : [];
  const add = Array.isArray(r.add)
    ? r.add.filter((a): a is { fields: Record<string, unknown> } => obj(a) && obj(a.fields))
    : [];
  const next = typeof r.next === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(r.next) ? r.next : undefined;
  const dropped = Math.max(0, set.length - SETS_MAX) + Math.max(0, add.length - ADDS_MAX);
  return {
    set: set.slice(0, SETS_MAX),
    add: add.slice(0, ADDS_MAX),
    ...(next ? { next } : {}),
    ...(dropped ? { dropped } : {}),
  };
}

/**
 * Every word the code could reach a row's field by, or null when it reads
 * rows whole (their keys, values or entries, a spread, a stringify, a
 * for…in), so no field may be left off.
 * ponytail: a field reached only through data (row[other.which]) is not
 * seen; rows are slimmed only when the whole input would not fit anyway.
 */
export function namesIn(code: string): Set<string> | null {
  if (
    /\bObject\s*\.\s*(keys|values|entries|assign|fromEntries)\b|\bJSON\s*\.\s*stringify\b|\bfor\s*\([^;)]*\bin\b|\.\.\./.test(
      code
    )
  ) {
    return null;
  }
  return new Set(code.match(/[A-Za-z_$][\w$]*/g) ?? []);
}

/** A list of rows with only the fields in `names`, and each row's id. */
function slimRows(rows: unknown, names: Set<string>): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) =>
    r && typeof r === "object" && !Array.isArray(r)
      ? Object.fromEntries(Object.entries(r).filter(([k]) => k === "id" || names.has(k)))
      : r
  );
}

/**
 * What goes into the machine: the sections every input shares, once
 * (a store bringing in fifty orders handed the same 2,000 stock rows
 * fifty times), and each input's own part. Rows are slimmed to the
 * fields the code names only when the whole would not fit otherwise.
 * Null when even that does not fit.
 */
export function packInputs(code: string, inputs: unknown[]): string | null {
  const first = obj(inputs[0]) ? inputs[0] : null;
  const shared =
    inputs.length > 1 && first && "sections" in first && inputs.every((i) => obj(i) && i.sections === first.sections)
      ? first.sections
      : undefined;
  const pack = (each: unknown[], sections: unknown) =>
    JSON.stringify({
      ...(sections === undefined ? {} : { sections }),
      inputs: sections === undefined ? each : each.map((i) => (obj(i) ? { ...i, sections: undefined } : i)),
    });
  const whole = pack(inputs, shared);
  if (whole.length <= INPUT_MAX) return whole;
  const names = namesIn(code);
  if (!names) return null;
  const slimSections = (sections: unknown) =>
    obj(sections)
      ? Object.fromEntries(Object.entries(sections).map(([k, rows]) => [k, slimRows(rows, names)]))
      : sections;
  const slim = inputs.map((i) =>
    obj(i)
      ? {
          ...i,
          ...(shared === undefined && "sections" in i ? { sections: slimSections(i.sections) } : {}),
          ...("rows" in i ? { rows: slimRows(i.rows, names) } : {}),
        }
      : i
  );
  const lean = pack(slim, shared === undefined ? undefined : slimSections(shared));
  return lean.length <= INPUT_MAX ? lean : null;
}

/**
 * Runs the rule's function on each input in turn, inside the machine, and
 * prints one line of JSON: an answer for each, in order. One machine and
 * one process for them all: a store bringing in fifty orders is one run.
 */
/** The field an input carries its sections' other names in (lib/code-rules): taken off before the code sees it. */
export const ALIASES = "__names";

export const RUNNER = `import { readFileSync } from "node:fs";
// The sections every input shares come once (lib/code-run packInputs), and
// each input is handed its own copy, so code that sorts or trims a list for
// one row does not change it for the next. A plain list is each input whole.
const file = JSON.parse(readFileSync("inputs.json", "utf8"));
const inputs = Array.isArray(file)
  ? file
  : file.inputs.map((i, n) =>
      file.sections === undefined ? i : { ...i, sections: n === file.inputs.length - 1 ? file.sections : structuredClone(file.sections) }
    );
const out = [];
let run;
try {
  run = (await import("./rule.mjs")).default;
} catch (e) {
  const error = String(e && e.message ? e.message : e).slice(0, 300);
  process.stdout.write(JSON.stringify(inputs.map(() => ({ ok: false, error }))));
  process.exit(0);
}
// A section however the code spells it (lib/code-rules sectionKey): sections.orders
// is sections["#orders"]. The rows come once; the names that mean them come beside.
const key = (s) => String(s).trim().replace(/^#/, "").toLowerCase().replace(/[\\s_-]+/g, "-");
const named = (rows, aliases) =>
  new Proxy(rows, {
    get: (t, p) => (typeof p !== "string" || p in t ? t[p] : t[aliases[key(p)]]),
    has: (t, p) => p in t || (typeof p === "string" && aliases[key(p)] in t),
  });
for (const raw of inputs) {
  const { ${ALIASES}: aliases, ...input } = raw;
  if (input.sections && aliases) input.sections = named(input.sections, aliases);
  try {
    const answer = await Promise.race([
      Promise.resolve(run(input)),
      // unref: a timer left running kept every run alive its full twenty seconds.
      new Promise((_, no) => setTimeout(() => no(new Error("the code took longer than 20 seconds")), 20000).unref()),
    ]);
    out.push({ ok: true, out: answer ?? {} });
  } catch (e) {
    out.push({ ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) });
  }
}
process.stdout.write(JSON.stringify(out));`;

/** How a sandbox is reached outside Vercel; on Vercel nothing, and the function's own identity is used (lib/screen-shot too). */
export function credentials() {
  const token = process.env.VERCEL_SANDBOX_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

/**
 * Whether a sandbox can be reached from here at all. On Vercel the
 * function's identity comes in each request's x-vercel-oidc-token
 * header, not always in the environment; if the project has it turned
 * off, the sandbox says so and the rule logs it.
 */
export const canRunCode = () =>
  process.env.VERCEL === "1" || !!process.env.VERCEL_OIDC_TOKEN || !!process.env.VERCEL_SANDBOX_TOKEN;

type Ran = { ok: true; result: CodeResult } | { ok: false; error: string };

/** The code, run once on this input, in a machine of its own. Never throws. */
export async function runCode(code: string, input: unknown): Promise<Ran> {
  return (await runCodeEach(code, [input]))[0];
}

/**
 * The code, run on each input in turn, in one machine of its own. An
 * answer for every input, in order, each what it handed back or why
 * there is nothing. Never throws.
 */
export async function runCodeEach(code: string, inputs: unknown[]): Promise<Ran[]> {
  const all = (error: string): Ran[] => inputs.map(() => ({ ok: false, error }));
  const problem = codeProblem(code);
  if (problem) return all(problem);
  if (!inputs.length) return [];
  const json = packInputs(code, inputs);
  if (json === null)
    return all(
      "The rows this rule reads are too many to hand it in one go: read fewer sections, or fewer of their rows."
    );
  if (!canRunCode()) return all("Code rules cannot run here: no sandbox is reachable.");
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await Sandbox.create({
      ...credentials(),
      runtime: "node24",
      // Beside the function that asks, which sits beside the database
      // (vercel.json regions): Mumbai since 2026-09-30, and wherever it moves.
      region: process.env.VERCEL_REGION || "bom1",
      // Its life: a minute, and a little more for each input past the first.
      timeout: Math.min(45_000 + inputs.length * 200, 240_000),
      resources: { vcpus: 1 },
      networkPolicy: "deny-all",
      // One run, then gone. The SDK keeps a sandbox by default, saving it
      // as a snapshot each time it stops: every rule's run left 250 MB the
      // next run never reads, until the plan's storage was full and Vercel
      // refused every code rule (402, 3 Oct, 16:21 UTC on).
      persistent: false,
    });
    await sandbox.writeFiles([
      { path: "rule.mjs", content: Buffer.from(code) },
      { path: "runner.mjs", content: Buffer.from(RUNNER) },
      { path: "inputs.json", content: Buffer.from(json) },
    ]);
    const done = await sandbox.runCommand("node", ["runner.mjs"]);
    let answers: Array<{ ok?: boolean; out?: unknown; error?: string }> = [];
    try {
      answers = JSON.parse((await done.stdout()).trim()) as typeof answers;
    } catch {
      return all("The code printed something of its own instead of returning its result.");
    }
    return inputs.map((_, i): Ran => {
      const a = answers[i];
      if (!a?.ok) return { ok: false, error: a?.error ?? "The code failed." };
      const result = parseResult(a.out);
      return result ? { ok: true, result } : { ok: false, error: "The code returned nothing to write." };
    });
  } catch (e) {
    return all(e instanceof Error ? e.message.slice(0, 300) : "The sandbox could not be reached.");
  } finally {
    // Not waited for: the answers are in hand, and a machine left running
    // ends by itself at its timeout.
    void sandbox?.stop().catch(() => {});
  }
}
