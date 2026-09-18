// Building without being asked, and refusing to.
//
// The switch is one boolean; the gate is the feature. What matters is
// that "yes, build things for me" does not quietly become "yes,
// rewrite the section my staff use every day" — so the refusals are
// checked, not just the happy path.
//
// The project's setting is put back at the end, and anything built
// here is removed.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-auto-build.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

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

const client = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
);
const owner = await signInAsCheckUser(client, env);
if (!owner.session) {
  console.log(`could not sign in as the owner — ${owner.why}`);
  process.exit(1);
}
const token = owner.session.access_token;
const admin = createClient(
  env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
  env.ADAPTIVE_OS_SERVICE_ROLE_KEY
);
// A project for this run only — the check user's, not the merchant's.
const project = await throwawayProject(admin, owner.user.id, "auto-build");

const setAuto = (on) => admin.from("projects").update({ auto_build: on }).eq("id", project.id);
const sectionCount = async () =>
  (
    await admin
      .from("modules")
      .select("*", { count: "exact", head: true })
      .eq("project_id", project.id)
  ).count;

/** Drives the tool the way an assistant does. */
const tool = async (name, args, id = 1) => {
  const res = await fetch(`${APP}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    // Always named: the check user owns more than one project whenever
    // two checks overlap or one crashed, and "which app?" is not the
    // answer under test.
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { project_id: project.id, ...args } } }),
  });
  const j = await res.json();
  try {
    return JSON.parse(j.result.content[0].text);
  } catch {
    return j;
  }
};

// Each design here is a real engine turn on a real key, so this check
// spends the account's included designs and then cannot run. Owned for the
// length of the run and handed back, like the setting above.
const turnsWas = (
  await admin
    .from("account_settings")
    .select("free_turns, turns_used")
    .eq("user_id", owner.user.id)
    .single()
).data;
if (turnsWas) {
  await admin
    .from("account_settings")
    .update({ free_turns: turnsWas.turns_used + 20 })
    .eq("user_id", owner.user.id);
}

const stamp = Date.now().toString(36);
const made = [];
// Rows this run causes to be built without asking. They count against
// the daily ceiling, so after a few runs the check stops being able to
// prove the thing it exists to prove — the same way it once left
// auto_build switched on. A check that leans on a number owns it.
const autoMade = [];
// Every request this run puts in the queue, so the cleanup can take
// exactly those back out again. Kept apart from `made`, which holds
// the modules it created — deleting one by the other's id is a silent
// no-op, which is the kind of cleanup that looks like it worked.
const madeRequests = [];
let aiThreadId = null;

try {
  console.log("with the setting off");
  await setAuto(false);
  const before = await sectionCount();
  const off = await tool("propose_change", {
    request: `Add a section called Off Check ${stamp} with a single text field for a note. Nothing else.`,
  });
  check("the design waits for approval", off.status === "waiting for approval");
  if (off.status !== "waiting for approval") console.log("     →", JSON.stringify(off).slice(0, 400));
  check("and nothing was built", (await sectionCount()) === before);
  if (off.request_id) madeRequests.push(off.request_id);

  console.log("\nwith it on, and an addition");
  await setAuto(true);
  const on = await tool(
    "propose_change",
    {
      request: `Add a section called On Check ${stamp} with a single text field for a note. Nothing else, no rules.`,
    },
    2
  );
  const built = on.status === "built" || on.status === "partly built";
  check("it is built there and then", built);
  if (!built) console.log("     →", JSON.stringify(on).slice(0, 300));
  check("and the assistant is told what was built", Array.isArray(on.built) && on.built.length > 0);
  for (const b of on.built ?? []) if (b.moduleId) made.push(b.moduleId);

  // Nobody tapped anything — that is what automatic means — so if the
  // server does not write this down, the app changes and the
  // merchant's history stays blank. It used to: the record was written
  // by the browser, which was never involved.
  {
    const { data: thread } = await admin
      .from("conversations")
      .select("id")
      .eq("project_id", project.id)
      .eq("title", "Changes from your AI")
      .maybeSingle();
    check("an automatic build is written to the AI's own thread", !!thread?.id);
    if (thread?.id) {
      aiThreadId = thread.id;
      const { data: msgs } = await admin
        .from("messages")
        .select("role, content")
        .eq("conversation_id", thread.id)
        .order("created_at");
      const asked = (msgs ?? []).find((m) => m.role === "user" && m.content?.includes(stamp));
      const said = (msgs ?? []).find((m) => m.role === "assistant" && m.content?.includes(stamp));
      check("with what was asked", !!asked);
      check("and what came of it", !!said);
      // Not Luke's thread. Nobody typed this into that box, and
      // dropping it into whatever discussion was open muddles both.
      //
      // Asked as "did THIS run leak into another thread", not "is this
      // the only thread" — a real account has the owner's own Luke
      // conversations sitting there, and the first version of this
      // check failed on them rather than on anything being wrong.
      const { data: others } = await admin
        .from("conversations")
        .select("id")
        .eq("project_id", project.id)
        .neq("id", thread.id);
      let leaked = 0;
      for (const o of others ?? []) {
        const { count } = await admin
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("conversation_id", o.id)
          .ilike("content", `%${stamp}%`);
        leaked += count ?? 0;
      }
      check("and nowhere else", leaked === 0);
    }
  }

  const row = (
    await admin
      .from("build_requests")
      .select("id, status, auto_built")
      .eq("project_id", project.id)
      .eq("auto_built", true)
      .order("built_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ).data;
  check("the row records that nobody approved it", row?.status === "built" && row.auto_built === true);
  if (row?.id) {
    autoMade.push(row.id);
    madeRequests.push(row.id);
  }

  // The setting's own description is part of the setting. It promised
// "new sections and example rows" for a day after a new field joined
// them, and its second line — "anything that changes a section you
// already have waits" — was untrue while it said so. It now says
// everything, so everything is what it has to do.
console.log("\nthe screen describes what it actually does");
{
  const settings = readFileSync(
    new URL("../src/components/ProjectSettings.tsx", import.meta.url),
    "utf8"
  );
  const route = readFileSync(
    new URL("../src/app/api/mcp/route.ts", import.meta.url),
    "utf8"
  );
  const panel = readFileSync(
    new URL("../src/components/ChatPanel.tsx", import.meta.url),
    "utf8"
  );
  // Nothing is held back by what kind of change it is any more. A
  // list of allowed change types anywhere in this path means the
  // limit grew back.
  check("no change type is singled out", !/ADDITIVE|BUILT_WITHOUT_ASKING/.test(route));
  check("and the screen does not promise one", !/Applies on its own:<\/span> new sections/.test(settings));
  check("the screen says it waits for nothing", /Still waits for you:<\/span> nothing/.test(settings));
  // The ceiling is gone too, and the quota is what stops a loop now.
  check("there is no builds-per-day ceiling", !/AUTO_BUILDS_PER_DAY/.test(route));
  // The one thing the setting must never reach, on or off.
  check("removing a section is still refused outright", /Removing a section cannot be done from here/.test(route));
  check("and the screen still says so", /Never, either way:/.test(settings));
  // A card that asks anyway, with the setting on, has to say why —
  // otherwise the setting reads as broken, which is what it did.
  check(
    "a card that asks anyway says why",
    /Waiting for you:/.test(panel) && /did not go in/.test(panel)
  );
  // And the reason has to have been written down, or the card has
  // nothing to read.
  // Through abo_build, because a client's token cannot write at the
  // table and this reason was never landing for the one caller that
  // produces it (0078).
  check(
    "a failed automatic build records its reason",
    /p_op: "request_outcome"/.test(route) && !/\.update\(\{ outcome:/.test(route)
  );
}

console.log("\nand a new field, which loses nothing");
{
  const added = await tool(
    "propose_change",
    {
      request: `In the section On Check ${stamp}, add a text field called Checked By. Keep every existing field.`,
    },
    31
  );
  check("it is built without asking", added.status === "built" || added.status === "partly built");
  if (added.status !== "built" && added.status !== "partly built") {
    console.log(`     → ${JSON.stringify(added).slice(0, 300)}`);
  }
  if (added.request_id) madeRequests.push(added.request_id);
}

  // A rule was the last thing held back: it keeps writing to rows
  // after it is built, so it is not one action but an ongoing one.
  // The setting now says everything, and a merchant who reads
  // "waits for you: nothing" and then finds a rule waiting has been
  // told something untrue.
  console.log("\nand a rule that runs on every row, which used to wait");
  const ruled = await tool(
    "propose_change",
    {
      request: `In the section On Check ${stamp}, add a rule that sets the note to "seen" whenever a row is created.`,
    },
    3
  );
  const ruleBuilt = ruled.status === "built" || ruled.status === "partly built";
  check("it is built too", ruleBuilt);
  if (!ruleBuilt) {
    console.log(`     propose_change said: ${JSON.stringify(ruled).slice(0, 400)}`);
  }
  check("and nothing is said about the setting not applying", !ruled.not_automatic_because);
  if (ruled.not_automatic_because) console.log(`     → ${ruled.not_automatic_because}`);
  if (ruled.request_id) madeRequests.push(ruled.request_id);

  // The one that must still be refused however the setting is set.
  console.log("\nbut removing a section, never");
  const removal = await tool(
    "propose_change",
    { request: `Delete the section On Check ${stamp} entirely.` },
    4
  );
  check("it is refused outright", /cannot be done from here/i.test(removal.error ?? ""));
  if (!/cannot be done from here/i.test(removal.error ?? "")) console.log("     →", JSON.stringify(removal).slice(0, 400));
  check("and nothing was requested", !removal.request_id);
  if (removal.request_id) madeRequests.push(removal.request_id);

  console.log("\nand the build is recorded as automatic");
  const { count } = await admin
    .from("build_requests")
    .select("id", { count: "exact", head: true })
    .eq("project_id", project.id)
    .eq("auto_built", true)
    .gt("built_at", new Date(Date.now() - 864e5).toISOString());
  check("automatic builds are counted", (count ?? 0) >= 1);
} finally {
  // Verified, not assumed. A check that leaves this on hands the next
  // merchant a project that builds without asking — and the next
  // check a failure it did not cause.
  await setAuto(project.auto_build === true);
  const after = (await admin.from("projects").select("auto_build").eq("id", project.id).single())
    .data;
  check("the setting is back as it was", after?.auto_build === (project.auto_build === true));
  if (turnsWas) {
    // What it really spent stays spent; only the ceiling comes back.
    await admin
      .from("account_settings")
      .update({ free_turns: turnsWas.free_turns })
      .eq("user_id", owner.user.id);
  }
  for (const id of made) await admin.from("modules").delete().eq("id", id);

  // The section this run built is gone now, exactly as a merchant's
  // would be if they deleted it. The history still says "built", which
  // is true and was enough to send an assistant to tell the merchant to
  // go and look at something that is not there. It has to say both.
  if (made.length) {
    const history = await tool("build_history", { project_id: project.id, limit: 20 }, 91);
    const gone = (history?.history ?? []).filter((h) => h.no_longer_there);
    check("a built section that was later deleted says so", gone.length > 0);
    // The line says "it was built". Only a row that really finished
    // may carry it — otherwise the answer invents a build.
    check(
      "and only a request that really finished carries it",
      gone.every((h) => !!h.finished)
    );
  }

  // Not a merchant's automatic build — a check's. Left counted, it
  // spends the day's allowance on nothing.
  for (const id of autoMade) {
    await admin.from("build_requests").update({ auto_built: false }).eq("id", id);
  }
  // Deleted, not dismissed, and only the rows this run made.
  //
  // Dismissing left them counting against the twenty-an-hour ceiling in
  // migration 0035 — eight runs of this check filled it exactly, and
  // the next run then failed on a limit doing its job. And the sweep
  // used to dismiss EVERY pending request on the project, which would
  // have quietly thrown away a design the merchant was still deciding
  // about.
  for (const id of madeRequests) await admin.from("build_requests").delete().eq("id", id);
  // The thread this run caused. Left behind it piles up on a real
  // account, which is how the request ceiling filled earlier today.
  if (aiThreadId) await admin.from("conversations").delete().eq("id", aiThreadId);
  await project.remove();
  console.log("\nthe project is gone, and nothing of it is left");
}

console.log(fails.length === 0 ? "\nit builds only what it may" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
