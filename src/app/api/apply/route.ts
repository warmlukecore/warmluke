import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { applyPlans, logClientBuild } from "@/lib/apply";
import { describePlan } from "@/lib/describe";
import type { AssistantPlan, ModuleRow } from "@/lib/types";

export const runtime = "nodejs";

/**
 * POST /api/apply — body: { projectId, plans, requestId? }
 *
 * The app's entrance to the builder. The work itself lives in
 * lib/apply, which the MCP approval path uses as well, so a change to
 * how plans are applied cannot land in one place and miss the other.
 *
 * requestId is what the panel passes when the owner taps Build on a
 * card their assistant raised. Without it that path claimed nothing:
 * two tabs, or a second tap before the first rerendered, or the app
 * racing the connected client, all ran the same plans at once — the
 * status only moved to built after the writes were already done. The
 * claim is a compare-and-set, so the second caller is told it is
 * already being built rather than building it again.
 */
export async function POST(req: Request) {
  try {
    const auth = await getUserClient(req);
    if (!auth) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const { client } = auth;

    const { projectId, plans, requestId } = (await req.json()) as {
      projectId?: string;
      plans?: AssistantPlan[];
      requestId?: string;
    };
    if (!projectId || !Array.isArray(plans) || plans.length === 0) {
      return NextResponse.json({ error: "projectId and plans are required" }, { status: 400 });
    }

    // Verify project ownership via RLS (query returns nothing if not owner).
    const { data: proj } = await client.from("projects").select("id").eq("id", projectId).limit(1);
    if (!proj?.[0]) {
      return NextResponse.json({ error: "Project not found." }, { status: 404 });
    }

    if (requestId) {
      const { data: claim, error: claimErr } = await client.rpc("abo_build", {
        p_project: projectId,
        p_request: requestId,
        p_op: "request_claim",
        p_payload: {},
      });
      if (claimErr) {
        return NextResponse.json({ error: claimErr.message }, { status: 400 });
      }
      if (Number((claim as { count?: number } | null)?.count ?? 0) === 0) {
        // Somebody got here first. Not an error to the person who
        // tapped second — the thing they asked for is happening.
        return NextResponse.json(
          { applied: false, already: true, error: "This is already being built." },
          { status: 409 }
        );
      }
    }

    const { applied, errors } = await applyPlans(client, projectId, plans, requestId ?? null);

    if (applied.length === 0) {
      if (requestId) {
        // Put it back for whoever wants to try again.
        await client.rpc("abo_build", {
          p_project: projectId,
          p_request: requestId,
          p_op: "request_release",
          p_payload: {},
        });
      }
      return NextResponse.json({ applied: false, errors }, { status: 422 });
    }

    if (requestId) {
      // The outcome decides the status, and it believes the errors.
      await client.rpc("abo_build", {
        p_project: projectId,
        p_request: requestId,
        p_op: "request_built",
        p_payload: { applied, errors },
      });

      // A request row exists only when this came from the merchant's
      // own assistant, so this is the one path where the thread needs
      // to say what was asked — the browser knows the outcome but the
      // question was put somewhere else entirely.
      const { data: askedRow } = await client
        .from("build_requests")
        .select("request, client_id")
        .eq("id", requestId)
        .maybeSingle();
      const asked = (askedRow as { request?: string; client_id?: string | null } | null) ?? null;
      if (asked?.client_id && asked.request) {
        const { data: mods } = await client
          .from("modules")
          .select("*")
          .eq("project_id", projectId);
        const titles = (plans as AssistantPlan[])
          .slice(0, applied.length)
          .map((p) => describePlan(p, (mods ?? []) as ModuleRow[]).title)
          .filter(Boolean);
        const shown = titles.slice(0, 3).join(" · ");
        const rest = titles.length - 3;
        await logClientBuild(
          client,
          projectId,
          asked.request,
          `✅ ${shown}${rest > 0 ? ` · and ${rest} more` : ""}${
            errors.length ? " — the rest stopped on an error." : "."
          }`
        );
      }
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
