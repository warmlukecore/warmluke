import { after, NextResponse } from "next/server";
import { runQueuedJobs } from "@/lib/code-rules";
import { codeTicketClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
// The work runs in after(), which lives as long as this does.
export const maxDuration = 300;

/** Work this long, then leave the rest for the next dispatch. */
const BUDGET_MS = 200_000;

/**
 * POST /api/code-rules/worker — a project's queued code, with nobody
 * watching (0134).
 *
 * Called by the database, never by a person: abo_code_dispatch posts
 * { project, ticket } here when a project has code waiting. The ticket
 * is this route's whole authority. It is checked by the database, which
 * minted it for one project, keeps only its hash, and lets it reach that
 * project's sections, rules, records and store rows while it lives. A
 * made-up ticket, a stale one, or one for another project is turned
 * away here, and could not have done anything anyway.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { project?: unknown; ticket?: unknown };
  if (typeof body.project !== "string" || typeof body.ticket !== "string" || body.ticket.length < 32) {
    return NextResponse.json({ error: "project and ticket are required" }, { status: 400 });
  }
  const project = body.project;
  const client = codeTicketClient(body.ticket);
  const { data: held } = await client.rpc("abo_code_project");
  if (held !== project) return NextResponse.json({ error: "That ticket is not for this project." }, { status: 403 });

  after(async () => {
    try {
      await runQueuedJobs(client, project, Date.now() + BUDGET_MS);
    } catch (e) {
      console.error(`[code worker] ${e instanceof Error ? e.message : "failed"}`);
    } finally {
      // The project is free for the next dispatch, which takes what is left.
      await client.rpc("abo_code_release");
    }
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}
