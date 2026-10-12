// ─────────────────────────────────────────────────────────────
// A section's rows, read one way for Luke and for the owner's own AI
// (MCP read_section), 12 Oct.
//
// Luke could read the store's lists and nothing the merchant made: asked
// to check the row they had just added to Parent Stock, he said he could
// not see it, while their own Claude could through read_section
// (Carefone, 11 Oct). One reader now, for both. It asks the database for
// what it was asked, rather than reading a page and hoping the row is on
// it: words across the section's text fields, or one field equal to a
// value (theirs, or the store's), with how many match beside the rows.
//
// And what their rules did (lib/rule-runs): read the same way, so Luke
// looks before saying whether a rule worked, instead of asking the owner
// to check or to type a value again to make it run.
//
// Callers: src/lib/engine.ts (Luke's tools), src/app/api/mcp/route.ts
// (read_section's rows).
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { jsonSchema, tool, type Tool } from "ai";
import { findSection } from "@/lib/section-ref";
import { isStoreTable, readStoreRows, storeRowsMatching, storeSectionColumns, withOwnFields } from "@/lib/store-read";
import { fitForModel } from "@/lib/store-tools";
import { readRuleRuns } from "@/lib/rule-runs";
import type { FeatureSchema, SchemaColumn, UiSchema } from "@/lib/types";

export type SectionRef = { id: string; name: string; nav_label: string; source_table: string | null };
export type RowsAsk = { search?: unknown; field?: unknown; value?: unknown; limit?: unknown };
export type RowsRead = { total: number; showing: number; rows: Array<Record<string, unknown>>; note?: string };

/** Fields a word is looked for in: what holds words, never a number, a date or a tick. */
const WORDS = new Set(["text", "longtext", "badge", "dropdown", "phone", "email", "url", "barcode"]);
const FIELD = /^[a-z_][a-z0-9_]*$/i;
const word = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);

/**
 * A section's rows as asked: the newest, the ones holding `search` in a
 * text field, or the ones whose `field` is exactly `value`. Looked for in
 * the database, so a row is found wherever it sits in a list of thousands.
 * A field worked out on reading (compute) is not stored, so it cannot be
 * asked for; that is said, with what it reads.
 */
export async function readSectionRows(
  db: SupabaseClient,
  projectId: string,
  section: SectionRef,
  columns: SchemaColumn[],
  ask: RowsAsk,
  sort?: FeatureSchema["defaultSort"] | null,
  /** The most rows one read hands back: a model's page by default, more for a change's rows. */
  max = 200
): Promise<RowsRead | { error: string }> {
  const limit = Math.min(Math.max(Number(ask.limit ?? 50) || 50, 1), max);
  const search =
    word(ask.search)
      ?.replace(/[,()%*]/g, " ")
      .trim() || null;
  const field = word(ask.field);
  const value = ask.value === undefined || ask.value === null ? null : String(ask.value).trim();
  if (field) {
    if (!FIELD.test(field)) return { error: `"${field}" is not a field name.` };
    if (value === null) return { error: `Which value of "${field}"? Pass value.` };
    const col = columns.find((c) => c.field === field);
    if (col?.compute)
      return {
        error: `"${field}" is worked out when a row is read, so rows cannot be looked up by it. Ask by a field it reads instead.`,
      };
  }

  if (section.source_table) {
    if (!isStoreTable(section.source_table)) return { error: `"${section.nav_label}" has no rows to read.` };
    const { data: store } = await db
      .from("stores")
      .select("id")
      .eq("project_id", projectId)
      .in("status", ["connected", "uninstalled"])
      .maybeSingle();
    if (!store) return { error: "This app's store is not connected, so its rows cannot be read." };
    const table = section.source_table;
    if (field) {
      // A field of theirs or of the store's: storeRowsMatching knows which.
      const found = await storeRowsMatching(db, store.id as string, table, section.id, {
        field,
        values: [value!],
      });
      const hit = search
        ? found.filter((r) => JSON.stringify(r.data).toLowerCase().includes(search.toLowerCase()))
        : found;
      return {
        total: hit.length,
        showing: Math.min(hit.length, limit),
        rows: hit.slice(0, limit).map((r) => ({ ...r.data, id: r.id })),
        ...(hit.length >= 500 ? { note: "The first 500 that match; ask more narrowly for the rest." } : {}),
      };
    }
    const { rows, total } = await readStoreRows(
      db,
      store.id as string,
      table,
      limit,
      search ?? undefined,
      sort && typeof sort.field === "string" ? { field: sort.field, dir: sort.dir === "asc" ? "asc" : "desc" } : null
    );
    const laid = await withOwnFields(db, section.id, rows);
    return { total, showing: laid.length, rows: laid.map((r) => ({ ...r.data, id: r.id })) };
  }

  let q = db
    .from("records")
    .select("id, data", { count: "exact" })
    .eq("module_id", section.id)
    // Fields kept beside a store row are not rows of the section's own.
    .is("store_row_id", null);
  if (field) q = q.eq(`data->>${field}`, value!);
  if (search) {
    const fields = columns
      .filter((c) => !c.compute && WORDS.has(c.type) && FIELD.test(c.field))
      .map((c) => c.field)
      .slice(0, 20);
    if (!fields.length)
      return { error: `"${section.nav_label}" has no text fields to look for words in; ask by a field.` };
    q = q.or(fields.map((f) => `data->>${f}.ilike.%${search}%`).join(","));
  }
  const { data, count, error } = await q.order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []).map((r) => ({ ...((r.data ?? {}) as Record<string, unknown>), id: r.id as string }));
  return { total: count ?? rows.length, showing: rows.length, rows };
}

