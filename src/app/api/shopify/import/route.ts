import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import { RESOURCES, importPage, type Resource, type StoreToken } from "@/lib/shopify-import";
import { ShopifyError } from "@/lib/shopify";
import { isTransient } from "@/lib/retry";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/shopify/import — pull one page, say what is left.
 *
 * Called repeatedly rather than once: a serverless request is killed
 * long before a real store finishes, so each call does a bounded amount
 * of work and records where it stopped. Whoever is calling — the browser
 * while a progress bar is open, or a cron later — just calls again while
 * `done` is false.
 */
export async function POST(req: Request) {
  const auth = await getUserClient(req);
  if (!auth) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  const { projectId } = (await req.json().catch(() => ({}))) as { projectId?: string };
  if (!projectId) return NextResponse.json({ error: "projectId is required." }, { status: 400 });

  // RLS decides whether this store is reachable; there is no owner check
  // here because that would be a second opinion on the same question.
  const { data: store } = await auth.client
    .from("stores")
    .select("id, shop_domain, access_token, status, refresh_token, token_expires_at")
    .eq("project_id", projectId)
    .maybeSingle();

  if (!store) return NextResponse.json({ error: "No store connected." }, { status: 404 });
  if (store.status !== "connected" || !store.access_token) {
    return NextResponse.json({ error: "That store isn't connected yet." }, { status: 409 });
  }

  const { data: runs } = await auth.client
    .from("import_runs")
    .select("id, resource, status, cursor, imported")
    .eq("store_id", store.id);

  const byResource = new Map((runs ?? []).map((r) => [r.resource as Resource, r]));

  // Resources in a fixed order. An order's customer and variant links can
  // only be made once those rows are present.
  const resource = RESOURCES.find((r) => (byResource.get(r)?.status ?? "pending") !== "done");
  if (!resource) {
    await auth.client
      .from("stores")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("id", store.id);
    return NextResponse.json({ done: true, progress: summarise(runs ?? []) });
  }

  const run = byResource.get(resource);
  try {
    const page = await importPage(
      auth.client,
      store as StoreToken,
      resource,
      run?.cursor ?? null
    );

    const imported = (run?.imported ?? 0) + page.imported;
    const row = {
      store_id: store.id,
      resource,
      status: page.hasNext ? "running" : "done",
      cursor: page.cursor,
      imported,
      finished_at: page.hasNext ? null : new Date().toISOString(),
    };
    if (run) await auth.client.from("import_runs").update(row).eq("id", run.id);
    else await auth.client.from("import_runs").insert(row);

    const after = (runs ?? []).filter((r) => r.resource !== resource).concat([{ ...run, ...row } as never]);
    return NextResponse.json({
      done: false,
      resource,
      imported: page.imported,
      total: imported,
      progress: summarise(after),
    });
  } catch (e) {
    // The failure is recorded against the resource so a retry resumes
    // from the last good cursor rather than starting over.
    const message = e instanceof ShopifyError ? e.message : e instanceof Error ? e.message : "Import failed.";
    const row = { store_id: store.id, resource, status: "failed", error: message, cursor: run?.cursor ?? null };
    if (run) await auth.client.from("import_runs").update(row).eq("id", run.id);
    else await auth.client.from("import_runs").insert(row);
    // Whether another call is worth making is decided here, where the
    // error still is one, rather than by the browser re-reading a
    // sentence. The client already resumes from the cursor above.
    return NextResponse.json(
      { done: false, resource, error: message, retryable: isTransient(e) },
      { status: 502 }
    );
  }
}

function summarise(runs: Array<{ resource?: string; imported?: number; status?: string }>) {
  return Object.fromEntries(
    RESOURCES.map((r) => {
      const run = runs.find((x) => x?.resource === r);
      return [r, { imported: run?.imported ?? 0, status: run?.status ?? "pending" }];
    })
  );
}
