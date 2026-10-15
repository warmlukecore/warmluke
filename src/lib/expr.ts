// ─────────────────────────────────────────────────────────────
// Client-side twin of the Postgres evaluator in migration 0010.
// Row action guards and their field values are the same expression
// trees automations use, so a rule the assistant can write for the
// database it can also write for a button — one grammar, not two.
//
// Keep this in step with abo_eval: same operators, same coercion.
// ─────────────────────────────────────────────────────────────

import type { Expr, SchemaColumn } from "./types";

type Row = Record<string, unknown>;

function txt(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

function num(v: unknown): number {
  const n = Number(txt(v));
  return Number.isNaN(n) ? 0 : n;
}

export function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const t = txt(v).toLowerCase();
  return !["", "false", "0", "no"].includes(t);
}

/** Numbers first, then dates, then text — matching abo_cmp. */
function cmp(a: unknown, b: unknown): number {
  const ta = txt(a);
  const tb = txt(b);
  const na = Number(ta);
  const nb = Number(tb);
  if (ta !== "" && tb !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  const da = Date.parse(ta);
  const db = Date.parse(tb);
  if (!Number.isNaN(da) && !Number.isNaN(db)) {
    return da < db ? -1 : da > db ? 1 : 0;
  }
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

/**
 * Whose day "today" is: UTC's, as the database's when nothing is said,
 * or the shop's once the app knows it (AppShell, setTodayZone), as the
 * server's is since 0162. A rule saying "placed today" was a day behind
 * every night in Mumbai until half past five.
 * ponytail: one zone for the page, which shows one project at a time; a
 * server process leaves it at UTC, as code rules and checks expect.
 */
let todayZone = "UTC";
export function setTodayZone(zone: string | null | undefined): void {
  try {
    // Throws on a zone this browser cannot read, which keeps UTC.
    todayZone = zone ? new Intl.DateTimeFormat("en-CA", { timeZone: zone }).resolvedOptions().timeZone : "UTC";
  } catch {
    todayZone = "UTC";
  }
}

function isoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: todayZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * A row with its computed columns filled in.
 *
 * A computed column holds an expression rather than a value, so it has
 * to be worked out before anything looks at the row — filtering,
 * sorting, searching, stats and every view then treat it as an ordinary
 * field and none of them needs to know the difference.
 *
 * Evaluated in the order the columns are declared, so one computed
 * column may read another declared above it. A reference to one
 * declared below reads blank, which is why the validator refuses it.
 *
 * Returns the original object untouched when the section has no
 * computed columns, which is almost all of them.
 */
export function withComputed(columns: SchemaColumn[], data: Row, ctx?: ExprContext): Row {
  let out: Row | null = null;
  // A lookup that has not been through apply yet (a design's preview) names
  // only its link column; the column says where it points.
  const known = ctx && { ...ctx, linkTo: (f: string) => columns.find((c) => c.field === f)?.linkTo };
  for (const c of columns) {
    if (!c.compute) continue;
    if (!out) out = { ...data };
    out[c.field] = evalExpr(c.compute, out, {}, {}, known);
  }
  return out ?? data;
}

/**
 * The other rows a worked-out column may read (lookup, rollup; 0219): the
 * row a link points at, and the rows of a section whose link points here.
 * Absent, both read blank, as they do wherever those rows are not at hand.
 */
export type ExprContext = {
  /** This row's own id, which a child's link holds. */
  id?: string;
  /** A row of a section, by its id. */
  row?: (moduleId: string, id: string) => Row | null;
  /** The rows of a section whose `via` link holds this id; undefined while they are not read. */
  children?: (moduleId: string, via: string, id: string) => Row[] | undefined;
  /** Where a link column of this section points (filled in by withComputed). */
  linkTo?: (field: string) => string | undefined;
};

/** Does this expression read another row (lookup, rollup)? */
export function readsOtherRows(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as { op?: unknown; args?: unknown };
  if (n.op === "lookup" || n.op === "rollup") return true;
  return Array.isArray(n.args) && n.args.some(readsOtherRows);
}

const constOf = (a: unknown): string => txt((a as { const?: unknown } | undefined)?.const);

export function evalExpr(node: Expr | unknown, rec: Row, prev: Row = {}, target: Row = {}, ctx?: ExprContext): unknown {
  if (node === null || typeof node !== "object") return node;
  const n = node as Record<string, unknown>;

  if ("const" in n) return n.const;
  if ("field" in n) return rec[txt(n.field)];
  if ("was" in n) return prev[txt(n.was)];
  if ("target" in n) return target[txt(n.target)];

  const op = txt(n.op);
  const args = Array.isArray(n.args) ? n.args : [];
  const at = (i: number) => evalExpr(args[i] as Expr, rec, prev, target, ctx);

  switch (op) {
    case "today":
      return isoToday();
    case "now":
      return new Date().toISOString();

    case "and":
      return args.every((_, i) => truthy(at(i)));
    case "or":
      return args.some((_, i) => truthy(at(i)));
    case "not":
      return !truthy(at(0));
    // Only the taken branch is evaluated.
    case "if":
      return truthy(at(0)) ? at(1) : args.length > 2 ? at(2) : null;

    case "=":
      return cmp(at(0), at(1)) === 0;
    case "!=":
      return cmp(at(0), at(1)) !== 0;
    case ">":
      return cmp(at(0), at(1)) > 0;
    case ">=":
      return cmp(at(0), at(1)) >= 0;
    case "<":
      return cmp(at(0), at(1)) < 0;
    case "<=":
      return cmp(at(0), at(1)) <= 0;

    case "contains":
      return txt(at(0))
        .toLowerCase()
        .includes(txt(at(1)).toLowerCase());
    case "starts_with":
      return txt(at(0))
        .toLowerCase()
        .startsWith(txt(at(1)).toLowerCase());

    case "is_empty":
      return txt(at(0)) === "";
    case "is_set":
      return txt(at(0)) !== "";
    case "changed":
      return txt(at(0)) !== txt(prev[txt((args[0] as { field?: string })?.field)]);

    case "days_since": {
      const t = Date.parse(txt(at(0)));
      if (Number.isNaN(t)) return 0;
      return Math.floor((Date.parse(isoToday()) - t) / 86_400_000);
    }
    case "round":
      return Math.round(num(at(0)));

    case "+":
    case "-":
    case "*":
    case "/": {
      let acc = num(at(0));
      for (let i = 1; i < args.length; i++) {
        const b = num(at(i));
        if (op === "+") acc += b;
        else if (op === "-") acc -= b;
        else if (op === "*") acc *= b;
        else acc = b === 0 ? 0 : acc / b;
      }
      return acc;
    }
    case "concat":
      return args.map((_, i) => txt(at(i))).join("");

    // The row this row's link points at: lookup(link, field, [section]).
    case "lookup": {
      const id = txt(at(0));
      const link = txt((args[0] as { field?: unknown } | undefined)?.field);
      const to = constOf(args[2]) || ctx?.linkTo?.(link) || "";
      if (!id || !to || !ctx?.row) return null;
      return ctx.row(to, id)?.[constOf(args[1])] ?? null;
    }
    // The rows of a section whose link points here: rollup(section, via, how, [field]).
    // As abo_eval: a count or a sum of none is 0; the rest of none is blank.
    case "rollup": {
      const id = txt(ctx?.id ?? rec.id);
      const kids = id && ctx?.children ? ctx.children(constOf(args[0]), constOf(args[1]), id) : undefined;
      if (!kids) return null;
      const how = constOf(args[2]);
      if (how === "count") return kids.length;
      const field = constOf(args[3]);
      const nums = kids
        .map((k) => k[field])
        .filter((v) => txt(v) !== "" && !Number.isNaN(Number(txt(v))))
        .map(num);
      if (how === "sum") return nums.reduce((a, b) => a + b, 0);
      if (nums.length === 0) return null;
      if (how === "min") return Math.min(...nums);
      if (how === "max") return Math.max(...nums);
      return how === "avg" ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    }

    default:
      return null;
  }
}
