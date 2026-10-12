// ─────────────────────────────────────────────────────────────
// What Luke and the owner's own AI may do in the app, beside reading it
// (docs/ai-builder/parity.md, 12 Oct).
//
// A merchant changes the values in their rows by hand: a cell, a row's
// pop-up, ticked rows, a row's button. Luke used to say "open the row and
// edit it yourself". Now Luke or their AI asks, and the owner says yes in
// the bell: an ask is a row in 0183's row_approvals (0208), made only
// through abo_ask_rows, and applied by /api/row-action under the owner's
// own rights, through the one write door every edit uses (record-write).
// Nothing here writes a row.
//
// Why always a yes, even when they asked for it in that very message:
// whether a message asked for exactly this change, on exactly these rows,
// is a model's reading of it, and a wrong change to 500 rows is the costly
// mistake; one click in the bell is cheap. Their own AI already cannot
// write without the owner, so the rule is one for both.
//
// And what waits for the owner, read in one place: asks to change rows,
// a teammate's press, changes to the shop, designs from their AI, alerts.
//
// Callers: the agent loop (appActionTools), src/app/api/mcp/route.ts
// (propose_row_change, pending_changes), scripts/check-row-asks*.mjs.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { tool, type Tool } from "ai";
import { z } from "zod";
import { findSection } from "@/lib/section-ref";
import { designOf, readSectionRows, sectionsOf, type SectionRef } from "@/lib/section-read";
import { STORE_TABLES, canCarryOwnFields, isStoreTable, ownColumns, withOwnFields } from "@/lib/store-read";
import { coerce } from "@/lib/record-write";
import { actionNamed, actionOn, groupAsks, rowLabel, type AskRow } from "@/lib/row-approval";
import { fitForModel } from "@/lib/store-tools";
import type { SchemaColumn } from "@/lib/types";

/** The most rows one ask may change: a page of ticked rows, never a whole list by accident. */
export const ASK_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChangeAsk = {
  /** The section, as they call it. */
  section: string;
  /** Which rows: their ids (read_section gives them), every row whose field is value, or rows holding words. */
  ids?: string[];
  field?: string;
  value?: string | number | boolean;
  search?: string;
  /** What to do to each: fields set to values, or one of the section's own row buttons pressed. */
  set?: Record<string, unknown>;
  button?: string;
};

export type ChangeAsked =
  | { error: string; sections?: string[]; buttons?: string[]; fields?: string[] }
  | {
      waiting: true;
      /** The card's sentence, written here from the change, never by the asker. */
      summary: string;
      rows: number;
      already_waiting: number;
      /** Rows the button does not show on, or already holding the values. */
      left_alone: number;
      batch: string;
      where: string;
    };

const shown = (v: unknown) => (v === null || v === "" || v === undefined ? "empty" : `“${String(v).slice(0, 40)}”`);
const same = (a: unknown, b: unknown) => String(a ?? "").trim() === String(b ?? "").trim();

/** The sentence an ask is shown by: what changes, on how many rows, where. */
export function summaryOf(
  section: string,
  rows: number,
  change: { set: Record<string, unknown>; columns: SchemaColumn[] } | { button: string }
): string {
  const where = `${rows} ${rows === 1 ? "row" : "rows"} of ${section}`;
  if ("button" in change) return `Press “${change.button}” on ${where}`.slice(0, 300);
  const parts = Object.entries(change.set).map(
    ([f, v]) => `“${change.columns.find((c) => c.field === f)?.label ?? f}” to ${shown(v)}`
  );
  const said = parts.length > 3 ? `${parts.slice(0, 3).join(", ")} and ${parts.length - 3} more` : parts.join(", ");
  return `Set ${said} on ${where}`.slice(0, 300);
}

/**
 * The fields an ask sets, held to what a person may type into this
 * section: its own fields (never the store's, never one worked out on
 * reading), each value as the column keeps it. An error names what is not.
 */
