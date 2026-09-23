// ─────────────────────────────────────────────────────────────
// One bounded step of a store's import, whoever is driving it.
//
// Two callers, one step. The owner's route runs it as the merchant,
// page by page, when nothing else will (a deployment with no worker
// address). The background worker runs it with a ticket the database
// minted for this one store. What the step may touch is decided by the
// client it is handed — the merchant's session or the ticket — and the
// database's policies, never by which of the two called.
//
// Each call does a bounded amount of work and records where it
// stopped, so the next call — from either — resumes there.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoreToken } from "@/lib/shopify-import";
import { RESOURCES, SHOPIFY_RESOURCES, importPage, type Resource } from "@/lib/shopify-resources";
import { BULK_THRESHOLD, countOf, ingestSlice, pollBulk, startBulk } from "@/lib/shopify-bulk";
import { ShopifyError } from "@/lib/shopify";
import { ensureFreshToken } from "@/lib/shopify-import";
import { isTransient } from "@/lib/retry";

type Db = SupabaseClient;

/**
 * How often a failing resource is tried with nobody watching, and how
 * long between. Doubling from a minute: throttling and outages clear
 * on their own well inside that, and a real fault stops after five
 * without spending Shopify's patience on it. The merchant's "Try
 * again" starts the count over.
 */
export const MOST_ATTEMPTS = 5;
const waitAfter = (attempts: number) => Math.min(2 ** (attempts - 1), 30) * 60_000;

type Run = {
  id: string;
  resource: string;
  status: string;
  cursor: string | null;
  imported: number;
  finished_at: string | null;
  error: string | null;
  attempts: number | null;
  retry_at: string | null;
};

const RUN_COLUMNS = "id, resource, status, cursor, imported, finished_at, error, attempts, retry_at";

export type StepResult = { status: number; body: Record<string, unknown> };

