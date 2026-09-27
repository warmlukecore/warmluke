// The Workflow spike's door (week 1). Behind LUKE_WORKFLOW=1: elsewhere
// it is not there. Starts a durable run and streams what it says as
// NDJSON, the way the chat does; reads a run back by id; resumes a run
// waiting on an answer.
//
// Callers: scripts/check-workflow-spike.mjs (by hand, dev only).

import { NextResponse } from "next/server";
import { getRun, resumeHook, start } from "workflow/api";
import { getUserClient } from "@/lib/supabase-server";
import { askSpike, lukeSpike, type SpikeEvent } from "@/workflows/luke-spike";

export const runtime = "nodejs";
export const maxDuration = 300;

const on = () => process.env.LUKE_WORKFLOW === "1";

/** Chunks as lines, one JSON object each, as the chat streams them. */
const ndjson = () =>
  new TransformStream<SpikeEvent, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(chunk)}\n`));
    },
  });

export async function POST(req: Request) {
  if (!on()) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    projectId?: string;
    message?: string;
    slowMs?: number;
    ask?: { token: string; question: string };
    resume?: { token: string; answer: string };
  };

  if (body.resume) {
    const result = await resumeHook(body.resume.token, { answer: body.resume.answer });
    return NextResponse.json({ resumed: !!result });
  }

  if (body.ask) {
    const run = await start(askSpike, [{ token: body.ask.token, question: body.ask.question }]);
    return NextResponse.json({ runId: run.runId });
  }

  if (!body.projectId || !body.message) {
    return NextResponse.json({ error: "projectId and message are required" }, { status: 400 });
  }
  // The project has to be theirs: read under their RLS.
  const { data: mine } = await auth.client.from("projects").select("id").eq("id", body.projectId).maybeSingle();
  if (!mine) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  const token = req.headers.get("authorization")!.slice(7).trim();
  const run = await start(lukeSpike, [
    { projectId: body.projectId, message: body.message, token, slowMs: Math.max(0, Number(body.slowMs ?? 0) || 0) },
  ]);
  return new Response(run.readable.pipeThrough(ndjson()), {
    headers: { "content-type": "application/x-ndjson", "x-workflow-run-id": run.runId },
  });
}

/** A run read back: its status, and everything it said from the start. */
export async function GET(req: Request) {
  if (!on()) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const runId = new URL(req.url).searchParams.get("run");
  if (!runId) return NextResponse.json({ error: "run is required" }, { status: 400 });
  const run = await getRun(runId);
  const status = await run.status;
  return new Response(run.getReadable<SpikeEvent>({ startIndex: 0 }).pipeThrough(ndjson()), {
    headers: {
      "content-type": "application/x-ndjson",
      "x-workflow-run-id": runId,
      "x-workflow-status": String(status),
    },
  });
}
