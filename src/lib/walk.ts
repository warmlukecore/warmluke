// The tryout's third layer: a section walked in a real browser (5 Oct).
//
// The first two layers (lib/tryout.ts, lib/scenarios.ts) try a design with
// the app's functions. This uses the screen itself: the walk page
// (src/walk/page.tsx, built into .walk/walk.html with the app's own
// components and CSS by scripts/build-walk-page.mjs) opened with the
// section and a copy of its rows, at a laptop's width and a phone's, and
// walked by src/walk/walker.mjs: every filter and its choices, the
// search, the sort, the tabs, a row's button, the form filled and saved.
// What breaks comes back as the person would meet it.
//
// It runs where the screen check photographs (lib/screen-shot.ts): a
// Vercel Sandbox from the same snapshot, every outbound connection denied,
// stopped as soon as it is read back. No model is asked. A page or a
// walker that is not here (a build that did not make it) is said, never
// guessed past.
//
// Callers: src/app/api/apply/route.ts (after a build), scripts/check-walk.mjs.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import type { SupabaseClient } from "@supabase/supabase-js";
import { canRunCode, credentials } from "@/lib/code-run";
import { labelForRow } from "@/lib/links";
import { FACES_HERE, SHOT_DIR } from "@/lib/screen-shot";
import {
  isStoreTable,
  readStorePage,
  storeParents,
  storeRowLabel,
  storeSectionColumns,
  type StoreTable,
} from "@/lib/store-read";
import type { ModuleRow, RecordRow, UiSchema } from "@/lib/types";

/** The section as the walk page takes it (src/walk/page.tsx WalkInput), kept loose here: the page reads it. */
export type WalkInput = Record<string, unknown>;

/** One thing tried: what, whether it worked, and why not. */
export type WalkStep = { what: string; ok: boolean; why?: string };
export type Walked = { width: number; steps: WalkStep[]; errors: string[] };

/** Where the built page and the walker are, beside the server's code (next.config's outputFileTracingIncludes). */
const PAGE = join(process.cwd(), ".walk", "walk.html");
const WALKER = join(process.cwd(), "src", "walk", "walker.mjs");

/** The widths walked: a laptop's, and a phone's with touch. */
export const WALK_WIDTHS = [
  { w: 1440, h: 900, phone: false },
  { w: 390, h: 844, phone: true },
];

/** Whether a walk can be made from here: the page built, a snapshot named, a sandbox reachable. */
export const canWalk = () =>
  existsSync(PAGE) && existsSync(WALKER) && !!process.env.SCREEN_SNAPSHOT_ID?.trim() && canRunCode();

/** The page with this section in it: its input where the page reads it, safe inside a script. */
export function walkPage(html: string, input: WalkInput): string {
  const json = JSON.stringify(input).replaceAll("<", "\\u003c");
  return html.replace("/*WL_WALK*/null", json);
}

/** Inside the machine: the page at each width, walked, and what came of it written down. */
const RUNNER = `import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { walk } from "./walker.mjs";
const face = (name, file) =>
  existsSync(file) ? "@font-face{font-family:" + name + ";src:url(data:font/ttf;base64," + readFileSync(file).toString("base64") + ") format(truetype);font-weight:100 900;font-display:block}" : "";
const faces = face("WL Sans", "fonts/sans.ttf") + face("WL Display", "fonts/display.ttf");
const html = readFileSync("walk-page.html", "utf8").split(${JSON.stringify(FACES_HERE)}).join(faces);
const widths = JSON.parse(readFileSync("walk-widths.json", "utf8"));
const browser = await chromium.launch();
const out = [];
try {
  for (const { w, h, phone } of widths) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, isMobile: phone, hasTouch: phone });
    await page.setContent(html, { waitUntil: "load" });
    const walked = await walk(page);
    out.push({ width: w, ...walked });
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync("walked.json", JSON.stringify(out));`;

const unavailable = (why: string) => new Error(`walk unavailable: ${why}`);

/**
 * The section walked at each width, in a sandbox of its own. Throws
 * Error("walk unavailable: …") when it cannot be: no page built, no
 * snapshot or credentials, past the time allowed, or anything failing on
 * the way. The sandbox is always stopped.
 */