export async function importStep(
  db: Db,
  store: StoreToken,
  opts: {
    /** Only say where things stand; read nothing from Shopify. */
    status?: boolean;
    /** Read Shopify over again, from the start. */
    recheck?: boolean;
    /**
     * Wait out a failed resource's retry_at instead of trying it now.
     * The worker honours it; a merchant pressing a button does not.
     */
    honourBackoff?: boolean;
  } = {}
): Promise<StepResult> {
  let { data: runs } = await db.from("import_runs").select(RUN_COLUMNS).eq("store_id", store.id).returns<Run[]>();

  // The strip asks this on mount, to decide whether to keep going or
  // to count what is held. The answer names every resource there is,
  // so a resource added to the registry is walked without the strip
  // knowing its name.
  if (opts.status) {
    const byResource = new Map((runs ?? []).map((r) => [r.resource, r]));
    // A resource nobody will retry on their own is the merchant's to
    // hear about: nothing moves until they say try again.
    const stopped = RESOURCES.map((r) => byResource.get(r)).find((r) => r?.status === "failed" && !r.retry_at);
    return {
      status: 200,
      body: {
        done: RESOURCES.every((r) => byResource.get(r)?.status === "done"),
        progress: summarise(runs ?? []),
        ...(stopped ? { stopped: { resource: stopped.resource, error: stopped.error } } : {}),
      },
    };
  }

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
  if (opts.recheck && (runs ?? []).length > 0) {
    await db
      .from("import_runs")
      .update({ status: "pending", cursor: null, imported: 0, finished_at: null, attempts: 0, retry_at: null })
      .eq("store_id", store.id);
    return { status: 200, body: { done: false, rechecking: true, progress: summarise([]) } };
  }

  // Every resource in the registry has a row before any is walked.
  // The database decides which stores still have work by looking for
  // a row that is not done, and a resource with no row yet would read
  // as nothing left to do. Inserted only where missing, so progress
  // already made is untouched — and a resource added to the registry
  // after a store finished gets its row, and its import, here.
  const have = new Set((runs ?? []).map((r) => r.resource));
  const absent = RESOURCES.filter((r) => !have.has(r));
  if (absent.length) {
    const { error } = await db
      .from("import_runs")
      .upsert(
        absent.map((resource) => ({ store_id: store.id, resource, status: "pending" })),
        { onConflict: "store_id,resource", ignoreDuplicates: true }
      );
    if (error) console.error("could not record the resources to import:", error.message);
    ({ data: runs } = await db.from("import_runs").select(RUN_COLUMNS).eq("store_id", store.id).returns<Run[]>());
  }

  const byResource = new Map((runs ?? []).map((r) => [r.resource as Resource, r]));

  // Resources in a fixed order. An order's customer and variant links can
  // only be made once those rows are present.
  const resource = RESOURCES.find((r) => (byResource.get(r)?.status ?? "pending") !== "done");
  if (!resource) return finish(db, store, runs ?? []);

  const run = byResource.get(resource);

  // Nobody watching: a failure waits its turn, and one given up on
  // waits for the merchant. Everything after it waits too — its rows
  // link to the ones this resource would have brought.
  if (opts.honourBackoff && run?.status === "failed") {
    const due = !!run.retry_at && Date.parse(run.retry_at) <= Date.now();
    if (!due) {
      return {
        status: 200,
        body: { done: false, held: true, resource, retry_at: run.retry_at, progress: summarise(runs ?? []) },
      };
    }
  }

  try {
    const step = await advance(db, store, resource, run?.cursor ?? null);
    // A bulk operation Shopify is still running has produced nothing to
    // write yet. Saying so beats reporting zero rows imported, which
    // reads as a finished import of an empty store.
    if (step.waiting) {
      return {
        status: 200,
        body: {
          done: false,
          resource,
          waiting: true,
          imported: 0,
          total: run?.imported ?? 0,
          progress: summarise(runs ?? []),
        },
      };
    }
    const page = step;

    const imported = page.restart ? 0 : (run?.imported ?? 0) + page.imported;
    const row = {
      store_id: store.id,
      resource,
      status: page.hasNext ? "running" : "done",
      cursor: page.cursor,
      imported,
      finished_at: page.hasNext ? null : new Date().toISOString(),
      // A page that worked ends any run of failures.
      error: null,
      attempts: 0,
      retry_at: null,
    };
    // Two callers starting at once both had no row to update, and both
    // inserted; the unique index now refuses the second, so it is an
    // upsert rather than an error nobody reads.
    let wrote;
    if (run) {
      // The same compare-and-set the failure path uses. A slow request
      // finishing after a faster one would otherwise drag the cursor
      // back to where this one had got to — the rows it imported are
      // upserts and survive either way, but the progress must not go
      // backwards.
      let q = db.from("import_runs").update(row).eq("id", run.id).eq("status", run.status);
      q = run.cursor === null ? q.is("cursor", null) : q.eq("cursor", run.cursor);
      ({ error: wrote } = await q);
    } else {
      ({ error: wrote } = await db.from("import_runs").upsert(row, { onConflict: "store_id,resource" }));
    }
    if (wrote) throw new Error(wrote.message);

    const after = (runs ?? []).filter((r) => r.resource !== resource).concat([{ ...run, ...row } as Run]);
    return {
      status: 200,
      body: { done: false, resource, imported: page.imported, total: imported, progress: summarise(after) },
    };
  } catch (e) {
    // The failure is recorded against the resource so a retry resumes
    // from the last good cursor rather than starting over.
    const message = e instanceof ShopifyError ? e.message : e instanceof Error ? e.message : "Import failed.";
    // A dead bulk operation is the one failure whose cursor must not
    // survive: keeping it would point every retry back at an operation
    // Shopify will never finish.
    const spent = e instanceof ShopifyError && e.code === "bulk_failed";
    // And it is never retryable, whatever it failed with. Shopify's
    // TIMEOUT reads as transient, and with no cursor left a retry would
    // start a whole new export — the automatic relaunch this was meant
    // to stop.
    const retryable = spent ? false : isTransient(e);
    const attempts = (run?.attempts ?? 0) + 1;
    const row = {
      store_id: store.id,
      resource,
      status: "failed",
      error: message,
      cursor: spent ? null : (run?.cursor ?? null),
      attempts,
      // When to try again with nobody watching — or never, until the
      // merchant says so.
      retry_at:
        retryable && attempts < MOST_ATTEMPTS ? new Date(Date.now() + waitAfter(attempts)).toISOString() : null,
    };
    // A failure must never be the newest thing written. Two callers can
    // both be here while one of them succeeded in between, and this row
    // carries the cursor as it was read at the top of the request — so
    // writing it flatly would put a finished import back to where this
    // one started, and blank the cursor of a resource that had moved on.
    //
    // So: only overwrite the row this request actually saw, matched on
    // the cursor it was holding; and if there was no row to see, insert
    // one only where nobody else has since.
    let noted;
    if (run) {
      // The status as well as the cursor. A resource that finished
      // empty ends at status done with the cursor still null — which is
      // exactly the state this request read — so matching the cursor
      // alone would let a failure here undo somebody else's finished
      // import.
      let q = db.from("import_runs").update(row).eq("id", run.id).eq("status", run.status);
      q = run.cursor === null ? q.is("cursor", null) : q.eq("cursor", run.cursor);
      ({ error: noted } = await q);
    } else {
      ({ error: noted } = await db
        .from("import_runs")
        .upsert(row, { onConflict: "store_id,resource", ignoreDuplicates: true }));
    }
    if (noted) console.error("could not record the import failure:", noted.message);
    // Whether another call is worth making is decided here, where the
    // error still is one, rather than by the browser re-reading a
    // sentence. The client already resumes from the cursor above.
    return { status: 502, body: { done: false, resource, error: message, retryable } };
  }
}

