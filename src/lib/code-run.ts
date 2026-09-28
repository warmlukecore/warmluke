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
};

/** Past this a rule's code is not small. */
export const CODE_MAX = 20_000;
/** A run's whole input, rows and all: past it the rule is asked to read less. */
const INPUT_MAX = 2_000_000;

/** Why a rule's code would not be run, or null when it may be. */
export function codeProblem(code: unknown): string | null {
  if (typeof code !== "string" || !code.trim()) return 'A run_code action needs its "code".';
  if (code.length > CODE_MAX) return `The code is ${code.length} characters; keep it under ${CODE_MAX}.`;
  if (!/export\s+default\s+(async\s+)?function/.test(code)) {
    return 'The code must export its function: "export default function run({ row, previous, sections, today }) { … }".';
  }
  return null;
}

/** Reads what the code handed back; anything else is no result. */
export function parseResult(raw: unknown): CodeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { set?: unknown; add?: unknown };
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
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
  return { set: set.slice(0, 500), add: add.slice(0, 100) };
}

/**
 * Runs the rule's function on each input in turn, inside the machine, and
 * prints one line of JSON: an answer for each, in order. One machine and
 * one process for them all: a store bringing in fifty orders is one run.
 */
const RUNNER = `import { readFileSync } from "node:fs";
const inputs = JSON.parse(readFileSync("inputs.json", "utf8"));
const out = [];
let run;
try {
  run = (await import("./rule.mjs")).default;
} catch (e) {
  const error = String(e && e.message ? e.message : e).slice(0, 300);
  process.stdout.write(JSON.stringify(inputs.map(() => ({ ok: false, error }))));
  process.exit(0);
}
for (const input of inputs) {
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

function credentials() {
  const token = process.env.VERCEL_SANDBOX_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  return token && teamId && projectId ? { token, teamId, projectId } : {};
}

/** Whether a sandbox can be reached from here at all. */
export const canRunCode = () => !!process.env.VERCEL_OIDC_TOKEN || !!process.env.VERCEL_SANDBOX_TOKEN;

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
  const json = JSON.stringify(inputs);
  if (json.length > INPUT_MAX) return all("The rows this rule reads are too many to hand it in one go.");
  if (!canRunCode()) return all("Code rules cannot run here: no sandbox is reachable.");
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await Sandbox.create({
      ...credentials(),
      runtime: "node24",
      region: "syd1",
      // Its life: a minute, and a little more for each input past the first.
      timeout: Math.min(45_000 + inputs.length * 200, 240_000),
      resources: { vcpus: 1 },
      networkPolicy: "deny-all",
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