export function checkSet(
  set: Record<string, unknown>,
  columns: SchemaColumn[],
  writable: SchemaColumn[]
): { set: Record<string, unknown> } | { error: string } {
  const out: Record<string, unknown> = {};
  const fields = Object.keys(set);
  if (!fields.length) return { error: "Nothing to set: name a field and its value." };
  if (fields.length > 20) return { error: "At most 20 fields at once." };
  for (const f of fields) {
    const col = writable.find((c) => c.field === f);
    if (!col) {
      const known = columns.find((c) => c.field === f);
      if (known?.compute) return { error: `"${known.label}" is worked out from other fields; set those instead.` };
      if (known)
        return {
          error: `"${known.label}" is the store's own field. It changes in Shopify: ask for a store change (propose_store_action) where one exists.`,
        };
      return { error: `This section has no field "${f}". Its fields: ${writable.map((c) => c.field).join(", ")}.` };
    }
    if (col.compute) return { error: `"${col.label}" is worked out from other fields; set those instead.` };
    const v = coerce(col, set[f]);
    if (
      (col.type === "number" || col.type === "currency" || col.type === "percent") &&
      v !== "" &&
      typeof v !== "number"
    )
      return { error: `"${col.label}" holds a number, not ${shown(set[f])}.` };
    if (col.type === "date" && v !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(v)))
      return { error: `"${col.label}" holds a date as YYYY-MM-DD, not ${shown(set[f])}.` };
    out[f] = v;
  }
  return { set: out };
}

type Row = { id: string; data: Record<string, unknown> };

/** The rows an ask names, as they stand now: the store's fields under theirs on a list over the store. */
async function rowsFor(
  db: SupabaseClient,
  projectId: string,
  section: SectionRef,
  columns: SchemaColumn[],
  ask: ChangeAsk
): Promise<Row[] | { error: string }> {
  const ids = Array.isArray(ask.ids) ? [...new Set(ask.ids.map(String))] : [];
  if (ids.length) {
    if (ids.length > ASK_MAX) return { error: `At most ${ASK_MAX} rows at once.` };
    if (!ids.every((id) => UUID.test(id))) return { error: "ids are the row ids read_section gives." };
    if (isStoreTable(section.source_table)) {
      const spec = STORE_TABLES[section.source_table];
      const { data } = await db.from(spec.view).select(spec.select).in("id", ids);
      const theirs = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
        id: String(r.id),
        data: r,
      }));
      return withOwnFields(db, section.id, theirs);
    }
    const { data } = await db
      .from("records")
      .select("id, data")
      .eq("module_id", section.id)
      .is("store_row_id", null)
      .in("id", ids);
    return (data ?? []).map((r) => ({ id: r.id as string, data: (r.data ?? {}) as Record<string, unknown> }));
  }
  if (ask.field === undefined && ask.search === undefined)
    return { error: "Which rows: ids from read_section, a field and its value, or words to look for." };
  const read = await readSectionRows(
    db,
    projectId,
    section,
    columns,
    { field: ask.field, value: ask.value, search: ask.search, limit: ASK_MAX },
    null,
    ASK_MAX
  );
  if ("error" in read) return read;
  if (read.total > ASK_MAX)
    return { error: `That is ${read.total} rows; an ask changes at most ${ASK_MAX}. Narrow it.` };
  return read.rows.map((r) => {
    const { id, ...data } = r;
    return { id: String(id), data };
  });
}

/**
 * Asks the owner to change rows of one section: fields set to values, or
 * one of the section's buttons pressed, on the rows named. The ask waits
 * in the owner's bell; nothing changes until they say yes.
 */
