// The screen hears about a change it did not make.
//
// This is the kind of thing that looks right in code and is silently
// dead in production: the tables have to be in the realtime
// publication, the socket has to be authenticated, and the filter has
// to match. None of that fails loudly — it just never fires, and the
// page keeps showing yesterday.
//
// So: subscribe the way the browser does, write a row the way a build
// does, and wait for the event.
//
//   OWNER_PASSWORD=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-live.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { OWNER_EMAIL } from "./owner-session.mjs";

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

const client = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
);
const { data: owner } = await client.auth.signInWithPassword({
  email: OWNER_EMAIL,
  password: process.env.OWNER_PASSWORD ?? "",
});
if (!owner?.session) {
  console.log("no OWNER_PASSWORD given — nothing to check");
  process.exit(0);
}
const { data: projects } = await client.from("projects").select("id").limit(1);
const projectId = projects?.[0]?.id;
if (!projectId) {
  console.log("no project on this account — nothing to check");
  process.exit(0);
}

/** Waits for one event on a table, or gives up. */
const heard = (table, filter, act, ms = 8000) =>
  new Promise((resolve) => {
    const ch = client
      .channel(`check-${table}-${Date.now()}`)
      .on("postgres_changes", { event: "*", schema: "public", table, filter }, () => {
        clearTimeout(timer);
        client.removeChannel(ch);
        resolve(true);
      });
    const timer = setTimeout(() => {
      client.removeChannel(ch);
      resolve(false);
    }, ms);
    // Only write once the socket says it is listening — a row written
    // before then is simply missed, and the check would blame the
    // publication for a race of its own making. SUBSCRIBED comes back
    // a moment before the server has the filter attached, which cost
    // this check its first event about one run in two, so give it
    // that moment. The app never notices: it subscribes on load and
    // the events it cares about are seconds or minutes later.
    ch.subscribe((status) => {
      if (status === "SUBSCRIBED") setTimeout(act, 400);
    });
  });

const stamp = Date.now().toString(36);
let moduleId = null;

try {
  console.log("a section built somewhere else");
  const sectionSeen = await heard("modules", `project_id=eq.${projectId}`, async () => {
    const { data } = await client
      .from("modules")
      .insert({
        project_id: projectId,
        name: `live-check-${stamp}`,
        nav_label: `Live Check ${stamp}`,
        icon: "table",
        route: `/modules/live-check-${stamp}`,
        sort_order: 999,
      })
      .select("id")
      .single();
    moduleId = data?.id ?? null;
  });
  check("reaches an open screen without a refresh", sectionSeen);

  if (moduleId) {
    console.log("\nand so does what goes inside it");
    check(
      "its columns",
      await heard("ui_schemas", `module_id=eq.${moduleId}`, async () => {
        await client.from("ui_schemas").insert({
          module_id: moduleId,
          schema_json: {
            columns: [{ field: "name", label: "Name", type: "text" }],
            features: null,
          },
          version: 1,
          created_by: "user",
          change_description: "live check",
        });
      })
    );
    check(
      "and its rows",
      await heard("records", `project_id=eq.${projectId}`, async () => {
        await client
          .from("records")
          .insert({ project_id: projectId, module_id: moduleId, data: {} });
      })
    );
  }

  console.log("\na request their own AI just made");
  check(
    "appears in the strip on its own",
    await heard("build_requests", `project_id=eq.${projectId}`, async () => {
      await client.rpc("abo_mcp_propose", {
        p_project: projectId,
        p_request: `live check ${stamp}`,
        p_plans: null,
        p_summary: null,
        p_unmet: null,
      });
    })
  );

  console.log("\nand a section taken away");
  if (moduleId) {
    check(
      "stops showing, which needs the old row in the event",
      await heard("modules", `project_id=eq.${projectId}`, async () => {
        await client.from("modules").delete().eq("id", moduleId);
      })
    );
    moduleId = null;
  }
} finally {
  if (moduleId) await client.from("modules").delete().eq("id", moduleId);
  await client.from("build_requests").delete().eq("request", `live check ${stamp}`);
  console.log("\ncleaned up");
}

console.log(fails.length === 0 ? "\nthe screen keeps up" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
