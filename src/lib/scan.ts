// What a scan matches (components/ScanBar.tsx): one place, so the bar and
// its check agree on what "the same code" is.

import { evalExpr, truthy } from "@/lib/expr";
import type { Expr, RecordRow } from "@/lib/types";

/** A code as scanned or typed: case, spaces and a leading "#" do not make it another code. */
export const sameCode = (a: unknown, b: unknown) => norm(a) !== "" && norm(a) === norm(b);
const norm = (v: unknown) =>
  String(v ?? "")
    .trim()
    .replace(/^#/, "")
    .toLowerCase();

/** The spellings a group's code may be kept under, for asking the database: #1304 and 1304 are one order. */
export const codeSpellings = (v: string) => {
  const bare = v.trim().replace(/^#/, "");
  return [...new Set([v.trim(), bare, `#${bare}`])].filter(Boolean);
};

/** The rows a scanned code names: by the lookup field, or any field it may also match. */
export const rowsFor = (rows: RecordRow[], code: string, fields: string[]) =>
  rows.filter((r) => fields.some((f) => sameCode(r.data?.[f], code)));

/** Whether every row of an open group is done. An empty group is not. */
export const groupDone = (rows: RecordRow[], done: Expr) =>
  rows.length > 0 && rows.every((r) => truthy(evalExpr(done, { ...r.data, id: r.id })));
