import { NextResponse } from "next/server";
import { getUserClient } from "@/lib/supabase-server";
import {
  RESOURCES,
  ensureFreshToken,
  importPage,
  type Resource,
  type StoreToken,
} from "@/lib/shopify-import";
import { BULK_THRESHOLD, countOf, ingestSlice, pollBulk, startBulk } from "@/lib/shopify-bulk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ShopifyError } from "@/lib/shopify";
import { isTransient } from "@/lib/retry";

export const runtime = "nodejs";
export const maxDuration = 60;

type Db = SupabaseClient;

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

  const { projectId, recheck } = (await req.json().catch(() => ({}))) as {
    projectId?: string;
    recheck?: boolean;
  };
  if (!projectId) return NextResponse.json({ error: "projectId is required." }, { status: 400 });

  // RLS decides whether this store is reachable; there is no owner check
  // here because that would be a second opinion on the same question.
  const { data: found } = await auth.client
    .from("stores")
    .select("id, shop_domain, status")
    .eq("project_id", projectId)
    .maybeSingle();

  if (!found) return NextResponse.json({ error: "No store connected." }, { status: 404 });

  // The token is no longer a column anyone may select — a seat on the
  // project used to be enough to read it. It comes through a function
  // that answers the owner and nobody else, least of all a connected
  // AI client holding their session.
  const { data: secret } = await auth.client
    .rpc("abo_store_token", { p_store: found.id })
    .maybeSingle();
  const store = { ...found, ...(secret ?? {}) } as typeof found & {
    access_token?: string | null;
    refresh_token?: string | null;
    token_expires_at?: string | null;
  };

  if (store.status !== "connected" || !store.access_token) {
    return NextResponse.json({ error: "That store isn't connected yet." }, { status: 409 });
  }

  const { data: runs } = await auth.client
    .from("import_runs")
    .select("id, resource, status, cursor, imported, finished_at")
    .eq("store_id", store.id);

  const byResource = new Map((runs ?? []).map((r) => [r.resource as Resource, r]));

  // Reading Shopify over again, from the start.
  //
  // Webhooks are how this stays current, and a webhook that is never
  // delivered — a subscription that failed to register, an outage, a
  // topic Shopify switched off after too many failures — is missed in
  // silence. Nothing here noticed, because once every resource was
  // done the importer stopped reading Shopify entirely.
  //
  // Every write on this path is an upsert keyed on the Shopify id, so
  // walking it again costs time and changes nothing that is already
  // right. The cursors go back to the beginning and the ordinary loop
  // does the rest — there is no second importer to keep in step with
  // the first.
  if (recheck && (runs ?? []).length > 0) {
    await auth.client
      .from("import_runs")
      .update({ status: "pending", cursor: null, imported: 0, finished_at: null })
      .eq("store_id", store.id);
    return NextResponse.json({
      done: false,
      rechecking: true,
      progress: summarise([]),
    });
  }

  // Resources in a fixed order. An order's customer and variant links can
  // only be made once those rows are present.
  const resource = RESOURCES.find((r) => (byResource.get(r)?.status ?? "pending") !== "done");
  if (!resource) {
    // Nothing left to walk. This branch used to stamp last_synced_at
    // with now() every time anybody asked — so the app said the store
    // was fresh at the moment of asking, having read nothing from
    // Shopify at all. It is when the last pass actually finished.
    const finished = (runs ?? [])
      .map((r) => (r as { finished_at?: string | null }).finished_at)
      .filter(Boolean)
      .sort()
      .pop();
    if (finished) {
      await auth.client.from("stores").update({ last_synced_at: finished }).eq("id", store.id);
    }
    return NextResponse.json({
      done: true,
      checked_at: finished ?? null,
      note: "Everything imported. Ask again with recheck to read Shopify over from the start.",
      progress: summarise(runs ?? []),
    });
  }

  const run = byResource.get(resource);
  try {
    const step = await advance(auth.client, store as StoreToken, resource, run?.cursor ?? null);
    // A bulk operation Shopify is still running has produced nothing to
    // write yet. Saying so beats reporting zero rows imported, which
    // reads as a finished import of an empty store.
    if (step.waiting) {
      return NextResponse.json({
        done: false,
        resource,
        waiting: true,
        imported: 0,
        total: run?.imported ?? 0,
        progress: summarise(runs ?? []),
      });
    }
    const page = step;

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

/**
 * One bounded step of one resource, by whichever route suits the size.
 *
 * Paging is right for a small store and cannot finish a large one; a
 * bulk operation is the reverse. Which one is in play is held in the
 * cursor, so a half-finished import resumes into the same machine it
 * started in — nothing here remembers anything between requests.
 *
 *   null            — nothing started yet: count, then choose
 *   <cursor>        — paging, Shopify's own cursor
 *   bulk:<gid>      — Shopify is building the file
 *   read:<offset>|<url> — reading the file it built
 */
async function advance(
  db: Db,
  store: StoreToken,
  resource: Resource,
  cursor: string | null
): Promise<{ imported: number; cursor: string | null; hasNext: boolean; waiting?: false } | { waiting: true }> {
  const token = await ensureFreshToken(db, store);
  const shop = store.shop_domain;

  if (cursor?.startsWith("read:")) {
    const bar = cursor.indexOf("|");
    const offset = Number(cursor.slice(5, bar));
    const url = cursor.slice(bar + 1);
    const slice = await ingestSlice(db, store.id, resource, url, offset);
    return {
      imported: slice.imported,
      cursor: slice.done ? null : `read:${slice.nextOffset}|${url}`,
      hasNext: !slice.done,
    };
  }

  if (cursor?.startsWith("bulk:")) {
    const op = await pollBulk(shop, token);
    if (!op || op.id !== cursor.slice(5)) {
      // Somebody else's operation, or ours vanished. Start again
      // rather than read a file belonging to another query.
      return { imported: 0, cursor: null, hasNext: true };
    }
    if (op.status === "CREATED" || op.status === "RUNNING") return { waiting: true };
    if (op.status !== "COMPLETED" || !op.url) {
      // An empty store completes with no file at all, which is a
      // finished import of nothing rather than a failure.
      if (op.status === "COMPLETED") return { imported: 0, cursor: null, hasNext: false };
      throw new ShopifyError("bulk_failed", `Shopify could not export ${resource}: ${op.errorCode ?? op.status}.`);
    }
    return { imported: 0, cursor: `read:0|${op.url}`, hasNext: true };
  }

  if (cursor === null) {
    // Counting first costs one small query and decides the route. A
    // store with a few hundred rows finishes before a bulk operation
    // would even have been queued.
    const count = await countOf(shop, token, resource);
    if (count > BULK_THRESHOLD) {
      const id = await startBulk(shop, token, resource);
      return { imported: 0, cursor: `bulk:${id}`, hasNext: true };
    }
  }

  const page = await importPage(db, store, resource, cursor);
  return page;
}

function summarise(runs: Array<{ resource?: string; imported?: number; status?: string }>) {
  return Object.fromEntries(
    RESOURCES.map((r) => {
      const run = runs.find((x) => x?.resource === r);
      return [r, { imported: run?.imported ?? 0, status: run?.status ?? "pending" }];
    })
  );
}
