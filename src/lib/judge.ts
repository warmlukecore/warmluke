// A second opinion on every design, that changes nothing.
//
// After Luke — or a connected assistant — has produced a design, it is
// shown to a decision model (Jev, typesafe.ai) beside the owner's own
// words and asked two narrow things: does what will be built do what
// they asked, and could each line the design calls "unmet" have been
// built after all. It answers with probabilities, not prose. Nothing
// reads the answers yet. They go into `judgements` so that, once real
// merchants have been through, one query can say how often a design
// missed the request — the number that decides whether these answers
// ever get to stop an automatic build. Until then, a gauge, not a gate.
//
// Runs after the response has gone out (next/server `after`), so the
// turn is not a millisecond slower. No key: does nothing. A slow or
// broken answer: writes nothing. It never throws into the turn it is
// watching.
//
// Facts are not asked. Whether a plan removes a section is read off
// the plans; the model is only asked what a lookup cannot tell — and
// shown the engine's own description of the build, never the
// assistant's summary of it, for the reason findGaps gives.

import type { SupabaseClient } from "@supabase/supabase-js";
import { askJev } from "@/lib/jev";
import { keyFor } from "@/lib/model-tape";
import {
  AUTOMATION_ACTIONS,
  COLUMNS,
  NOT_SUPPORTED,
  STAT_OPS,
  TRIGGERS,
  VIEWS,
} from "@/lib/capabilities";
import { describePlan, type StoreFacts } from "@/lib/describe";
import type { AssistantPlan, ModuleRow } from "@/lib/types";

const TIMEOUT_MS = 4000;
/** findGaps caps unmet at 6; one question each is the whole list. */
const MAX_UNMET = 6;

export type Judgement = {
  model: string;
  ms: number;
  /** P(what will be built does what the owner asked for). */
  addresses: number;
  /** P(this line could have been built), one per unmet entry, in order. */
  unmet: number[];
};

/**
 * What the engine will do, plan by plan, in the words the approval
 * card uses. The gap pass grades this rather than the assistant's own
 * summary — a design that says "scan to verify" and ships no scanner
 * would pass review otherwise — and the judge is shown the same thing.
 */
export function describeBuild(
  plans: AssistantPlan[],
  modules: ModuleRow[],
  columns?: Array<{ field: string; label: string }>,
  store?: StoreFacts | null
): string {
  return plans
    .map((pl) => {
      const d = describePlan(pl, modules, columns, store);
      return [d.title, ...d.lines].join("\n  ");
    })
    .join("\n");
}

// What can and cannot be built, from the declarations the validator
// and the prompt already share. Generated, not written: a hand-written
// copy that named three of the seven unsupported things was right 14
// times in 28 against the real list.
const firstSentence = (s: string) => s.split(". ")[0];
function abilities() {
  return {
    can: {
      fields: Object.entries(COLUMNS).map(([k, v]) => `${k} — ${firstSentence(v)}`),
      views: Object.entries(VIEWS).map(([k, v]) => `${k} — ${v.doc}`),
      stats: Object.entries(STAT_OPS).map(([k, v]) => `${k} — ${v}`),
      filters: "on any field",
      rules: {
        when: Object.entries(TRIGGERS).map(([k, v]) => `${k} — ${firstSentence(v)}`),
        then: Object.entries(AUTOMATION_ACTIONS).map(([k, v]) => `${k} — ${firstSentence(v)}`),
      },
      scanner: "a barcode scanner that opens the row carrying that code",
    },
    cannot: NOT_SUPPORTED.map((n) => n.label),
  };
}

/**
 * Asks the judge. Null whenever there is no verdict to be had — no
 * key, a slow answer, a refusal, an answer of the wrong shape — and
 * never a throw.
 */
