// Whether the thing designing your app can see what already runs in it.
//
// Rules were invisible to every designer we have. The chat box builds
// its turn from modules, schema and features; read_section claims to
// explain how a section works and returned fields and features and
// nothing else. So both would answer "no such rule exists" about a
// rule that fires on every row, or propose a second one beside it —
// and with auto-build on, build it without anyone looking.
//
// The rule text is the same text the approval card shows, because a
// designer and a merchant disagreeing about what a rule does is its
// own bug.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-rules-visible.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { describeRules } from "../src/lib/describe.ts";
import { buildUserMessage } from "../src/lib/ai.ts";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const APP = process.env.APP_URL ?? "http://localhost:3100";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);

// ── The words, before anything is wired up ──────────────────────
console.log("a rule, put into words");
{
  const modules = [{ id: "m1", nav_label: "Packing" }];
  const said = describeRules(
    [
      {
        id: "r1",
        name: "mark-seen",
        enabled: true,
        module_id: "m1",
        definition: {
          trigger: { type: "record_created" },
          actions: [{ type: "set_field", field: "note", value: "seen" }],
        },
      },
      {
        id: "r2",
        name: "old-one",
        enabled: false,
        module_id: null,
        definition: {
          trigger: { type: "schedule", every: "daily" },
          actions: [{ type: "set_field", field: "note", value: "checked" }],
        },
      },
    ],
    modules
  );
  check("it is named", said[0].includes("mark-seen"));
  check("and the section it runs on", said[0].includes("Packing"));
  check("and what makes it fire", /row is added/i.test(said[0]));
  // A rule that is switched off must not read as a rule that runs, or
  // the designer refuses to add the thing the merchant is asking for.
  check("a disabled one says so", /turned off/i.test(said[1]));
  check("and a live one does not", !/turned off/i.test(said[0]));
}

// ── The turn the model is actually given ────────────────────────
console.log("\nand the designer is handed them");
{
  const withRules = buildUserMessage("add a rule that marks rows seen", null, null, null, [
    "“mark-seen” on Packing — When a row is added; set Note to “seen”",
  ]);
  check("the rule appears in the turn", withRules.includes("mark-seen"));
  check("under a heading that says what it is", /rules already running/i.test(withRules));
  check("and it is told not to propose one twice", /already here/i.test(withRules));

  const without = buildUserMessage("add a rule", null, null, null, []);
  check("an app with no rules says none, not nothing", /none/.test(without));
}

// ── And through the door a connected assistant uses ─────────────
const { data: project } = await admin.from("projects").select("id").limit(1).single();
// A section of the app's own, not one over the store: a rule belongs
// to rows somebody keeps here. If this app has none, the check makes
// one rather than skipping the half it exists to prove.
const stamp = Date.now().toString(36);
let { data: section } = await admin
  .from("modules")
  .select("id, nav_label")
  .eq("project_id", project.id)
  .is("source_table", null)
  .limit(1)
  .maybeSingle();
let borrowedSection = null;
if (!section) {
  const { data: made } = await admin
    .from("modules")
    .insert({
      project_id: project.id,
      name: `rules-check-${stamp}`,
      nav_label: `Rules Check ${stamp}`,
      icon: "table",
      route: `/modules/rules-check-${stamp}`,
      sort_order: 999,
    })
    .select("id, nav_label")
    .single();
  section = made;
  borrowedSection = made?.id ?? null;
}

const client = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
);
const { data: owner } = await client.auth.signInWithPassword({
  email: "aaa@gmail.com",
  password: process.env.OWNER_PASSWORD ?? "",
});

if (!owner?.session) {
  console.log("\nno OWNER_PASSWORD given — read_section was not checked");
} else {
  const made = [];
  const tool = async (name, args) => {
    const res = await fetch(`${APP}/api/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${owner.session.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const j = await res.json();
    try {
      return JSON.parse(j.result.content[0].text);
    } catch {
      return j;
    }
  };

  try {
    const { data: onApp } = await admin
      .from("automations")
      .insert({
        project_id: project.id,
        module_id: null,
        name: `whole-app-${stamp}`,
        enabled: true,
        definition: {
          trigger: { type: "schedule", every: "daily" },
          actions: [{ type: "set_field", field: "note", value: "checked" }],
        },
      })
      .select("id")
      .single();
    made.push(onApp.id);

    console.log("\nread_section, with no section named");
    const listing = await tool("read_section", {});
    check("lists the sections as before", Array.isArray(listing?.sections));
    check(
      "and names what runs on the whole app",
      JSON.stringify(listing?.rules_on_the_whole_app ?? []).includes(`whole-app-${stamp}`)
    );

    {
      const { data: onSection } = await admin
        .from("automations")
        .insert({
          project_id: project.id,
          module_id: section.id,
          name: `on-section-${stamp}`,
          enabled: true,
          definition: {
            trigger: { type: "record_created" },
            actions: [{ type: "set_field", field: "note", value: "seen" }],
          },
        })
        .select("id")
        .single();
      made.push(onSection.id);

      console.log("\nand asked about one section");
      const detail = await tool("read_section", { section: section.nav_label });
      check("it still describes the fields", Array.isArray(detail?.fields));
      check(
        "and now the rule running on it",
        JSON.stringify(detail?.rules ?? "").includes(`on-section-${stamp}`)
      );
      // Someone else's rule is not this section's business.
      check(
        "not the one belonging to the whole app",
        !JSON.stringify(detail?.rules ?? "").includes(`whole-app-${stamp}`)
      );
    }
  } finally {
    for (const id of made) await admin.from("automations").delete().eq("id", id);
    if (borrowedSection) await admin.from("modules").delete().eq("id", borrowedSection);
    const { count } = await admin
      .from("automations")
      .select("id", { count: "exact", head: true })
      .like("name", `%${stamp}`);
    check("no rule this check made is left running", (count ?? 0) === 0);
    if (borrowedSection) {
      const { count: sections } = await admin
        .from("modules")
        .select("id", { count: "exact", head: true })
        .eq("id", borrowedSection);
      check("and the section it borrowed is gone", (sections ?? 0) === 0);
    }
  }
}

console.log(
  fails.length === 0 ? "\nthe designer can see what already runs" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
