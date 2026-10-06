// Luke working on the screen that is open (#3, 5 Oct): what he narrows,
// sorts, dates or fills in there, read from his reply against the
// section's own columns and filters. A field it does not have, or a
// choice its filter does not offer, is left out and said, never tried.
// Nothing here writes: a filled form waits for the merchant's Save.
//
// The same shape rides in a link (?show=) for the merchant's own AI,
// which cannot touch their screen (MCP show_on_screen), and is read
// again here when the link is opened: a link is anyone's words.
//
// Callers: lib/engine.ts (Luke's answer), app/api/mcp (the link),
// components/AppShell (the link opened). Pure.

import { filterKind, isYes, rangeText, readRange, YES_NO } from "./filters";
import { keptPick, NAMED, type PeriodPick } from "./period";
import type { FeatureSchema, SchemaColumn, UiSchema } from "./types";
import { filterIsOff } from "./view-edit";

/** What is done on a section's screen, as the app applies it. */
export interface ScreenAsk {
  /** The section, by id: the caller's, never the model's. */
  moduleId: string;
  search?: string;
  /** field -> the choice, as its filter offers it, or a range as the bar keeps it ("500..2000"). The whole view: a filter not named is cleared. */
  filters?: Record<string, string>;
  sort?: { field: string; dir: "asc" | "desc" };
  /** null is every date. */
  period?: PeriodPick;
  /** A new row's form, filled and left open for their Save. A link is the words of the row it points at. */
  add?: Record<string, string | number | boolean>;
}

/** An ask as kept on Luke's reply: what it does, in words, and what was left out. */
export type ScreenShown = ScreenAsk & { said: string; left?: string[] };

/** The section an ask is read against. */
export interface ScreenSection {
  id: string;
  name: string;
  schema: UiSchema | null;
  /** Rows can be added to it here: not a store list's, nor someone else's to read only. */
  canAdd: boolean;
}

const WORDS_MAX = 80;
const TEXT_MAX = 2000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const key = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase();
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const featuresOf = (s: UiSchema) => (s as UiSchema & { features?: FeatureSchema | null }).features ?? null;

/** A column named by its field or its label, as a model or a person names it. */
const columnBy = (cols: SchemaColumn[], name: unknown) =>
  cols.find((c) => key(c.field) === key(name)) ?? cols.find((c) => key(c.label) === key(name)) ?? null;

/** A value as the form's field holds it, or undefined when it cannot hold it. */
function valueFor(
  col: SchemaColumn,
  value: unknown,
  features: FeatureSchema | null
): string | number | boolean | undefined {
  if (value === null || value === undefined || value === "" || typeof value === "object") return undefined;
  const s = String(value).trim();
  switch (col.type) {
    case "number":
    case "currency":
    case "percent": {
      const n =
        typeof value === "number" ? value : Number(s.replace(/^(rs\.?|inr)\s*/i, "").replace(/[,\s₹$€£%]/g, ""));
      return Number.isFinite(n) && s !== "" ? n : undefined;
    }
    case "boolean":
      return isYes(value) ? true : ["no", "false", "0"].includes(key(value)) ? false : undefined;
    case "date":
      return DAY.test(s.slice(0, 10)) ? s.slice(0, 10) : undefined;
    case "time":
      return /^\d{1,2}:\d{2}$/.test(s) ? s.padStart(5, "0") : undefined;
    case "badge":
    case "dropdown": {
      // Only a choice it is set up with, when it is set up with some (RecordModal fixedOptions).
      const fixed = features?.filters?.find((f) => f.field === col.field)?.options ?? [];
      return fixed.length ? fixed.find((o) => key(o) === key(s)) : s.slice(0, WORDS_MAX);
    }
    case "link":
      return s.slice(0, WORDS_MAX);
    default:
      return s.slice(0, TEXT_MAX);
  }
}

/**
 * What a model or a link asked for on this section, held to what the
 * section has. `left` says, in words, each part that was not.
 */
