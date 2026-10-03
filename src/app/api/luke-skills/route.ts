// What Luke learned working for this business (0176): the lessons and
// ways of working it wrote itself from what the owner corrected and what
// worked, each theirs to strike.
//
// Read and struck under the caller's own rights: RLS decides whose they
// are. Nothing is learned here; the reflector writes them after a turn
// or a thumbs down.
//
// Callers: src/components/ChatPanel.tsx (LearnedSkills).

import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = {
  id: string;
  kind: "lesson" | "skill";
  title: string;
  when_to_use: string;
  body: string;
  uses: number;
  version: number;
  helped: number;
  hurt: number;
  created_at: string;
  updated_at: string;
};

export async function GET(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const projectId = new URL(req.url).searchParams.get("projectId");
  if (!projectId || !UUID.test(projectId))
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  const { data, error } = await auth.client
    .from("luke_skills")
    .select("id, kind, title, when_to_use, body, uses, version, helped, hurt, created_at, updated_at")
    .eq("project_id", projectId)
    .eq("status", "active")
    // ponytail: sorted here, as PostgREST cannot order by helped - hurt; a generated column if the list grows past this.
    .limit(200);
  if (error) return NextResponse.json({ error: "Could not read what Luke learned." }, { status: 500 });
  // Best first: what has helped more than it hurt, then the newest word.
  const skills = ((data ?? []) as Row[])
    .toSorted((a, b) => b.helped - b.hurt - (a.helped - a.hurt) || b.updated_at.localeCompare(a.updated_at))
    .map(({ helped: _h, hurt: _x, ...shown }) => shown);
  return NextResponse.json({ skills });
}

export async function DELETE(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  if (typeof body.id !== "string" || !UUID.test(body.id)) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  // Struck, not deleted: the reflector reads it as something the owner
  // refused, and does not write it again. Under RLS one of somebody
  // else's is not there to strike, so nothing comes back.
  const { data, error } = await auth.client
    .from("luke_skills")
    .update({ status: "struck", updated_at: new Date().toISOString() })
    .eq("id", body.id)
    .select("project_id")
    .maybeSingle();
  if (error) return NextResponse.json({ error: "Could not strike that." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "There is nothing like that to strike." }, { status: 404 });
  const { error: noted } = await auth.client.from("luke_learning_events").insert({
    project_id: (data as { project_id: string }).project_id,
    skill_id: body.id,
    event: "struck",
    detail: { by: "owner" },
  });
  if (noted) return NextResponse.json({ error: "Could not strike that." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
