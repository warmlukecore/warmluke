// What Luke knows about this business: the owner's own list of it.
//
// Read and struck under the owner's rights (0131): a line they strike
// is gone from the next plan and answer. The chat route learns after a
// turn; the owner may also tell Luke a fact themselves, which is theirs
// and so kept as said. What hurts them (0201) is listed beside it: struck,
// a problem is set aside ("dropped"), kept for how Luke learns, never read
// to him again.
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
  const [{ data, error }, hurts] = await Promise.all([
    auth.client
      .from("merchant_notes")
      .select("id, note, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(40),
    auth.client
      .from("merchant_problems")
      .select("id, problem, cost, status, created_at")
      .eq("project_id", projectId)
      .neq("status", "dropped")
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  if (error) return NextResponse.json({ error: "Could not read what Luke knows." }, { status: 500 });
  // Before 0201 there is no list of problems, and none is said.
  return NextResponse.json({ notes: data ?? [], problems: hurts.error ? [] : (hurts.data ?? []) });
}

/** A fact the owner tells Luke themselves: kept as they said it. */
export async function POST(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { projectId?: unknown; note?: unknown };
  const note = typeof body.note === "string" ? body.note.replace(/\s+/g, " ").trim() : "";
  if (typeof body.projectId !== "string" || !body.projectId)
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  if (note.length < 3 || note.length > 200)
    return NextResponse.json({ error: "Say it in a line, between 3 and 200 characters." }, { status: 400 });
  // Under RLS, a project of somebody else's refuses the write.
  const { data, error } = await auth.client
    .from("merchant_notes")
    .upsert({ project_id: body.projectId, note }, { onConflict: "project_id,note" })
    .select("id, note, created_at")
    .single();
  if (error) return NextResponse.json({ error: "Could not keep that." }, { status: 500 });
  return NextResponse.json({ note: data });
}

export async function DELETE(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; kind?: unknown };
  if (typeof body.id !== "string" || !body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  // Under RLS a line of somebody else's is simply not there to strike.
  const { error } =
    body.kind === "problem"
      ? await auth.client.from("merchant_problems").update({ status: "dropped" }).eq("id", body.id)
      : await auth.client.from("merchant_notes").delete().eq("id", body.id);
  if (error) return NextResponse.json({ error: "Could not strike that line." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