export function readScreenAsk(raw: unknown, section: ScreenSection): { ask: ScreenAsk | null; left: string[] } {
  const left: string[] = [];
  if (!plain(raw) || !section.schema) return { ask: null, left };
  const cols = section.schema.columns ?? [];
  const features = featuresOf(section.schema);
  const ask: ScreenAsk = { moduleId: section.id };

  if (typeof raw.search === "string" && raw.search.trim()) ask.search = raw.search.trim().slice(0, WORDS_MAX);

  if (plain(raw.filters)) {
    // The bar's own filters (one taken off it with Customize is not there to set).
    const bar = (features?.filters ?? []).filter((f) => !filterIsOff(f));
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw.filters)) {
      const f = bar.find((x) => key(x.field) === key(name) || key(x.label) === key(name));
      if (!f) {
        left.push(`${section.name} has no ${name} filter`);
        continue;
      }
      // A number or an amount is a lowest and a highest: { "min", "max" }, or "500..2000" as the bar keeps it.
      if (filterKind(cols.find((c) => c.field === f.field)?.type) === "range") {
        const r = readRange(value);
        if (r) out[f.field] = rangeText(r);
        else if (value !== null && value !== undefined && value !== "")
          left.push(
            `${f.label} takes a lowest and a highest, not "${(typeof value === "string" ? value : JSON.stringify(value)).slice(0, 40)}"`
          );
        continue;
      }
      const given = typeof value === "boolean" ? (value ? "Yes" : "No") : String(value ?? "").trim();
      if (!given) continue;
      const yesNo = cols.find((c) => c.field === f.field)?.type === "boolean";
      const choices = yesNo ? YES_NO : (f.options ?? []);
      // A filter set up with no choices offers what its rows hold (a store list's facets): nothing to hold it to.
      const pick = yesNo
        ? isYes(given)
          ? "Yes"
          : ["no", "false"].includes(key(given))
            ? "No"
            : undefined
        : choices.length
          ? choices.find((o) => key(o) === key(given))
          : given.slice(0, WORDS_MAX);
      if (pick === undefined) {
        left.push(`${f.label} offers no "${given.slice(0, 40)}"`);
        continue;
      }
      out[f.field] = pick;
    }
    if (Object.keys(out).length) ask.filters = out;
  }

  if (plain(raw.sort)) {
    const col = columnBy(cols, raw.sort.field);
    if (!col) left.push(`${section.name} has no ${String(raw.sort.field ?? "such")} column to sort by`);
    else ask.sort = { field: col.field, dir: key(raw.sort.dir) === "desc" ? "desc" : "asc" };
  }

  if (raw.period !== undefined && raw.period !== null) {
    const spec = features?.period;
    const p = spec ? keptPick(JSON.stringify(raw.period), spec) : undefined;
    if (!spec) left.push(`${section.name} has no dates to pick`);
    else if (p === undefined) left.push(`its dates cannot be set to ${JSON.stringify(raw.period).slice(0, 60)}`);
    else ask.period = p;
  }

  if (plain(raw.add)) {
    if (!section.canAdd) left.push(`rows are not added to ${section.name} here`);
    else {
      const out: Record<string, string | number | boolean> = {};
      for (const [name, value] of Object.entries(raw.add)) {
        if (value === null || value === undefined || value === "") continue;
        const col = columnBy(cols, name);
        if (!col || col.compute) {
          left.push(col ? `${col.label} is worked out, not typed` : `${section.name} has no ${name} field`);
          continue;
        }
        const v = valueFor(col, value, features);
        if (v === undefined) {
          left.push(`${col.label} cannot hold "${String(value).slice(0, 40)}"`);
          continue;
        }
        out[col.field] = v;
      }
      if (Object.keys(out).length) ask.add = out;
    }
  }

  const any = ask.search || ask.filters || ask.sort || ask.period !== undefined || ask.add;
  return { ask: any ? ask : null, left };
}

/** What an ask does, as the merchant reads it under Luke's answer or their AI tells them. */
export function describeScreenAsk(ask: ScreenAsk, section: ScreenSection): string {
  const cols = section.schema?.columns ?? [];
  const labelOf = (f: string) => cols.find((c) => c.field === f)?.label ?? f;
  const parts: string[] = [];
  for (const [f, v] of Object.entries(ask.filters ?? {})) {
    const r = filterKind(cols.find((c) => c.field === f)?.type) === "range" ? readRange(v) : null;
    parts.push(
      `${labelOf(f)}: ${
        !r
          ? v
          : r.min === undefined
            ? `up to ${r.max}`
            : r.max === undefined
              ? `${r.min} or more`
              : `${r.min} to ${r.max}`
      }`
    );
  }
  if (ask.search) parts.push(`searched "${ask.search}"`);
  if (ask.period !== undefined) {
    const p = ask.period;
    parts.push(
      p === null
        ? "every date"
        : "days" in p
          ? `the last ${p.days} days`
          : "named" in p
            ? NAMED[p.named].toLowerCase()
            : `${p.from} to ${p.to}`
    );
  }
  if (ask.sort) {
    const type = cols.find((c) => c.field === ask.sort!.field)?.type;
    const desc = ask.sort.dir === "desc";
    const order =
      type === "date"
        ? desc
          ? "newest first"
          : "oldest first"
        : type === "number" || type === "currency" || type === "percent"
          ? desc
            ? "highest first"
            : "lowest first"
          : desc
            ? "Z to A"
            : "A to Z";
    parts.push(`${labelOf(ask.sort.field)}, ${order}`);
  }
  const shown = parts.length ? `${section.name}: ${parts.join(" · ")}` : "";
  const filled = ask.add ? `a new row in ${section.name}, ${Object.keys(ask.add).map(labelOf).join(", ")} filled` : "";
  return [shown, filled].filter(Boolean).join("; ");
}

/** The address that opens it: the section, and the ask read again when it opens. */
export function screenHref(projectId: string, ask: ScreenAsk): string {
  const { moduleId, ...rest } = ask;
  return `/app/${projectId}?section=${encodeURIComponent(moduleId)}&show=${encodeURIComponent(JSON.stringify(rest))}`;
}

/** An ask carried in an address, as given: read against the section with readScreenAsk before use. */
export function screenFromHref(show: string | null): unknown {
  if (!show || show.length > 4000) return null;
  try {
    return JSON.parse(show);
  } catch {
    return null;
  }
}