/** Nothing left to walk: stamp when it finished, and say what drifted. */
async function finish(db: Db, store: StoreToken, runs: Run[]): Promise<StepResult> {
  // This branch used to stamp last_synced_at with now() every time
  // anybody asked — so the app said the store was fresh at the moment
  // of asking, having read nothing from Shopify at all. It is when the
  // last pass actually finished.
  const finished = runs
    .map((r) => r.finished_at)
    .filter(Boolean)
    .sort()
    .pop();
  // Only ever forward, and decided in one statement. An order webhook
  // stamps this the moment it lands; reading the value here and
  // writing it after would let one land in between and be undone.
  if (finished) {
    const { error: stamped } = await db.rpc("abo_store_synced", { p_store: store.id, p_at: finished });
    if (stamped) console.error("could not record the sync time:", stamped.message);
  }

  // Rows we hold that the pass did not bring back.
  //
  // A pass has just walked the whole of Shopify, so what it imported
  // IS Shopify's count — no second API call is needed to learn it.
  // Anything we hold beyond that was removed in Shopify while nobody
  // was listening: a delete webhook that never arrived, a
  // subscription that lapsed, an outage.
  //
  // Reported, never deleted. A page that failed quietly, or a bulk
  // file that came back short, would look exactly like a deletion —
  // and a wrong delete does not come back. Saying so ends the
  // silence, which is the actual problem; sweeping rows away would
  // trade it for a worse one.
  const drift: Record<string, { holding: number; imported: number }> = {};
  for (const [resource, table] of Object.entries(COUNTED)) {
    const imported = runs.find((r) => r.resource === resource)?.imported ?? 0;
    const { count } = await db.from(table).select("id", { count: "exact", head: true }).eq("store_id", store.id);
    const holding = count ?? 0;
    // Only rows we hold and the pass did not bring back. Fewer than
    // imported means something arrived by webhook while the pass was
    // running, which is the system working, not a loss.
    if (holding > imported) drift[resource] = { holding, imported };
  }

  return {
    status: 200,
    body: {
      done: true,
      checked_at: finished ?? null,
      note: "Everything imported. Ask again with recheck to read Shopify over from the start.",
      ...(Object.keys(drift).length
        ? {
            drift,
            drift_note:
              "These are here but did not come back from Shopify this time — most likely removed there while a webhook was not delivered. Nothing has been deleted.",
          }
        : {}),
      progress: summarise(runs),
    },
  };
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
): Promise<
  | {
      imported: number;
      cursor: string | null;
      hasNext: boolean;
      waiting?: false;
      /** Start this resource's count over: the walk begins again. */
      restart?: boolean;
    }
  | { waiting: true }
