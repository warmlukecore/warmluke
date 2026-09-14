import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { applyPlans } from "@/lib/apply";
import type { AssistantPlan } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/apply — body: { projectId, plans }
 * The app's entrance to the builder. The work itself lives in
 * lib/apply, which the MCP approval path uses as well, so a change to
 * how plans are applied cannot land in one place and miss the other.
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const { client } = auth;

    const { projectId, plans } = (await req.json()) as {
      projectId?: string;
      plans?: AssistantPlan[];
    };
    if (!projectId || !Array.isArray(plans) || plans.length === 0) {
      return NextResponse.json({ error: "projectId and plans are required" }, { status: 400 });
    }

    // Verify project ownership via RLS (query returns nothing if not owner).
    const { data: proj } = await client.from("projects").select("id").eq("id", projectId).limit(1);
    if (!proj?.[0]) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    const { applied, errors } = await applyPlans(client, projectId, plans);

    if (applied.length === 0) {
      return NextResponse.json({ applied: false, errors }, { status: 422 });
    }

    // Plans run in order and stop at the first failure, so a partial run
    // leaves the rest unbuilt. Reporting only the successes would hand
    // back a half-built feature with no sign that anything was missing.
    if (errors.length > 0) {
      return NextResponse.json({
        applied: true,
        partial: true,
        count: applied.length,
        remaining: Math.min(plans.length, 6) - applied.length,
        results: applied,
        errors,
      });
    }

    return NextResponse.json({ applied: true, count: applied.length, results: applied });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
