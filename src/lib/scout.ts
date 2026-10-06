// Scout: the store as it is, read before Luke designs (6 Oct).
//
// Luke was told each store list in words and left to guess its field
// names; a wrong guess came back from the validator to be repaired, and
// was the commonest repair of the month. Their own AI, through
// design_format, was already given the names. Scout reads every list the
// app knows (STORE_TABLES) in one database call (abo_store_profile, 0189)
// and writes, per list with rows: the exact fields a design may name, how
// full each one is here, and the values it holds when they are few. Code,
// no model: it costs a database read and nothing else, and a list added to
// STORE_TABLES is scouted without a change here.
//
// Callers: src/lib/engine.ts (storeContextFor, every turn), src/lib/ai.ts
// (storeBlock prints it), src/app/api/mcp/route.ts (design_format).

import type { SupabaseClient } from "@supabase/supabase-js";
import { STORE_TABLES, storeTableSchema, type StoreTable } from "@/lib/store-read";

export type ColumnProfile = {
  /** jsonb's word for most of its values: string, number, boolean, empty… */
  type: string;
  /** Percent of the rows read that hold something; null when none were read. */
  filled: number | null;
  distinct: number;
  /** The values and how often each comes, when there are few that repeat; null otherwise. */
  values: Record<string, number> | null;
};
/** Per store view: how many rows were read, and each column as found. */
export type StoreProfile = Record<string, { sampled: number; columns: Record<string, ColumnProfile> }>;

/** Rows read per list: enough to say how full each field is and which values it holds. */
const SAMPLE = 2000;
/** Values printed for a field: as many as a filter offers (store-read MAX_CHOICES). */
const VALUES_SHOWN = 25;

const views = () => [...new Set(Object.values(STORE_TABLES).map((t) => t.view))];

/** Every list of the store, profiled; null when the database cannot yet (before 0189) or the read fails. */
export async function profileStore(db: SupabaseClient, storeId: string): Promise<StoreProfile | null> {
  const { data, error } = await db.rpc("abo_store_profile", { p_store: storeId, p_views: views(), p_sample: SAMPLE });
  if (error) {
    if (error.code !== "PGRST202") console.error(`scout: ${error.message}`);
    return null;
  }
  return (data ?? {}) as StoreProfile;
}

/** One field as the brief says it: its name and kind, how full it is when not always, its values when few. */
function fieldLine(field: string, type: string, p: ColumnProfile | undefined): string {
  if (!p || p.filled === 0) return `${field} ${type} (always empty here)`;
  const full = p.filled !== null && p.filled < 100 ? ` ${p.filled}% filled` : "";
  const vals = p.values
    ? ` {${Object.entries(p.values)
        .slice(0, VALUES_SHOWN)
        .map(([v, n]) => `${v} ${n.toLocaleString("en")}`)
        .join(" · ")}}`
    : "";
  return `${field} ${type}${full}${vals}`;
}

/**
 * The brief Luke reads: a line per list with rows (its key, how many rows,
 * then every field a design may name), and the lists that are empty here.
 * `counts` is the store's own count per list, which a sample stops short of.
 */
export function scoutLines(profile: StoreProfile, counts: Record<string, number> = {}): string[] {
  const lines: string[] = [];
  const empty: string[] = [];
  for (const [table, spec] of Object.entries(STORE_TABLES) as Array<[StoreTable, (typeof STORE_TABLES)[StoreTable]]>) {
    const read = profile[spec.view];
    if (!read || read.sampled === 0) {
      empty.push(table);
      continue;
    }
    const total = counts[table] ?? read.sampled;
    const size = total > read.sampled ? `${total.toLocaleString("en")} rows, ${read.sampled} read` : `${total} rows`;
    const fields = storeTableSchema(table).columns.map((c) => fieldLine(c.field, c.type, read.columns[c.field]));
    lines.push(`  ${table} (${size}): ${fields.join(" · ")}`);
  }
  if (empty.length) lines.push(`  Empty in this store: ${empty.join(", ")}.`);
  return lines;
}

/** How many lists and fields a profile covers, for the turn's step. */
export function scoutSize(profile: StoreProfile): { lists: number; fields: number } {
  const read = Object.values(profile).filter((v) => v.sampled > 0);
  return { lists: read.length, fields: read.reduce((n, v) => n + Object.keys(v.columns).length, 0) };
}