> {
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
    // Asked for by id. currentBulkOperation returns the most recent
    // one, and Shopify now runs five at once, so ours could simply not
    // be the one that came back.
    const op = await pollBulk(shop, token, cursor.slice(5));
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
      // FAILED, CANCELED and EXPIRED are final: this operation will
      // never produce a file. This used to throw and keep the bulk:
      // cursor, so every retry polled the same dead operation for
      // ever. Clearing the cursor and reporting success was worse
      // again — a store that cannot export would quietly start a new
      // operation on every poll and never say so.
      //
      // So it stays an error, which the caller sees and stops on, and
      // the catch above clears the cursor for this one code so the
      // next attempt is a fresh start rather than the same corpse.
      throw new ShopifyError("bulk_failed", `Shopify could not export ${resource}: ${op.errorCode ?? op.status}.`);
    }
    return { imported: 0, cursor: `read:0|${op.url}`, hasNext: true };
  }

  if (cursor === null) {
    // Counting first costs one small query and decides the route. A
    // store with a few hundred rows finishes before a bulk operation
    // would even have been queued.
    const count = await countOf(shop, token, resource);
    if (count > BULK_THRESHOLD && SHOPIFY_RESOURCES[resource].bulk) {
      const id = await startBulk(shop, token, resource);
      return { imported: 0, cursor: `bulk:${id}`, hasNext: true };
    }
  }

  const page = await importPage(db, store, resource, cursor);

  // A page that hit a child limit lost rows nobody would have missed:
  // the variants past the hundredth, the order lines past the
  // hundredth. The bulk route asks for children with no limit at all,
  // so the resource starts again that way rather than finishing a walk
  // that is already incomplete. Everything written is an upsert keyed
  // on the Shopify id, so starting over costs time and nothing else.
  if (page.cut) {
    const id = await startBulk(shop, token, resource);
    // The count starts again, not just this page.
    //
    // Zeroing one page was not enough: the pages already walked stay
    // in run.imported, and the bulk pass then counts the same rows
    // from the beginning on top of them. The total would say the store
    // holds more than it does, and the drift report reads that total.
    return { imported: 0, cursor: `bulk:${id}`, hasNext: true, restart: true };
  }

  return page;
}

/**
 * Which of our tables holds each resource, for counting what we keep:
 * the parent table of every resource that says its rows can be compared
 * with what a pass brought back. Each resource decides that for itself
 * (`drift` in lib/shopify-resources); stock says no, because a pass
 * counts variants and the table holds one row per location.
 */
const COUNTED = Object.fromEntries(
  RESOURCES.filter((r) => SHOPIFY_RESOURCES[r].drift).map((r) => [r, SHOPIFY_RESOURCES[r].tables[0]])
);

/** Where each resource stands, with what to call it and which table holds it. */
function summarise(runs: Array<Partial<Run>>) {
  return Object.fromEntries(
    RESOURCES.map((r) => {
      const run = runs.find((x) => x?.resource === r);
      const spec = SHOPIFY_RESOURCES[r];
      return [
        r,
        {
          imported: run?.imported ?? 0,
          status: run?.status ?? "pending",
          label: spec.label,
          holds: spec.tables[0],
          // When a failed resource will be tried again with nobody
          // watching; absent when it will not be.
          ...(run?.status === "failed" && run.retry_at ? { retry_at: run.retry_at } : {}),
        },
      ];
    })
  );
}