export async function proposeRowChange(db: SupabaseClient, projectId: string, ask: ChangeAsk): Promise<ChangeAsked> {
  const sections = await sectionsOf(db, projectId);
  const wanted = typeof ask.section === "string" ? ask.section.trim() : "";
  const section =
    (wanted && findSection(sections, wanted)) ||
    sections.find((s) => wanted && s.nav_label.toLowerCase().includes(wanted.toLowerCase()));
  if (!section) return { error: `No section called "${wanted}".`, sections: sections.map((s) => s.nav_label) };
  const hasSet = ask.set && typeof ask.set === "object" && Object.keys(ask.set).length > 0;
  const button = typeof ask.button === "string" && ask.button.trim() ? ask.button.trim() : null;
  if (!!hasSet === !!button)
    return { error: "Say what to do: set (fields and values) or button (its label), one of them." };

  const table = isStoreTable(section.source_table) ? section.source_table : null;
  if (section.source_table && !table) return { error: `"${section.nav_label}" has no rows to change.` };
  if (table && !canCarryOwnFields(table))
    return { error: `The rows of "${section.nav_label}" cannot hold fields of their own; they change in Shopify.` };
  const { columns, features } = await designOf(db, section);
  const writable = (table ? ownColumns(table, columns) : columns).filter((c) => !c.compute);

  let action: ReturnType<typeof actionNamed> = null;
  let set: Record<string, unknown> = {};
  if (button) {
    action = actionNamed(features, button);
    if (!action)
      return {
        error: `"${section.nav_label}" has no “${button}” button.`,
        buttons: (features?.actions ?? []).map((a) => a.label),
      };
  } else {
    const checked = checkSet(ask.set!, columns, writable);
    if ("error" in checked) return checked;
    set = checked.set;
  }

  const found = await rowsFor(db, projectId, section, columns, ask);
  if ("error" in found) return found;
  if (!found.length) return { error: "No row matches that, so nothing was asked." };

  const asks: Array<Record<string, unknown>> = [];
  let leftAlone = 0;
  for (const r of found) {
    const now = action ? actionOn(action, columns, r.data) : set;
    if (!now || Object.entries(now).every(([f, v]) => same(r.data[f], v))) {
      leftAlone++;
      continue;
    }
    asks.push({
      ...(table ? { store_row_id: r.id } : { record_id: r.id }),
      set: now,
      before: Object.fromEntries(Object.keys(now).map((f) => [f, r.data[f] ?? null])),
      row_label: rowLabel(columns, r.data),
    });
  }
  if (!asks.length)
    return {
      error: action
        ? `“${action.label}” does not apply to any of those ${found.length} rows now.`
        : `All ${found.length} already hold those values; nothing to change.`,
    };

  const summary = summaryOf(section.nav_label, asks.length, action ? { button: action.label } : { set, columns });
  const { data, error } = await db.rpc("abo_ask_rows", {
    p_project: projectId,
    p_module: section.id,
    p_kind: action ? "button" : "change",
    p_action: action?.label ?? null,
    p_rows: asks,
    p_summary: summary,
  });
  if (error) return { error: error.message };
  const out = data as { batch: string; asked: number; already_waiting: number };
  return {
    waiting: true,
    summary,
    rows: out.asked,
    already_waiting: out.already_waiting,
    left_alone: leftAlone,
    batch: out.batch,
    where: "It waits in the bell in Warmluke; the owner approves it there, and nothing changes until they do.",
  };
}

/** Everything waiting on the owner in one app, as the bell shows it. */
export async function whatsWaiting(db: SupabaseClient, projectId: string) {
  const [asks, shop, designs, alerts, mods, followUps, checkIns] = await Promise.all([
    db
      .from("row_approvals")
      .select("id, module_id, kind, batch, action, row_label, summary, asked_via, asked_at")
      .eq("project_id", projectId)
      .eq("status", "waiting")
      .order("asked_at", { ascending: false })
      .limit(ASK_MAX),
    db
      .from("store_actions")
      .select("summary, status, created_at")
      .eq("project_id", projectId)
      .in("status", ["pending", "approved", "running"])
      .order("created_at", { ascending: false })
      .limit(20),
    db
      .from("build_requests")
      .select("summary, request, status, created_at")
      .eq("project_id", projectId)
      .in("status", ["pending", "building", "partly_built"])
      .order("created_at", { ascending: false })
      .limit(20),
    db
      .from("alerts")
      .select("subject, severity, kind, opened_at")
      .eq("project_id", projectId)
      .eq("status", "open")
      .order("opened_at", { ascending: false })
      .limit(20),
    db.from("modules").select("id, nav_label").eq("project_id", projectId),
    db.rpc("abo_follow_ups", { p_project: projectId }),
    db.rpc("abo_problem_check_ins", { p_project: projectId }),
  ]);
  const name = new Map((mods.data ?? []).map((m) => [m.id as string, m.nav_label as string]));
  const rowAsks = groupAsks((asks.data ?? []) as AskRow[]);
  return {
    asks_to_change_rows: rowAsks.slice(0, 20).map((a) => ({
      what: a.what,
      section: name.get(a.module_id) ?? null,
      rows: a.rows,
      asked_by: a.asked_by,
      asked_at: a.asked_at,
    })),
    changes_to_the_shop: (shop.data ?? []).map((s) => ({
      what: s.summary,
      state: s.status === "pending" ? "waiting for their yes" : s.status,
      asked_at: s.created_at,
    })),
    designs_from_their_ai: (designs.data ?? []).map((d) => ({
      what: d.summary ?? d.request,
      state: d.status === "pending" ? "waiting for their yes" : d.status,
      asked_at: d.created_at,
    })),
    alerts_open: (alerts.data ?? []).map((a) => ({ what: a.subject, severity: a.severity, since: a.opened_at })),
    // The bell's own questions: a build nobody has used (0190), a problem a week after its fix (0201).
    questions_for_the_owner: [
      ...((followUps.data ?? []) as Array<{ sections: string[]; built_at: string }>).map((f) => ({
        asks: `Did what was built in ${f.sections.join(", ")} work for them?`,
        since: f.built_at,
      })),
      ...((checkIns.data ?? []) as Array<{ problem: string; built_at: string }>).map((c) => ({
        asks: `Is “${c.problem}” better since it was built for?`,
        since: c.built_at,
      })),
    ],
    note: "Only the owner approves, in Warmluke: you can say what waits and what it would do, never approve it.",
  };
}

