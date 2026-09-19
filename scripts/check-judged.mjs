// A design that settled is judged after the answer went out, and the
// verdict lands where only the owner can read it.
//
// The pure half (check-judge) proves what the judge is asked and what
// it does when there is no answer. This half proves the road: a
// design sent through the MCP tool, the response already returned,
// and a row in `judgements` some seconds later — written through a
// definer function, since nobody can write at that table. And that
// the owner can read it, and nobody can write it by hand.
//
// Needs the server on 3100 to hold TYPESAFE_API_KEY. Without it, the
// row never comes — and this says so and passes, because a missing
// key is the one condition the judge is built to do nothing under.
//
//   node scripts/check-judged.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
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
const show = (v) => console.log("     →", JSON.stringify(v).slice(0, 320));

const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const client = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
);
const owner = await signInAsCheckUser(client, env);
if (!owner.session) throw new Error(`no check user: ${owner.why}`);
const project = await throwawayProject(admin, owner.user.id, "judged");

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
      params: { name, arguments: { project_id: project.id, ...args } },
    }),
  });
  const j = await res.json();
  try {
    return JSON.parse(j.result.content[0].text);
  } catch {
    return j;
  }
};

/** The judgement for this project, once it lands. Null if it never does. */
const judged = async (waitMs) => {
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const { data } = await admin
      .from("judgements")
      .select("id, source, ref, request, built, unmet, removes, judge, model, ms")
      .eq("project_id", project.id)
      .limit(1)
      .maybeSingle();
    if (data) return data;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
};

const stamp = Date.now().toString(36);
let row = null;
try {
  console.log("a design through the tool, and the answer already back");
  const request = `A place to note who checked each parcel ${stamp}`;
  const made = await tool("submit_design", {
    request,
    plans: [
      {
        changeType: "NEW_MODULE",
        targetModuleId: null,
        newModule: { name: `judged-${stamp}`, nav_label: `Judged ${stamp}`, icon: "table" },
        newSchema: {
          columns: [
            { field: "parcel", label: "Parcel", type: "text" },
            { field: "checked_by", label: "Checked By", type: "text" },
          ],
          view: { type: "table" },
        },
        explanation: "Who checked what.",
      },
    ],
  });
  check("the design is waiting for approval, as before", made?.status === "waiting for approval" && !!made.request_id);
  if (made?.status !== "waiting for approval") show(made);

  row = await judged(20_000);
  if (!row && !env.TYPESAFE_API_KEY) {
    console.log("  skip  no TYPESAFE_API_KEY in this env, and no judgement came — which is the point of having no key");
  } else {
    check("and a judgement landed on its own", !!row);
    if (row) {
      check("naming the road and the request it judged", row.source === "mcp" && row.ref === made.request_id);
      check(
        "with a probability that the build does what was asked",
        typeof row.judge?.addresses === "number" && row.judge.addresses >= 0 && row.judge.addresses <= 1
      );
      check("nothing was left out, so nothing to say about that", Array.isArray(row.judge?.unmet) && row.judge.unmet.length === 0);
      check("shown the engine's own words for the build", /Judged/.test(row.built) && /Checked By/.test(row.built));
      check("and that nothing is removed", row.removes === false);
      check("which model, and how long", typeof row.model === "string" && row.model.startsWith("jev") && row.ms > 0);
      console.log(`     →  addresses ${row.judge.addresses.toFixed(2)} · ${row.model} · ${row.ms}ms`);
    }
  }

  console.log("\nwho can read it, who can write it");
  const { data: mine } = await client.from("judgements").select("id").eq("project_id", project.id);
  check("the owner reads their own", (mine ?? []).length === (row ? 1 : 0));
  const { error: refused } = await client.from("judgements").insert({
    project_id: project.id,
    source: "chat",
    request: "x",
    built: "x",
    judge: { addresses: 1, unmet: [] },
    model: "hand",
    ms: 0,
  });
  check("nobody writes at the table, not even the owner", !!refused);
  const { error: bad } = await client.rpc("abo_judge_note", {
    p_project: project.id,
    p_source: "email",
    p_ref: null,
    p_request: "x",
    p_built: "x",
    p_unmet: [],
    p_removes: false,
    p_judge: { addresses: 1, unmet: [] },
    p_model: "hand",
    p_ms: 0,
  });
  check("and the function refuses a road it does not know", !!bad && /Unknown source/.test(bad.message));
} finally {
  await project.remove();
  const { count } = await admin
    .from("judgements")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project.id);
  check("the project is gone, and its judgements with it", (count ?? 0) === 0);
}

console.log(fails.length === 0 ? "\nthe verdict lands, and only the owner reads it" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
