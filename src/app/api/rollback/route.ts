import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import type { UiSchemaRow } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/rollback — body: { moduleId, version }
 * Copies the historical schema_json forward as a brand-new version.
 * Append-only: no updates, no deletes. RLS ensures ownership.
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const { client } = auth;

    const { moduleId, version } = (await req.json()) as {
      moduleId?: string;
      version?: number;
    };
    if (!moduleId || typeof version !== "number") {
      return NextResponse.json({ error: "moduleId and version are required" }, { status: 400 });
    }

    const { data: rows, error: fetchErr } = await client
      .from("ui_schemas")
      .select("*")
      .eq("module_id", moduleId)
      .eq("version", version)
      .limit(1);
    if (fetchErr) throw new Error(fetchErr.message);
    const source = rows?.[0] as UiSchemaRow | undefined;
    if (!source) {
      return NextResponse.json({ error: "Version not found." }, { status: 404 });
    }

    const { data: latest, error: verErr } = await client
      .from("ui_schemas")
      .select("version")
      .eq("module_id", moduleId)
      .order("version", { ascending: false })
      .limit(1);
    if (verErr) throw new Error(verErr.message);
    const nextVersion = (latest?.[0]?.version ?? 0) + 1;

    const { error: insertErr } = await client.from("ui_schemas").insert({
      module_id: moduleId,
      schema_json: source.schema_json,
      version: nextVersion,
      created_by: "user",
      change_description: `Rolled back to v${version}`,
    });
    if (insertErr) throw new Error(insertErr.message);

    return NextResponse.json({ applied: true, version: nextVersion });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
