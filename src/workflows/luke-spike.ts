// A turn that survives: the Workflow spike (week 1 of the agentic work).
//
// Three things to prove on this stack before the team of agents is
// built on it: a run works locally under `next dev`; a step that dies
// mid-way (the process killed) is retried and the run completes; and a
// run can wait on the owner's answer and resume from a route. Behind
// LUKE_WORKFLOW=1 and its own route: the chat's path is untouched.
//
// Every read and every call is a step ('use step'): a workflow function
// is replayed deterministically and may do no I/O of its own. Steps run
// as their own invocations, so nothing non-serializable crosses them —
// a client is made inside the step from the ids it is given.
//
// Callers: src/app/api/spike/luke/route.ts.

import { createClient } from "@supabase/supabase-js";
import { createHook, getWritable, sleep } from "workflow";
import { buildTalkPrompt, callModel } from "@/lib/ai";
import type { ModuleRow } from "@/lib/types";

export type SpikeEvent =
  | { step: string; at: number }
  | { words: string }
  | { reply: string }
  | { waiting: string }
  | { answered: string };

export type SpikeInput = {
  projectId: string;
  message: string;
  /** The owner's access token: the steps read as them. */
  token: string;
  /** Sleep this long inside the model step before calling: time to kill the process. */
  slowMs?: number;
};

const say = async (e: SpikeEvent) => {
  const w = getWritable<SpikeEvent>().getWriter();
  await w.write(e);
  w.releaseLock();
};

/** What the project and its store are called: a read, as a step. */
async function prepare(projectId: string, token: string) {
  "use step";
  await say({ step: "prepare", at: Date.now() });
  // The owner's own token, handed in by the route: the read runs under
  // their row policies, as every read does. It rides in the run's log
  // for its hour; the real design mints a shorter one per step.
  const db = createClient(
    process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
  const { data: project } = await db.from("projects").select("id, name, locale, currency").eq("id", projectId).single();
  const { data: modules } = await db.from("modules").select("*").eq("project_id", projectId).order("sort_order");
  return { project, modules: (modules ?? []) as ModuleRow[] };
}

/** The model, on the talk road, its words streamed as they come: a call, as a step. */
async function answer(ctx: Awaited<ReturnType<typeof prepare>>, message: string, slowMs: number) {
  "use step";
  await say({ step: "answer", at: Date.now() });
  if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
  const system = buildTalkPrompt(
    ctx.modules,
    ctx.project?.name ?? "Shop",
    ctx.project?.locale ?? "en-IN",
    ctx.project?.currency ?? "INR",
    null
  );
  let last = "";
  const raw = await callModel({
    system,
    turns: [{ role: "user", content: `USER REQUEST:\n${message}` }],
    onText: (text) => {
      if (text && text !== last) {
        last = text;
        void say({ words: text });
      }
    },
  });
  await say({ reply: raw });
  return raw;
}

export async function lukeSpike(input: SpikeInput) {
  "use workflow";
  const ctx = await prepare(input.projectId, input.token);
  const raw = await answer(ctx, input.message, input.slowMs ?? 0);
  await done();
  return { project: ctx.project?.name ?? null, raw };
}

/** The stream is closed by hand, from a step: a run's end does not close it, and a reader waits for ever. */
async function done() {
  "use step";
  await getWritable<SpikeEvent>().close();
}

/** A run that waits on the owner: the question is asked, the answer comes through a route. */
export async function askSpike(input: { token: string; question: string }) {
  "use workflow";
  await noteWaiting(input.question);
  using hook = createHook<{ answer: string }>({ token: input.token });
  const got = await hook;
  await noteAnswered(got.answer);
  // A moment of durable sleep, so a sleep is exercised too.
  await sleep("1 second");
  await done();
  return { question: input.question, answer: got.answer };
}

async function noteWaiting(question: string) {
  "use step";
  await say({ waiting: question });
}

async function noteAnswered(answer: string) {
  "use step";
  await say({ answered: answer });
}