/** The app's sections, as the tools name them. */
export async function sectionsOf(db: SupabaseClient, projectId: string): Promise<SectionRef[]> {
  const { data, error } = await db
    .from("modules")
    .select("id, name, nav_label, source_table")
    .eq("project_id", projectId)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as SectionRef[];
}

/** One section's newest design: its columns as the account is shown them, and its features. */
export async function designOf(
  db: SupabaseClient,
  section: SectionRef
): Promise<{ columns: SchemaColumn[]; features: FeatureSchema | null }> {
  const { data } = await db
    .from("ui_schemas")
    .select("schema_json")
    .eq("module_id", section.id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const sj = (data?.schema_json ?? {}) as UiSchema & { features?: FeatureSchema | null };
  const columns = isStoreTable(section.source_table)
    ? storeSectionColumns(section.source_table, sj.columns)
    : (sj.columns ?? []);
  return { columns, features: sj.features ?? null };
}

/**
 * How a section got to be the way it is: every version, newest first.
 * Versions are appended and never rewritten, so a version put back shows
 * as a new one holding what the old one held. One reader for Luke and
 * for the owner's own AI (MCP read_section history).
 */
export async function sectionHistory(db: SupabaseClient, section: SectionRef, limit = 30) {
  const { data: versions } = await db
    .from("ui_schemas")
    .select("version, created_by, change_description, created_at, schema_json")
    .eq("module_id", section.id)
    .order("version", { ascending: false })
    .limit(limit);
  return {
    section: section.nav_label,
    versions: (versions ?? []).map((v) => ({
      version: v.version as number,
      on: v.created_at as string,
      by: v.created_by === "ai" ? "Warmluke" : "the merchant",
      what_changed: (v.change_description as string | null) ?? null,
      fields: ((v.schema_json as UiSchema | null)?.columns ?? []).map((c) => c.field),
    })),
  };
}

type Heard = { tool: string; about: string; args: unknown; result?: unknown };

/**
 * Luke's reads of the app itself: a section's rows, and what the rules
 * did. Bound to one caller's client (RLS decides what it sees) and one
 * project; heard as lookups, as the store's tools are.
 */
export function appTools(
  ctx: { db: SupabaseClient; projectId: string },
  observe?: (h: Heard) => void
): Record<string, Tool> {
  const heard = (name: string, about: string, args: unknown, result: unknown) => {
    try {
      observe?.({ tool: name, about, args, result });
    } catch {
      // A listener that throws does not take the lookup with it.
    }
    return fitForModel(result);
  };
  return {
    read_section: tool({
      description:
        "Read a section of their app. With no section: every section, and whether its rows are their own or the store's. With one: its fields and its rows, newest first, each with its id. Rows of a section they made, and the fields they keep beside the store's rows, are only here. search looks for words in its text fields; field and value keep only rows whose field is exactly that value (a field of theirs or of the store's). Says how many match beside the rows it shows. history: true gives how the section has changed instead, every version newest first.",
      inputSchema: jsonSchema<RowsAsk & { section?: unknown; history?: unknown }>({
        type: "object",
        properties: {
          section: { type: "string", description: "The section's name, as they call it. Leave it out to list them." },
          search: { type: "string", description: "Words to look for, a SKU, a name, a code." },
          field: { type: "string", description: "A field to match exactly, with value." },
          value: { type: "string", description: "The value that field must hold." },
          limit: { type: "number", description: "Up to 200. Defaults to 50." },
          history: { type: "boolean", description: "How this section has changed, instead of its rows." },
        },
      }),
      execute: async (args) => {
        const sections = await sectionsOf(ctx.db, ctx.projectId);
        const wanted = word(args.section);
        if (!wanted) {
          const result = {
            sections: sections.map((s) => ({
              section: s.nav_label,
              rows_from: s.source_table ? `the store's ${s.source_table}` : "this app",
            })),
          };
          return heard("read_section", "your sections", args, result);
        }
        const section =
          findSection(sections, wanted) ??
          sections.find((s) => s.nav_label.toLowerCase().includes(wanted.toLowerCase()));
        if (!section)
          return heard("read_section", `“${wanted}”`, args, {
            error: `No section called "${wanted}".`,
            sections: sections.map((s) => s.nav_label),
          });
        if (args.history === true)
          return heard("read_section", `how ${section.nav_label} changed`, args, await sectionHistory(ctx.db, section));
        const { columns, features } = await designOf(ctx.db, section);
        const read = await readSectionRows(ctx.db, ctx.projectId, section, columns, args, features?.defaultSort);
        const result = {
          section: section.nav_label,
          rows_from: section.source_table ? `the store's ${section.source_table}` : "this app",
          fields: columns.map((c) => ({ field: c.field, label: c.label, type: c.type })),
          ...read,
        };
        const what =
          word(args.search) ?? (word(args.field) ? `${word(args.field)} = ${String(args.value ?? "")}` : null);
        return heard("read_section", `${section.nav_label}${what ? ` matching “${what}”` : ""}`, args, result);
      },
    }),
    rule_runs: tool({
      description:
        "What their rules did the last times they ran: when, whether it went through, how many rows each section it reads gave it (and whether that was cut short), how many rows it wrote, and the error if any. Name a rule to see only it. Read this before saying whether a rule worked; never ask them to check.",
      inputSchema: jsonSchema<{ rule?: unknown; limit?: unknown }>({
        type: "object",
        properties: {
          rule: { type: "string", description: "The rule's name; leave it out for every rule." },
          limit: { type: "number", description: "Up to 50 runs. Defaults to 20." },
        },
      }),
      execute: async (args) => {
        const rule = word(args.rule) ?? undefined;
        const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 50);
        const runs = await readRuleRuns(ctx.db, ctx.projectId, { rule, limit });
        const result = runs.length
          ? { runs }
          : {
              runs: [],
              note: rule ? `“${rule}” has not run since runs were kept.` : "No rule has run since runs were kept.",
            };
        return heard("rule_runs", rule ? `what “${rule}” did` : "what your rules did", args, result);
      },
    }),
  };
}

/** What Luke is told when these tools are his: look first, never ask the owner to look for him. */
export const READ_THE_APP = `THEIR OWN SECTIONS AND RULES. The rows of a section they made, and the fields they keep beside the store's rows, are yours to read with read_section; what each rule did the last times it ran (when, how many rows it read and wrote, any error) with rule_runs. When they ask whether something is there, why a value is what it is, or whether a rule worked, look first and answer from what you find. Never ask them to check a row, a screen or a rule for you, and never ask them to type a value again to make a rule run: if a rule did not do its job, say what its runs show and what you would change.`;
