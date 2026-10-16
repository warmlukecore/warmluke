// Luke and their own AI ask to change rows; the owner says yes (0208,
// lib/app-actions.ts, app/api/row-action), with real people on the check
// project. An ask names fields of the section's own and is refused on
// one that is not, on a number that is not one, and past 500 rows; it
// waits as one card with the server's own sentence and what each row
// held. A stranger cannot ask, a teammate can ask but not decide. The
// owner's yes changes every row still as it was asked about, and leaves
// one changed since; a button pressed by ask is worked out again on the
// yes; a no changes nothing. What waits is read back as the bell shows it.
//
//   ENV_FILE=.env.check.local APP_URL=http://localhost:3101 \
//     node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-row-asks.mjs
//
// Never with CI running: one check database.

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { proposeRowChange, whatsWaiting } from "../src/lib/app-actions.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log("not a check project: this makes accounts and rows of its own, so it runs only there");
  process.exit(0);
}
const BASE = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const APP = process.env.APP_URL ?? "http://localhost:3100";
const admin = createClient(BASE, env.ADAPTIVE_OS_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const stamp = Date.now();
async function person(tag) {
  const email = `asks-${tag}-${stamp}@warmluke.test`;
  const password = `pw_${stamp}_aA1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (!data.user) throw new Error(`could not create ${tag}: ${error?.message}`);
  const c = createClient(BASE, ANON, { auth: { persistSession: false } });
  const { data: s, error: e } = await c.auth.signInWithPassword({ email, password });
  if (e) throw new Error(`could not sign in ${tag}: ${e.message}`);
  return { id: data.user.id, db: c, jwt: s.session.access_token };
}
const decide = async (who, body) => {
  const res = await fetch(`${APP}/api/row-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${who.jwt}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const owner = await person("owner");
const staff = await person("staff");
const stranger = await person("stranger");
let projectId = null;
try {
  const { data: proj } = await owner.db
    .from("projects")
    .insert({ owner_id: owner.id, name: `asks ${stamp}` })
    .select("id")
    .single();
  projectId = proj.id;
  const { data: mod } = await owner.db
    .from("modules")
    .insert({
      project_id: proj.id,
      name: `stock_${stamp}`,
      nav_label: "Blanks",
      route: `/blanks_${stamp}`,
      shared_with_team: true,
    })
    .select("id")
    .single();
  await admin.from("ui_schemas").insert({
    module_id: mod.id,
    version: 1,
    created_by: "ai",
    schema_json: {
      columns: [
        { field: "sku", label: "SKU", type: "text" },
        { field: "status", label: "Status", type: "badge" },
        { field: "qty", label: "Quantity", type: "number" },
        {
          field: "double",
          label: "Double",
          type: "number",
          compute: { op: "*", args: [{ field: "qty" }, { const: 2 }] },
        },
      ],
      features: {
        actions: [
          {
            label: "Mark counted",
            set: { status: { const: "Counted" } },
            when: { op: "!=", args: [{ field: "status" }, { const: "Counted" }] },
          },
        ],
      },
    },
  });
  const { data: seat } = await owner.db
    .from("project_members")
    .insert({ project_id: proj.id })
    .select("token")
    .single();
  await staff.db.rpc("abo_join", { p_token: seat.token });
  const { data: rows } = await owner.db
    .from("records")
    .insert(
      ["POX-A", "POX-B", "POX-C"].map((sku, i) => ({
        project_id: proj.id,
        module_id: mod.id,
        data: { sku, status: "Open", qty: 10 + i },
      }))
    )
    .select("id, data");
  const id = (sku) => rows.find((r) => r.data.sku === sku).id;

  console.log("\nan ask is held to what a person may type");
  const unknown = await proposeRowChange(owner.db, proj.id, {
    section: "Blanks",
    ids: [id("POX-A")],
    set: { colour: "red" },
  });
  check(
    "a field the section does not have is refused, naming its fields",
    /no field "colour"/.test(unknown.error ?? "")
  );
  const worked = await proposeRowChange(owner.db, proj.id, {
    section: "Blanks",
    ids: [id("POX-A")],
    set: { double: 4 },
  });
  check("one worked out from others is refused", /worked out/.test(worked.error ?? ""));
  const word = await proposeRowChange(owner.db, proj.id, {
    section: "Blanks",
    ids: [id("POX-A")],
    set: { qty: "lots" },
  });
  check("and a number that is not one", /holds a number/.test(word.error ?? ""));
  const both = await proposeRowChange(owner.db, proj.id, {
    section: "Blanks",
    ids: [id("POX-A")],
    set: { qty: 1 },
    button: "Mark counted",
  });
  check("set and button together is one too many", /one of them/.test(both.error ?? ""));
  const many = await proposeRowChange(owner.db, proj.id, {
    section: "Blanks",
    ids: Array.from({ length: 501 }, () => crypto.randomUUID()),
    set: { qty: 1 },
  });
  check("past 500 rows is refused", /At most 500/.test(many.error ?? ""));
  const same = await proposeRowChange(owner.db, proj.id, {
    section: "Blanks",
    field: "sku",
    value: "POX-A",
    set: { qty: 10 },
  });
  check("a row already holding the value is not asked about", /already hold/.test(same.error ?? ""));

  console.log("\nwho may ask");
  const theirs = await proposeRowChange(stranger.db, proj.id, {
    section: "Blanks",
    ids: [id("POX-A")],
    set: { qty: 1 },
  });
  check("a stranger finds no such section", /No section/.test(theirs.error ?? ""));
  const straight = await stranger.db.rpc("abo_ask_rows", {
    p_project: proj.id,
    p_module: mod.id,
    p_kind: "change",
    p_action: null,
    p_rows: [{ record_id: id("POX-A"), set: { qty: 1 } }],
    p_summary: "x",
  });
  check("nor through the database straight", straight.error?.code === "42501");
  const byStaff = await proposeRowChange(staff.db, proj.id, {
    section: "Blanks",
    field: "sku",
    value: "POX-C",
    set: { qty: 99 },
  });
  check("a teammate can ask", byStaff.waiting === true && byStaff.rows === 1);

  console.log("\nan ask waits as one card");
  const asked = await proposeRowChange(owner.db, proj.id, {
    section: "Blanks",
    search: "POX",
    set: { status: "Low", qty: 5 },
  });
  check("three rows, one ask", asked.waiting === true && asked.rows === 3);
  check(
    "in the server's sentence, naming the fields by their labels",
    asked.summary === "Set “Status” to “Low”, “Quantity” to “5” on 3 rows of Blanks"
  );
  const { data: kept } = await admin.from("row_approvals").select("*").eq("batch", asked.batch);
  check(
    "each row kept with what it held",
    kept?.length === 3 && kept.every((r) => r.kind === "change" && r.before?.status === "Open")
  );
  check(
    "and said to come from Luke",
    kept?.every((r) => r.asked_via === "luke")
  );
  const waiting = await whatsWaiting(owner.db, proj.id);
  const card = waiting.asks_to_change_rows.find((a) => a.what === asked.summary);
  check("what waits reads it back as one", card?.rows === 3 && card?.section === "Blanks" && card?.asked_by === "Luke");
  // The Overview's brief, for Luke and their own AI too (lib/brief): a build today and its check.
  const { data: thread } = await admin
    .from("conversations")
    .insert({ project_id: proj.id, title: "Reorder list" })
    .select("id")
    .single();
  await admin.from("messages").insert({
    conversation_id: thread.id,
    role: "assistant",
    content: "Built 1 change.",
    payload: { type: "build", status: "built", sent: [0], tested: { ok: false, said: "", problems: [] } },
  });
  const brief = await whatsWaiting(owner.db, proj.id);
  check(
    "a build today is read back under the owner's own rights, with its check",
    brief.built_today.length === 1 &&
      brief.built_today[0].what === "Reorder list" &&
      brief.built_today[0].check === "failed"
  );

  console.log("\nthe owner's yes");
  const blocked = await decide(staff, { projectId: proj.id, batch: asked.batch, decision: "approve" });
  check("a teammate cannot decide", blocked.status === 403);
  // Someone changes POX-B before the yes: that row is left as it now is.
  await owner.db
    .from("records")
    .update({ data: { sku: "POX-B", status: "Sold out", qty: 11 } })
    .eq("id", id("POX-B"));
  const yes = await decide(owner, { projectId: proj.id, batch: asked.batch, decision: "approve" });
  check("the owner's yes goes through", yes.status === 200);
  check("two rows changed, the one changed since left alone", yes.json.done === 2 && yes.json.stale === 1);
  if (yes.status !== 200 || yes.json.done !== 2) console.log("     →", JSON.stringify(yes.json).slice(0, 300));
  const { data: after } = await owner.db.from("records").select("data").eq("module_id", mod.id);
  const by = (sku) => after.find((r) => r.data.sku === sku)?.data;
  check("as asked", by("POX-A")?.status === "Low" && Number(by("POX-A")?.qty) === 5);
  check("and the one that moved on kept its own", by("POX-B")?.status === "Sold out");

  console.log("\na button, and a no");
  const press = await proposeRowChange(owner.db, proj.id, {
    section: "Blanks",
    field: "sku",
    value: "POX-B",
    button: "Mark counted",
  });
  check(
    "a button is asked for by its label",
    press.waiting === true && press.summary === "Press “Mark counted” on 1 row of Blanks"
  );
  const pressed = await decide(owner, { projectId: proj.id, batch: press.batch, decision: "approve" });
  const { data: b } = await owner.db.from("records").select("data").eq("id", id("POX-B")).single();
  check("and done on the yes", pressed.json.done === 1 && b.data.status === "Counted");
  const no = await decide(owner, { projectId: proj.id, batch: byStaff.batch, decision: "decline" });
  const { data: c } = await owner.db.from("records").select("data").eq("id", id("POX-C")).single();
  // POX-C took 5 from the yes above; the teammate's 99 never lands.
  check("a no changes nothing", no.json.declined === 1 && Number(c.data.qty) === 5);
  if (no.json.declined !== 1 || Number(c.data.qty) !== 5) console.log("     →", JSON.stringify(no.json), c.data);
  const left = await whatsWaiting(owner.db, proj.id);
  check("and nothing waits after", left.asks_to_change_rows.length === 0);
} finally {
  if (projectId) await admin.from("projects").delete().eq("id", projectId);
  for (const p of [owner, staff, stranger]) await admin.auth.admin.deleteUser(p.id);
}

console.log(
  fails.length === 0 ? "\nan ask waits for the owner, and only their yes changes rows" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
