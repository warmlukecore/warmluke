// A column reads another row (0219): lookup and rollup, in the database.
//
// Blanks and the designs printed on them, two sections of the owner's own:
// each design reads its blank's count through its link (lookup), and each
// blank counts and adds up the designs linked to it (rollup). The stat cards
// count them over every row on the server; a design moved to another blank
// moves the numbers with no rule; the browser works out the same; and a
// section of another app reads blank, never its rows.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-lookup-rollup.mjs
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { withComputed } from "../src/lib/expr.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const show = (v) => console.log("     →", JSON.stringify(v).slice(0, 320));

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const client = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const me = await signInAsCheckUser(client, env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const project = await throwawayProject(admin, me.user.id, "lookup");
const other = await throwawayProject(admin, me.user.id, "lookup-other");
const stamp = Date.now().toString(36);
const must = ({ error, data }) => {
  if (error) throw new Error(error.message);
  return data;
};
const section = async (projectId, name, columns) => {
  const mod = must(
    await admin
      .from("modules")
      .insert({
        project_id: projectId,
        name: `${name}-${stamp}`,
        nav_label: `${name} ${stamp}`,
        icon: "table",
        route: `/modules/${name}-${stamp}`,
        sort_order: 1,
      })
      .select("id")
      .single()
  );
  must(
    await admin.from("ui_schemas").insert({
      module_id: mod.id,
      schema_json: { columns },
      version: 1,
      created_by: "user",
      change_description: "check",
    })
  );
  return mod.id;
};
const rows = async (moduleId, list) =>
  must(
    await admin
      .from("records")
      .insert(list.map((data) => ({ module_id: moduleId, data })))
      .select("id, data")
  );
const stats = async (moduleId, columns, list) => {
  const computed = columns.filter((c) => c.compute).map((c) => ({ field: c.field, expr: c.compute }));
  const { data, error } = await client.rpc("abo_section_stats", {
    p_module: moduleId,
    p_stats: list,
    p_scope: { computed },
  });
  if (error) throw new Error(error.message);
  return data;
};
const lookup = (link, field, at) => ({ op: "lookup", args: [{ field: link }, { const: field }, { const: at }] });
const rollup = (...a) => ({ op: "rollup", args: a.map((x) => ({ const: x })) });

try {
  // Two sections, the second linking to the first; each worked out from the other.
  const blankCols = [
    { field: "sku", label: "SKU", type: "text" },
    { field: "count", label: "Count", type: "number" },
  ];
  const blanks = await section(project.id, "blanks", blankCols);
  const designCols = [
    { field: "name", label: "Name", type: "text" },
    { field: "blank", label: "Blank", type: "link", linkTo: blanks },
    { field: "printed", label: "Printed", type: "number" },
    { field: "blank_count", label: "Blank stock", type: "number", compute: lookup("blank", "count", blanks) },
  ];
  const designs = await section(project.id, "designs", designCols);
  blankCols.push(
    { field: "on_it", label: "Designs", type: "number", compute: rollup(designs, "blank", "count") },
    { field: "printed", label: "Printed", type: "number", compute: rollup(designs, "blank", "sum", "printed") },
    { field: "least", label: "Fewest", type: "number", compute: rollup(designs, "blank", "min", "printed") }
  );
  must(
    await admin.from("ui_schemas").insert({
      module_id: blanks,
      schema_json: { columns: blankCols },
      version: 2,
      created_by: "user",
      change_description: "check",
    })
  );

  const [b1, b2, b3] = await rows(blanks, [
    { sku: "POX-1", count: 200 },
    { sku: "POX-2", count: 50 },
    { sku: "POX-3", count: 10 },
  ]);
  const ds = await rows(designs, [
    { name: "Cherry", blank: b1.id, printed: 2 },
    { name: "Mad Max", blank: b1.id, printed: "3" },
    { name: "Retro", blank: b1.id, printed: "" },
    { name: "Soda", blank: b2.id, printed: 1 },
    { name: "Loose", blank: "", printed: 9 },
  ]);

  console.log("\na design reads its blank's count");
  const d = await stats(designs, designCols, [
    { label: "Blank stock", op: "sum", value: { field: "blank_count" } },
    { label: "On a big blank", op: "count", where: { op: ">=", args: [{ field: "blank_count" }, { const: 100 }] } },
  ]);
  check("summed over every design, a design with no blank reading blank", Number(d?.[0]?.value) === 650);
  check("and a counter can ask of it", Number(d?.[1]?.value) === 3);
  if (fails.length) show(d);

  console.log("\na blank counts the designs on it");
  const blankStats = () =>
    stats(blanks, blankCols, [
      { label: "Designs", op: "sum", value: { field: "on_it" } },
      { label: "Printed", op: "sum", value: { field: "printed" } },
      { label: "Fewest", op: "max", value: { field: "least" } },
      { label: "With none", op: "count", where: { op: "=", args: [{ field: "on_it" }, { const: 0 }] } },
      { label: "By blank", op: "sum", value: { field: "on_it" }, by: "sku" },
    ]);
  const b = await blankStats();
  check("every design linked to one is counted", Number(b?.[0]?.value) === 4);
  check("and what they hold added up, the blank skipped", Number(b?.[1]?.value) === 6);
  check("the smallest is a number they hold", Number(b?.[2]?.value) === 2);
  check("a blank with none counts 0", Number(b?.[3]?.value) === 1);
  const byBlank = (s, sku) => Number(s?.[4]?.groups?.find((g) => g.key === sku)?.value);
  check("each blank its own", byBlank(b, "POX-1") === 3 && byBlank(b, "POX-2") === 1);
  if (fails.length) show(b);

  console.log("\nnever out of step: no rule copies it");
  must(
    await admin
      .from("records")
      .update({ data: { ...ds[3].data, blank: b1.id } })
      .eq("id", ds[3].id)
  );
  const moved = await blankStats();
  check(
    "a design moved to another blank moves its count",
    byBlank(moved, "POX-1") === 4 && byBlank(moved, "POX-2") === 0
  );
  const d2 = await stats(designs, designCols, [{ label: "Blank stock", op: "sum", value: { field: "blank_count" } }]);
  check("and reads its new blank's count", Number(d2?.[0]?.value) === 800);
  must(
    await admin
      .from("records")
      .update({ data: { sku: "POX-1", count: 210 } })
      .eq("id", b1.id)
  );
  const d3 = await stats(designs, designCols, [{ label: "Blank stock", op: "sum", value: { field: "blank_count" } }]);
  check("a blank's count changed shows on every design at once", Number(d3?.[0]?.value) === 840);

  console.log("\nthe browser works it out the same");
  const { data: bs } = await client.from("records").select("id, data").eq("module_id", blanks);
  const { data: dsNow } = await client.from("records").select("id, data").eq("module_id", designs);
  const byId = new Map((bs ?? []).map((r) => [r.id, r.data]));
  const ctx = (id) => ({
    id,
    row: (m, rid) => (m === blanks ? (byId.get(rid) ?? null) : null),
    children: (m, via, pid) =>
      m === designs ? (dsNow ?? []).filter((x) => x.data[via] === pid).map((x) => x.data) : [],
  });
  const shown = (dsNow ?? []).map((r) => withComputed(designCols, r.data, ctx(r.id)));
  check("each design's blank stock", shown.reduce((n, r) => n + Number(r.blank_count ?? 0), 0) === 840);
  const one = withComputed(blankCols, byId.get(b1.id), ctx(b1.id));
  const none = withComputed(blankCols, byId.get(b3.id), ctx(b3.id));
  check("each blank's designs", one.on_it === 4 && one.printed === 6 && one.least === 1);
  check("and a blank with none", none.on_it === 0 && none.printed === 0 && none.least === null);

  console.log("\nonly within the app");
  const theirCols = [
    { field: "ref", label: "Ref", type: "text" },
    { field: "peek", label: "Peek", type: "number", compute: lookup("ref", "count", blanks) },
    { field: "kids", label: "Kids", type: "number", compute: rollup(designs, "blank", "count") },
  ];
  const theirs = await section(other.id, "elsewhere", theirCols);
  const [stray] = await rows(theirs, [{ ref: b1.id }]);
  // A design of this app whose link holds the other app's row: counted, were the rollup not held to its app.
  await rows(designs, [{ name: "Stray", blank: stray.id, printed: 1 }]);
  const t = await stats(theirs, theirCols, [
    { label: "Peek", op: "count", where: { op: "is_set", args: [{ field: "peek" }] } },
    { label: "Kids", op: "count", where: { op: "is_set", args: [{ field: "kids" }] } },
  ]);
  check("a lookup into another app's section reads blank", Number(t?.[0]?.value) === 0);
  check("and so does a rollup over one", Number(t?.[1]?.value) === 0);
  if (fails.length) show(t);
} finally {
  await project.remove();
  await other.remove();
}

console.log(fails.length === 0 ? "\na column reads another row, and only its own app's" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
