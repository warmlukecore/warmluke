// The MCP endpoint, driven by a connected assistant rather than the owner.
//
// Every other check signs in as the owner, whose token has no client_id.
// The database's client branch — who may stamp, whether a build needs
// a stamp, what a client may approve — was never reached over HTTP by
// anything in this suite. A five-a-day cap sat in it for weeks while a
// check named "the sixth build still goes in" passed, because that
// check's sixth build was the owner's.
//
// This one holds the token claude.ai holds, obtained the way claude.ai
// obtains it (see client-session.mjs), and asks the questions the
// merchant asked: with the switch on, does everything build; with it
// off, does everything wait; can the assistant talk itself past a no.
// The judge's calls play back from tapes/ by default (model-tape.ts);
// MODEL_TAPE=record, with the server recording, asks the real one.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-as-client.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsClient } from "./client-session.mjs";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { keyFor } from "../src/lib/model-tape.ts";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const APP = process.env.APP_URL ?? "http://localhost:3100";
const REF = new URL(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL).hostname.split(".")[0];
const sql = (query) =>
  fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const show = (v) => console.log("     →", JSON.stringify(v).slice(0, 320));

const me = await signInAsClient(env, APP);
if (!me.token) {
  console.log(`could not connect as a client — ${me.why}`);
  process.exit(1);
}
const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
// The client is the check user's, so its builds land on a project
// that exists for this run and is removed at the end.
const project = await throwawayProject(admin, me.userId, "as-client");
const setAuto = (on) => admin.from("projects").update({ auto_build: on }).eq("id", project.id);
process.env.MODEL_TAPE ??= "replay";