export async function walkSection(
  input: WalkInput,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<Walked[]> {
  if (!existsSync(PAGE)) throw unavailable("the walk page was not built (scripts/build-walk-page.mjs)");
  const snapshotId = process.env.SCREEN_SNAPSHOT_ID?.trim();
  if (!snapshotId) throw unavailable("SCREEN_SNAPSHOT_ID is not set");
  if (!canRunCode()) throw unavailable("no sandbox credentials here");
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const stop = new AbortController();
  const late = setTimeout(() => stop.abort(), timeoutMs);
  const caller = () => stop.abort();
  opts.signal?.addEventListener("abort", caller, { once: true });
  const signal = stop.signal;
  const given = new Promise<never>((_, no) =>
    signal.addEventListener("abort", () => no(new Error("stopped")), { once: true })
  );
  const work = async (): Promise<Walked[]> => {
    let sandbox: Sandbox | null = null;
    try {
      sandbox = await Sandbox.create({
        ...credentials(),
        source: { type: "snapshot", snapshotId },
        region: process.env.VERCEL_REGION || "bom1",
        timeout: timeoutMs + 15_000,
        resources: { vcpus: 2 },
        networkPolicy: "deny-all",
        persistent: false,
        signal,
      });
      await sandbox.writeFiles(
        [
          { path: `${SHOT_DIR}/walk.mjs`, content: Buffer.from(RUNNER) },
          { path: `${SHOT_DIR}/walker.mjs`, content: readFileSync(WALKER) },
          { path: `${SHOT_DIR}/walk-page.html`, content: Buffer.from(walkPage(readFileSync(PAGE, "utf8"), input)) },
          { path: `${SHOT_DIR}/walk-widths.json`, content: Buffer.from(JSON.stringify(WALK_WIDTHS)) },
        ],
        { signal }
      );
      const ran = await sandbox.runCommand({
        cmd: "node",
        args: ["walk.mjs"],
        cwd: SHOT_DIR,
        env: { PLAYWRIGHT_BROWSERS_PATH: `${SHOT_DIR}/browsers` },
        signal,
        timeoutMs,
      });
      if (ran.exitCode !== 0) throw new Error(`the browser failed: ${(await ran.stderr()).trim().slice(-300)}`);
      const read = await sandbox.readFileToBuffer({ path: `${SHOT_DIR}/walked.json` }, { signal });
      if (!read) throw new Error("the walk wrote nothing");
      const got = JSON.parse(read.toString("utf8")) as Walked[];
      return got.map((g) => ({
        width: Number(g.width),
        steps: (Array.isArray(g.steps) ? g.steps : []).slice(0, 40).map((s) => ({
          what: String(s.what ?? "").slice(0, 120),
          ok: s.ok === true,
          ...(s.ok === true ? {} : { why: String(s.why ?? "").slice(0, 300) }),
        })),
        errors: (Array.isArray(g.errors) ? g.errors : []).map((e) => String(e).slice(0, 200)).slice(0, 10),
      }));
    } finally {
      void sandbox?.stop().catch(() => {});
    }
  };
  try {
    return await Promise.race([work(), given]);
  } catch (e) {
    const why = opts.signal?.aborted
      ? "stopped"
      : signal.aborted
        ? `took longer than ${Math.round(timeoutMs / 1000)} seconds`
        : e instanceof Error
          ? e.message.slice(0, 300)
          : String(e);
    throw unavailable(why);
  } finally {
    clearTimeout(late);
    opts.signal?.removeEventListener("abort", caller);
    stop.abort();
  }
}

/** What broke on the walk, once a thing whichever width it broke at, said as the person would meet it. */
export function walkBreaks(walked: Walked[]): string[] {
  const out = new Map<string, Set<number>>();
  for (const w of walked)
    for (const s of w.steps)
      if (!s.ok) {
        const line = `${s.what}: ${s.why ?? "did not work"}`;
        out.set(line, (out.get(line) ?? new Set()).add(w.width));
      }
  return [...out].map(([line, widths]) =>
    widths.size === walked.length
      ? line
      : `${line} (on ${[...widths].map((w) => (w < 600 ? "a phone" : "a laptop")).join(" and ")})`
  );
}

/** As many rows as a walk is handed: enough to filter and sort, never a whole store. */
const WALK_ROWS = 50;

/** A section's columns and features as they now stand, the store's columns laid in. */
async function schemaOf(db: SupabaseClient, mod: ModuleRow): Promise<UiSchema | null> {
  const { data } = await db
    .from("ui_schemas")
    .select("schema_json")
    .eq("module_id", mod.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const saved = (data?.schema_json ?? null) as UiSchema | null;
  if (!saved) return null;
  return isStoreTable(mod.source_table)
    ? { ...saved, columns: storeSectionColumns(mod.source_table, saved.columns) }
    : saved;
}

/** A section's newest rows, as the app reads them: its own records, or the store's first page. */
async function rowsOf(
  db: SupabaseClient,
  mod: ModuleRow,
  schema: UiSchema
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  if (isStoreTable(mod.source_table)) {
    const page = await readStorePage(
      db,
      mod.id,
      mod.source_table,
      { page: 0, size: WALK_ROWS, search: "", filters: {}, sort: null },
      schema.features ?? null,
      schema.columns,
      null,
      []
    );
    return page.rows.map((r) => ({ id: String(r.id), data: r.data }));
  }
  const { data } = await db
    .from("records")
    .select("id, data")
    .eq("module_id", mod.id)
    .order("created_at", { ascending: false })
    .limit(WALK_ROWS);
  return (data ?? []).map((r) => ({ id: r.id as string, data: (r.data ?? {}) as Record<string, unknown> }));
}

/**
 * What the walk page is handed for one section as it is now built: its
 * columns and features, its newest rows, and for each link the rows it
 * offers and what it points at, read with the caller's own client. Null
 * when the section is not there.
 */
export async function walkInputFor(
  db: SupabaseClient,
  projectId: string,
  moduleId: string,
  fmt: { locale: string; currency: string; timeZone: string }
): Promise<{ name: string; input: WalkInput } | null> {
  const { data: mods } = await db.from("modules").select("*").eq("project_id", projectId);
  const all = (mods ?? []) as ModuleRow[];
  const mod = all.find((m) => m.id === moduleId);
  if (!mod) return null;
  const schema = await schemaOf(db, mod);
  if (!schema) return null;
  const rows = await rowsOf(db, mod, schema);
  const links: Record<string, Array<{ id: string; label: string; data: Record<string, unknown> }>> = {};
  const targets: Record<
    string,
    { table: string | null; parents: Record<string, string>; columns: UiSchema["columns"] }
  > = {};
  for (const c of schema.columns) {
    if (c.type !== "link" || !c.linkTo || links[c.linkTo]) continue;
    const there = all.find((m) => m.id === c.linkTo);
    const theirs = there ? await schemaOf(db, there) : null;
    if (!there || !theirs) continue;
    const table = isStoreTable(there.source_table) ? (there.source_table as StoreTable) : null;
    links[c.linkTo] = (await rowsOf(db, there, theirs)).map((r) => ({
      id: r.id,
      label: table ? storeRowLabel(table, r.data) : labelForRow({ id: r.id, data: r.data } as RecordRow, theirs),
      data: r.data,
    }));
    targets[c.linkTo] = { table, parents: table ? storeParents(table) : {}, columns: theirs.columns };
  }
  return {
    name: mod.nav_label || mod.name,
    input: { schema, rows, links, targets, locale: fmt.locale, currency: fmt.currency, timeZone: fmt.timeZone },
  };
}

/** The changes that alter how a section is used: the ones walked after a build. */
const WALKED = new Set(["NEW_MODULE", "UI_CHANGE", "FIELD_ADD", "FEATURE_UPDATE"]);
/** At most this many sections a build: each is a sandbox of its own, and the first two say what the rest would. */
const WALK_SECTIONS = 2;

/** A built section, walked: how many things were tried, and what broke. */
export type WalkedSection = { name: string; tried: number; breaks: string[] };

/**
 * After a build: each section it made or changed walked in a browser, and
 * what came of it kept on the build's own line in the thread, for the
 * card to show and offer to fix. Runs after the answer has gone; never
 * throws, and a walk that cannot be made leaves the line as it was.
 */
export async function walkAfterBuild(
  db: SupabaseClient,
  projectId: string,
  applied: Array<Record<string, unknown>>,
  messageId: string
): Promise<void> {
  try {
    const ids = [
      ...new Set(
        applied
          .filter((a) => WALKED.has(String(a.changeType)) && typeof a.moduleId === "string")
          .map((a) => a.moduleId as string)
      ),
    ].slice(0, WALK_SECTIONS);
    if (!ids.length || !canWalk()) return;
    const [{ data: proj }, { data: store }] = await Promise.all([
      db.from("projects").select("locale, currency").eq("id", projectId).maybeSingle(),
      db.from("stores").select("timezone").eq("project_id", projectId).maybeSingle(),
    ]);
    const fmt = {
      locale: (proj?.locale as string) || "en-IN",
      currency: (proj?.currency as string) || "INR",
      timeZone: (store?.timezone as string) || "UTC",
    };
    const sections: WalkedSection[] = [];
    for (const id of ids) {
      const got = await walkInputFor(db, projectId, id, fmt);
      if (!got) continue;
      const walked = await walkSection(got.input);
      sections.push({
        name: got.name,
        tried: walked.reduce((n, w) => n + w.steps.length, 0),
        breaks: walkBreaks(walked),
      });
    }
    if (!sections.length) return;
    const { data: line } = await db.from("messages").select("payload").eq("id", messageId).maybeSingle();
    if (!line) return;
    await db
      .from("messages")
      .update({ payload: { ...(line.payload as Record<string, unknown>), walked: sections } })
      .eq("id", messageId);
  } catch (e) {
    console.error(`[walk] ${e instanceof Error ? e.message : "failed"}`);
  }
}
