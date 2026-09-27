// What Luke knows about this business: the owner's own list of it.
//
// Read and struck under the owner's rights (0131): a line they strike
// is gone from the next plan and answer. Nothing is written here; the
// chat route learns after a turn.
//
// Callers: src/components/ChatPanel.tsx (KnownNotes).

import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  const { data, error } = await auth.client
    .from("merchant_notes")
    .select("id, note, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) return NextResponse.json({ error: "Could not read what Luke knows." }, { status: 500 });
  return NextResponse.json({ notes: data ?? [] });
}

export async function DELETE(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  // Under RLS a line of somebody else's is simply not there to strike.
  const { error } = await auth.client.from("merchant_notes").delete().eq("id", body.id);
  if (error) return NextResponse.json({ error: "Could not strike that line." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