export async function judgeDesign(
  opts: { request: string; built: string; unmet: string[] },
  timeoutMs = TIMEOUT_MS
): Promise<Judgement | null> {
  // keyFor: a stand-in while replaying tapes (model-tape.ts), where the call never leaves.
  const key = keyFor(process.env.TYPESAFE_API_KEY);
  if (!key) return null;
  const unmet = opts.unmet.slice(0, MAX_UNMET);

  // Only what the questions need. Accuracy falls with every unrelated
  // line in the state, and handing over the whole schema was how a
  // merchant's own "Product-2" got confused with the store's "Products".
  const state = {
    owner_said: opts.request.slice(0, 2000),
    will_be_built: opts.built.slice(0, 4000),
    not_built: unmet,
    abilities: abilities(),
  };
  const questions: Record<string, unknown> = {
    addresses: {
      type: "noul",
      instructions: {
        question: "Does `will_be_built` do what the owner asked for in `owner_said`?",
        yes: "It does the thing they asked for, even if it also does more, or says it differently",
        no: "It does something else, or only shows information where they asked for something to be caught, worked out or done",
        not_for: "Whether the design is good, or whether more could have been built",
      },
    },
  };
  unmet.forEach((_, i) => {
    questions[`unmet_${i}`] = {
      type: "noul",
      instructions: {
        question: `Could \`not_built[${i}]\` have been built using only what is listed under \`abilities.can\`?`,
        yes: "It is a field, a view, a stat, a filter, a scanner or a rule of a kind that list allows",
        no: "It needs something under `abilities.cannot`, or something no listed ability provides",
        not_for: "Whether building it would have been a good idea",
      },
    };
  });

  const t0 = Date.now();
  const got = await askJev("judge", state, questions, timeoutMs);
  if (!got) return null;
  const p = (name: string) => {
    const v = got.answers[name]?.noul;
    return typeof v === "number" && v >= 0 && v <= 1 ? v : null;
  };
  const addresses = p("addresses");
  const scores = unmet.map((_, i) => p(`unmet_${i}`));
  // An answer with a hole in it is not an answer. Half a verdict
  // written down reads later like a whole one.
  if (addresses === null || scores.some((s) => s === null)) {
    console.error("judge: the answer did not have the shape asked for");
    return null;
  }
  return { model: got.model, ms: Date.now() - t0, addresses, unmet: scores as number[] };
}

/**
 * Judges a design and writes the verdict down. Everything that can go
 * wrong here is caught here: this runs after the response has gone
 * out, and the turn it watches never learns of it.
 */
export async function noteJudgement(
  db: SupabaseClient,
  opts: {
    projectId: string;
    source: "chat" | "mcp";
    /** The message or build request this belongs to, when there is one. */
    ref: string | null;
    request: string;
    plans: AssistantPlan[];
    modules: ModuleRow[];
    columns?: Array<{ field: string; label: string }>;
    store?: StoreFacts | null;
    unmet: string[];
  }
): Promise<void> {
  try {
    // Nothing to judge: a clarify or an answer has no build in it. The
    // cheap check comes before any description is rendered.
    if (!keyFor(process.env.TYPESAFE_API_KEY) || opts.plans.length === 0) return;
    const built = describeBuild(opts.plans, opts.modules, opts.columns, opts.store);
    const unmet = opts.unmet.slice(0, MAX_UNMET);
    const judge = await judgeDesign({ request: opts.request, built, unmet });
    if (!judge) return;
    const { error } = await db.rpc("abo_judge_note", {
      p_project: opts.projectId,
      p_source: opts.source,
      p_ref: opts.ref,
      p_request: opts.request,
      p_built: built,
      p_unmet: unmet,
      p_removes: opts.plans.some((pl) => pl.changeType === "MODULE_DELETE"),
      p_judge: { addresses: judge.addresses, unmet: judge.unmet },
      p_model: judge.model,
      p_ms: judge.ms,
    });
    if (error) console.error(`judge: not written: ${error.message}`);
  } catch (e) {
    console.error(`judge: ${e instanceof Error ? e.message : "failed"}`);
  }
}