type Heard = { tool: string; about: string; args: unknown; result?: unknown };

/**
 * The agent loop's hands in the app: asking to change rows, and reading
 * what waits on the owner. Bound to one caller's client (RLS decides) and
 * one project. `proposed` hears an ask once it is made, as the chat shows
 * a store change asked for.
 */
/** What Luke is told of changing values in their rows, beside the tools that do it. */
export const CHANGE_ROWS = `CHANGING VALUES IN THEIR ROWS. When they ask for values in rows to change, read the rows with read_section (each row's id), then ask with change_rows; it waits in their bell for one click, so say so. Never tell them to edit it themselves, never build a rule or a section to change values once, and never set a store field this way (that is propose_store_action). Before you say anything is or is not waiting for them, read whats_waiting.`;

export function appActionTools(
  ctx: { db: SupabaseClient; projectId: string },
  hear?: { observe?: (h: Heard) => void; proposed?: (summary: string) => void }
): Record<string, Tool> {
  const told = (name: string, about: string, args: unknown, result: unknown) => {
    try {
      hear?.observe?.({ tool: name, about, args, result });
    } catch {
      // A listener that throws does not take the call with it.
    }
    return fitForModel(result);
  };
  return {
    change_rows: tool({
      description:
        "Ask the owner to change rows in one of their sections: fields set to values, or one of the section's own row buttons pressed. Name the rows by the ids read_section gives, or every row whose field is a value, or rows holding words (at most 500). Only fields of their own can be set, never the store's (a store change is propose_store_action). It waits in their bell with the sentence Warmluke writes from the change; nothing changes until they approve. Use it whenever they ask for values in rows to change; never ask them to type it themselves, and never build a rule or a section to change values once.",
      inputSchema: z.object({
        section: z.string().describe("The section's name, as they call it."),
        ids: z.array(z.string()).max(ASK_MAX).optional().describe("Row ids from read_section."),
        field: z.string().optional().describe("Change every row whose field is exactly value."),
        value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        search: z.string().optional().describe("Change rows holding these words."),
        set: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe("Field → new value. Empty string or null clears it."),
        button: z.string().optional().describe("One of the section's row buttons, by its label."),
      }),
      execute: async (args) => {
        const out = await proposeRowChange(ctx.db, ctx.projectId, args as ChangeAsk);
        if ("waiting" in out) {
          try {
            hear?.proposed?.(out.summary);
          } catch {
            // As above.
          }
        }
        return told("change_rows", "waiting" in out ? out.summary : `a change to ${args.section}`, args, out);
      },
    }),
    whats_waiting: tool({
      description:
        "What waits on the owner in this app right now: asks to change rows (from Luke, their own AI or a teammate), changes to their shop, designs from their own AI, open alerts, and the bell's questions for them. Read this before saying anything is or is not waiting; never ask them to look at the bell for you.",
      inputSchema: z.object({}),
      execute: async () => told("whats_waiting", "what waits on you", {}, await whatsWaiting(ctx.db, ctx.projectId)),
    }),
  };
}
