// POST /api/site-read { projectId, first? } — read their website (lib/site-read, 0223).
//
// The owner's alone, under their own rights. Once on its own when the app
// first opens on a project never read ("first": only when they gave their
// website, so a store's address alone is read only when they ask), and
// again from Settings; at most once in two minutes, claimed in the
// database so two tabs read it once.
//
// Callers: src/components/AppShell.tsx (the first read), src/components/SiteFacts.tsx.

import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { readSite, siteOf } from "@/lib/site-read";

export const runtime = "nodejs";
export const maxDuration = 60;

const AGAIN_MS = 2 * 60_000;

export async function POST(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { projectId?: unknown; first?: unknown };
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  const { data: owns } = await auth.client.rpc("abo_owns", { p: projectId });
  if (owns !== true) return NextResponse.json({ error: "Only the owner has their website read." }, { status: 403 });
  if (body.first === true && !(await siteOf(auth.client, projectId))?.website)
    return NextResponse.json({ skipped: "No website was given; it is read when they ask." });
  const cutoff = new Date(Date.now() - AGAIN_MS).toISOString();
  const { data: claimed } = await auth.client
    .from("projects")
    .update({ site_read_at: new Date().toISOString() })
    .eq("id", projectId)
    .or(`site_read_at.is.null,site_read_at.lt.${cutoff}`)
    .select("id");
  if (!claimed?.length)
    return NextResponse.json({ error: "Read a moment ago; try again in a couple of minutes." }, { status: 429 });
  const out = await readSite(auth.client, projectId);
  if ("error" in out) return NextResponse.json(out, { status: 422 });
  return NextResponse.json(out);
}