let n = 0;
const tool = async (name, args) => {
  const res = await fetch(`${APP}/api/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${me.token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++n,
      method: "tools/call",
      params: { name, arguments: { project_id: project.id, ...args } },
    }),
  });
  // Only on an answer: the server has to judge as this check expects it to.
  if (res.ok && res.headers.get("x-model-tape") !== process.env.MODEL_TAPE) {
    throw new Error(
      `the server at ${APP} is ${res.headers.get("x-model-tape") ? `in ${res.headers.get("x-model-tape")} mode` : "making real model calls"}, and this check is in ${process.env.MODEL_TAPE} mode; start it with MODEL_TAPE=${process.env.MODEL_TAPE}`
    );
  }
  const j = await res.json();
  try {
    return JSON.parse(j.result.content[0].text);
  } catch {
    return { error: `unreadable answer: ${JSON.stringify(j).slice(0, 200)}` };
  }
};
// The same words every run, so what the judge is asked plays back from
// tapes/; the throwaway project keeps runs apart, and the thread search
// below only ever looks inside it.
const stamp = "as-client";
const slug = `client-${stamp}`;
const madeRequests = [];
let moduleId = null;
const submit = async (request, plans) => {
  const r = await tool("submit_design", { request, plans });
  if (r?.request_id) madeRequests.push(r.request_id);
  return r;
};
const isBuilt = (r) => r?.status === "built" || r?.status === "partly built";
const cols = (extra) => ({
  columns: [
    { field: "note", label: "Note", type: "text" },
    ...Array.from({ length: extra }, (_, k) => ({ field: `f${k}`, label: `F${k}`, type: "text" })),
  ],
});

try {
  console.log("the token is a client's");
  check("it carries a client_id claim", typeof me.claims.client_id === "string");
  check("and it is the merchant's", me.claims.sub === me.userId);

  console.log("\nwith the switch on, a client's designs build on their own");
  await setAuto(true);
  const made = await submit(`Client check ${stamp} — section`, [
    {
      changeType: "NEW_MODULE",
      targetModuleId: null,
      newModule: { name: slug, nav_label: `Client ${stamp}`, icon: "table" },
      newSchema: { ...cols(0), view: { type: "table" } },
      explanation: "Somewhere to write a note.",
    },
  ]);
  check("a new section is built", isBuilt(made));
  if (!isBuilt(made)) show(made);
  moduleId = (made?.built ?? []).map((b) => b.moduleId).find(Boolean) ?? null;

  // Six more, because five was the number. Made by this client, over
  // HTTP, stamped by the function that used to refuse the sixth.
  let last = null;
  for (let i = 1; i <= 6; i++) {
    last = await submit(`Client check ${stamp} — field ${i}`, [
      { changeType: "FIELD_ADD", targetModuleId: moduleId, newSchema: cols(i), explanation: "One more." },
    ]);
    if (!isBuilt(last)) break;
  }
  check("and so is the seventh of the day", isBuilt(last));
  if (!isBuilt(last)) show(last);

  const { data: rows } = await admin
    .from("build_requests")
    .select("client_id, auto_built, status")
    .in("id", madeRequests);
  check(
    "every row names this client",
    (rows ?? []).every((r) => r.client_id === me.claims.client_id)
  );
  check(
    "and records that nobody approved it",
    (rows ?? []).every((r) => r.auto_built === true && r.status === "built")
  );
  if (!(rows ?? []).every((r) => r.auto_built === true && r.status === "built")) show(rows);

  // Nobody tapped anything, so if the server does not write this
  // down the app changes and the merchant's history stays blank. As a
  // client, the write is the kind RLS refuses — so it is asked here,
  // not assumed from the owner-token checks that passed.
  const { data: thread } = await admin
    .from("conversations")
    .select("id")
    .eq("project_id", project.id)
    .eq("title", "Changes from your AI")
    .maybeSingle();
  const { data: noted } = thread
    ? await admin
        .from("messages")
        .select("role, content")
        .eq("conversation_id", thread.id)
        .ilike("content", `%${stamp}%`)
    : { data: [] };
  check(
    "the merchant's thread records what the client built",
    (noted ?? []).some((m) => m.role === "user")
  );
  check(
    "and what came of it",
    (noted ?? []).some((m) => m.role === "assistant" && m.content.startsWith("✅"))
  );

  // The judge's row is written through a definer function because a
  // client cannot write at the table. Proven with a client's token, or
  // it is only proven for the owner. Needs the server to hold the key;
  // without it no row comes, and that is what "no key" means.
  if (keyFor(env.TYPESAFE_API_KEY)) {
    let judged = null;
    for (let i = 0; i < 40 && !judged; i++) {
      const { data } = await admin
        .from("judgements")
        .select("source, ref")
        .eq("project_id", project.id)
        .eq("ref", made?.request_id)
        .maybeSingle();
      judged = data;
      if (!judged) await new Promise((r) => setTimeout(r, 500));
    }
    check("the judge's verdict on the client's design landed", judged?.source === "mcp");
  } else {
    console.log("  skip  no TYPESAFE_API_KEY — whether the judge writes for a client was not checked");
  }

  const history = await tool("build_history", { limit: 10 });
  check(
    "build_history credits them to this assistant",
    (history?.history ?? []).some((h) => h.raised_by === "this assistant" && h.state === "built")
  );

  console.log("\nwith it off, the same client waits");
  await setAuto(false);
  const waiting = await submit(`Client check ${stamp} — while off`, [
    { changeType: "FIELD_ADD", targetModuleId: moduleId, newSchema: cols(7), explanation: "One more." },
  ]);
  check("the design waits for approval", waiting?.status === "waiting for approval");
  if (waiting?.status !== "waiting for approval") show(waiting);

  // The door 0072 was about: the same assistant, having been told to
  // wait, asks to approve its own design.
  const talked = await tool("approve_change", { request_id: waiting?.request_id });
  check("and cannot approve it itself", talked?.status === "waiting for approval");
  check("and is told the merchant does that in Warmluke", /Warmluke/.test(talked?.error ?? talked?.note ?? ""));
  const { data: still } = await admin
    .from("build_requests")
    .select("status, approved_at")
    .eq("id", waiting?.request_id)
    .single();
  check("nothing was stamped", still?.approved_at === null && still?.status === "pending");

  // A no, with the merchant's words. reject_change recorded the no
  // through a function and then wrote the words straight at the table
  // — which a client cannot do — so in build_history a week later
  // every refusal a real assistant relayed read as "dismissed" with no
  // reason, while the owner-token check saw the words kept fine.
  console.log("\nand a refusal keeps the merchant's words, even from a client");
  const toRefuse = await submit(`Client check ${stamp} — to refuse`, [
    { changeType: "FIELD_ADD", targetModuleId: moduleId, newSchema: cols(8), explanation: "One more." },
  ]);
  check("a design to refuse is waiting", toRefuse?.status === "waiting for approval");
  const refused = await tool("reject_change", {
    request_id: toRefuse?.request_id,
    reason: "they said they already track this in a spreadsheet",
  });
  check("it is dismissed", refused?.status === "dismissed");
  const { data: kept } = await admin
    .from("build_requests")
    .select("status, summary")
    .eq("id", toRefuse?.request_id)
    .single();
  check("and the words are kept on the row", /spreadsheet/.test(kept?.summary ?? ""));
  if (!/spreadsheet/.test(kept?.summary ?? "")) show(kept);

  console.log("\nand switched back on, that waiting design can be approved by the client");
  await setAuto(true);
  const later = await tool("approve_change", { request_id: waiting?.request_id });
  check("approve_change builds it", isBuilt(later));
  if (!isBuilt(later)) show(later);

  // ── And the one yes it may never give ─────────────────────────
  //
  // auto_build is on at this point, which is the whole danger: it is
  // a standing yes to building sections in the merchant's own app,
  // and a change to their live Shopify store must not inherit it.
  // Tested with the same client token that just built something, so
  // the difference is the rule and not the caller.
  console.log("\nbut a change to the shop itself is never the client's to approve");
  {
    await admin.from("account_settings").update({ store_actions_enabled: true }).eq("user_id", me.userId);
    const { data: store } = await admin
      .from("stores")
      .insert({
        project_id: project.id,
        shop_domain: `as-client-${stamp}.myshopify.com`,
        status: "connected",
      })
      .select("id")
      .single();
    const owner = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
    await signInAsCheckUser(owner, env);
    const { data: action } = await owner.rpc("abo_action_propose", {
      p_project: project.id,
      p_store: store.id,
      p_action: "tag_orders",
      p_targets: ["gid://shopify/Order/1"],
      p_params: { tag: "rush" },
      p_summary: "Tags one order rush",
    });
    check("a change to the store can be proposed", !!action);

    const asClient = createClient(
      env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
      env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY,
      { global: { headers: { Authorization: `Bearer ${me.token}` } } }
    );
    const { data: tried } = await asClient.rpc("abo_action_approve", { p_action: action });
    check("the client cannot approve it, with auto-build on", tried?.approved === false);
    check("and is told whose yes it needs", /merchant/i.test(tried?.reason ?? ""));
    const { data: still } = await admin.from("store_actions").select("status, approved_at").eq("id", action).single();
    check("the row is untouched", still?.status === "pending" && still?.approved_at === null);

    // ── Asking for one, through the tool ──────────────────────
    //
    // Everything below is the assistant's road: what it may ask for,
    // what it is told when it asks wrongly, and what it is handed to
    // read back. The store here has never recorded a granted scope,
    // which is the state every store is in until write scopes exist
    // — so proposing is allowed and running is not, and both halves
    // are checked.
    console.log("\nand the tool for it answers an assistant properly");
    {
      const nonsense = await tool("propose_store_action", {
        action: "explode_the_shop",
        targets: [{ id: "gid://shopify/Order/1" }],
      });
      check("an action nobody declared is refused", /no change called/i.test(nonsense?.error ?? ""));
      check(
        "and it is told what there is",
        Array.isArray(nonsense?.what_can_be_asked_for) && nonsense.what_can_be_asked_for.length > 0
      );
      check(
        "with whether each can be taken back",
        (nonsense?.what_can_be_asked_for ?? []).every((c) => "can_be_taken_back" in c || "cannot_be_taken_back" in c)
      );

      const badIds = await tool("propose_store_action", {
        action: "add_tags",
        targets: ["1042", { id: "gid://shopify/Order/7" }],
        params: { tags: ["rush"] },
      });
      check("a number instead of a Shopify id is refused", /cannot be acted on/i.test(badIds?.error ?? ""));
      check(
        "and the bad one is named back",
        (badIds?.these ?? []).some((t) => /1042/.test(t))
      );

      const noTag = await tool("propose_store_action", {
        action: "add_tags",
        targets: [{ id: "gid://shopify/Order/7" }],
        params: {},
      });
      check("a tag change with no tag is refused", /no tag/i.test(noTag?.error ?? ""));

      const tooMany = await tool("propose_store_action", {
        action: "add_tags",
        targets: Array.from({ length: 500 }, (_, i) => ({ id: `gid://shopify/Order/${i + 1}` })),
        params: { tags: ["rush"] },
      });
      check("too many at once is refused", /most one change may touch/i.test(tooMany?.error ?? ""));

      const asked = await tool("propose_store_action", {
        action: "add_tags",
        targets: [{ id: "gid://shopify/Order/7" }, { id: "gid://shopify/Order/8" }],
        params: { tags: ["rush"] },
      });
      check("a real one is accepted", !!asked?.action_id);
      // The words on the card come off the registry, not off
      // whatever the assistant said it was doing.
      check("and the merchant reads what it really does", /^Tags 2 orders "rush"$/.test(asked?.changes ?? ""));
      check("it says nothing changed yet", /waiting for the merchant/i.test(asked?.status ?? ""));
      check("and that this one can be taken back", asked?.can_be_taken_back === true);
      check(
        "it hands over the steps",
        (asked?.what_the_merchant_does ?? []).some((x) => /Do it/.test(x))
      );
      check("and a link that opens on it", (asked?.open ?? "").includes(asked?.action_id ?? "never"));

      const listed = await tool("pending_changes", {});
      const mineInList = (listed?.waiting_store_changes ?? []).find((w) => w.action_id === asked?.action_id);
      check("it shows up in what is waiting", !!mineInList);
      check("and is never the assistant's to approve", mineInList?.you_can_approve_it === false);

      // The route the panel uses, driven with the merchant's own
      // session: approve and run in one act.
      const owner2 = createClient(
        env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
        env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
      );
      const ownerSession = await signInAsCheckUser(owner2, env);
      const post = (body) =>
        fetch(`${APP}/api/store-actions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ownerSession.session.access_token}`,
          },
          body: JSON.stringify(body),
        }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

      const ran = await post({ actionId: asked.action_id, do: "run" });
      check("the merchant's yes reaches the shop road", ran.status === 200);
      check(
        "and it stops at the scopes nobody granted",
        /has not allowed|write_orders/i.test((ran.body?.errors ?? []).join(" "))
      );
      check("with the row finished rather than left running", ran.body?.status === "failed");

      const twice = await post({ actionId: asked.action_id, do: "run" });
      check("a second yes is refused", twice.status === 409);
      check("and says nothing went out", /nothing was sent/i.test(twice.body?.note ?? ""));

      const gibberish = await post({ actionId: asked.action_id, do: "juggle" });
      check("an instruction nobody wrote is refused", gibberish.status === 400);

      const another = await tool("propose_store_action", {
        action: "add_tags",
        targets: [{ id: "gid://shopify/Order/9" }],
        params: { tags: ["later"] },
      });
      const turned = await post({ actionId: another.action_id, do: "dismiss" });
      check("turning one down works", turned.body?.dismissed === true);
      const after = await post({ actionId: another.action_id, do: "run" });
      check("and a dismissed one cannot then be run", after.status === 409);
    }

    await admin.from("account_settings").update({ store_actions_enabled: false }).eq("user_id", me.userId);

    console.log("\nand with the switch off, nothing may be asked for at all");
    {
      const off = await tool("propose_store_action", {
        action: "add_tags",
        targets: [{ id: "gid://shopify/Order/7" }],
        params: { tags: ["rush"] },
      });
      check("the tool refuses outright", /not turned on/i.test(off?.error ?? ""));
      check("and says what still works", /reading/i.test(off?.note ?? ""));
    }
  }
} finally {
  await setAuto(project.auto_build === true);
  const back = (await admin.from("projects").select("auto_build").eq("id", project.id).single()).data;
  check("the setting is back as it was", back?.auto_build === (project.auto_build === true));
  if (moduleId) await admin.from("modules").delete().eq("id", moduleId);
  for (const id of madeRequests) await admin.from("build_requests").delete().eq("id", id);
  const { data: thread } = await admin
    .from("conversations")
    .select("id")
    .eq("project_id", project.id)
    .eq("title", "Changes from your AI")
    .maybeSingle();
  if (thread) {
    const { data: msgs } = await admin.from("messages").select("id, content").eq("conversation_id", thread.id);
    const mine = (msgs ?? []).filter((m) => m.content.includes(stamp));
    for (const m of mine) await admin.from("messages").delete().eq("id", m.id);
    if (mine.length === (msgs ?? []).length) await admin.from("conversations").delete().eq("id", thread.id);
  }
  await me.revoke(sql);
  await project.remove();
  console.log("\nthe project is gone, and so is the client");
}

console.log(fails.length === 0 ? "\na connected assistant is held to the same rules" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
