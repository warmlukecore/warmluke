// An erased person is erased from the carts too.
//
// Abandoned carts are the second table in this app that holds a
// person: a name, an email, and a link back to their basket. The
// tombstone machinery built for customers only ever knew about
// customers, so a new table holding an email is exactly the way a
// redaction quietly stops being a redaction — it reports success and
// leaves the address sitting somewhere nobody thought to look.
//
// Four things, and the last two are the ones that would have been
// missed: that the erasure reaches a cart left by somebody who never
// became a customer row, and that the next import cannot bring them
// back.
//
//   ENV_FILE=.env.check.local node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-cart-redaction.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";

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

const anon = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

const me = await signInAsCheckUser(anon, env);
if (!me.session) {
  console.log(`no check user: ${me.why}`);
  process.exit(1);
}
const project = await throwawayProject(admin, me.user.id, "cart-redaction");
const stamp = Date.now().toString(36);
const shop = `carts-${stamp}.myshopify.com`;

try {
  const { data: store } = await admin
    .from("stores")
    .insert({ project_id: project.id, shop_domain: shop, status: "connected" })
    .select("id")
    .single();

  const gone = `gone-${stamp}@example.test`;
  const stays = `stays-${stamp}@example.test`;
  const byId = `gid://shopify/Customer/${stamp}1`;

  const cart = (external, email, customerExternal = null, customerId = null) => ({
    store_id: store.id,
    external_id: external,
    customer_id: customerId,
    customer_external_id: customerExternal,
    name: "A Person",
    email,
    total: 1299.0,
    currency: "USD",
    recovery_url: "https://example.test/cart",
    item_count: 2,
    items: "Clear Phone Case ×2",
    started_at: "2026-09-21T10:00:00Z",
  });
  const carts = async () =>
    (await admin.from("abandoned_checkouts").select("external_id, email").eq("store_id", store.id)).data ?? [];

  console.log("a cart from somebody who never became a customer");
  await admin
    .from("abandoned_checkouts")
    .insert([
      cart(`gid://shopify/AbandonedCheckout/${stamp}A`, gone),
      cart(`gid://shopify/AbandonedCheckout/${stamp}B`, stays),
    ]);
  check("both are here to begin with", (await carts()).length === 2);

  console.log("\nand a redaction naming only an email");
  const { error: e1 } = await admin.rpc("abo_shopify_customer_redact_email", {
    p_shop: shop,
    p_email: gone,
  });
  check("is accepted", !e1);
  if (e1) console.log("     →", e1.message);
  const after = await carts();
  check("their cart is gone", !after.some((c) => c.email === gone));
  // The half that matters: one request must not sweep up everybody.
  check(
    "and the other person's is untouched",
    after.some((c) => c.email === stays)
  );

  console.log("\nand the next import cannot bring them back");
  // Exactly what saveCarts does on the following pass.
  const { error: e2 } = await admin
    .from("abandoned_checkouts")
    .insert(cart(`gid://shopify/AbandonedCheckout/${stamp}A`, gone));
  // Skipped by the trigger rather than raised, so an import of two
  // hundred carts holding one erased person writes the rest.
  check("writing it again raises nothing", !e2);
  check("and it is still gone", !(await carts()).some((c) => c.email === gone));

  console.log("\nand a redaction naming a person by id reaches their cart");
  const { data: person } = await admin
    .from("customers")
    .insert({ store_id: store.id, external_id: byId, name: "By Id", email: `byid-${stamp}@example.test` })
    .select("id")
    .single();
  await admin.from("abandoned_checkouts").insert([
    // Linked to the customer row.
    cart(`gid://shopify/AbandonedCheckout/${stamp}C`, `byid-${stamp}@example.test`, byId, person.id),
    // And one left before that row existed, carrying only Shopify's
    // id. This is the one a join through customers would have missed.
    cart(`gid://shopify/AbandonedCheckout/${stamp}D`, null, byId, null),
  ]);
  check("both of theirs are here", (await carts()).length === 3);

  const { error: e3 } = await admin.rpc("abo_shopify_customer_redact", {
    p_shop: shop,
    p_customer: byId,
  });
  check("the redaction is accepted", !e3);
  if (e3) console.log("     →", e3.message);
  const left = await carts();
  check("the linked cart is gone", !left.some((c) => c.external_id.endsWith(`${stamp}C`)));
  check("and so is the one that was never linked", !left.some((c) => c.external_id.endsWith(`${stamp}D`)));
  check(
    "and the unrelated person is still here",
    left.some((c) => c.email === stays)
  );
  const { count: stillCustomer } = await admin
    .from("customers")
    .select("id", { count: "exact", head: true })
    .eq("store_id", store.id)
    .eq("external_id", byId);
  check("and the customer row went with them", (stillCustomer ?? 0) === 0);

  // ── And the second table that names a person ──────────────────
  // A draft order carries a name and an address exactly as a cart
  // does, and 0103 points both at one trigger. A table added to the
  // erasure in code and not in the tombstone check is how a
  // redaction starts reporting a success it did not perform.
  console.log("\nand a draft order is a place a person is kept too");
  const goneD = `goned-${stamp}@example.test`;
  const staysD = `staysd-${stamp}@example.test`;
  const draft = (external, email, customerExternal = null) => ({
    store_id: store.id,
    external_id: external,
    customer_external_id: customerExternal,
    name_on_draft: "A Person",
    email,
    name: `#D${external.slice(-2)}`,
    status: "OPEN",
    total: 598.0,
    currency: "USD",
    drafted_at: "2026-09-21T10:00:00Z",
  });
  const drafts = async () =>
    (await admin.from("draft_orders").select("external_id, email").eq("store_id", store.id)).data ?? [];

  await admin
    .from("draft_orders")
    .insert([draft(`gid://shopify/DraftOrder/${stamp}A`, goneD), draft(`gid://shopify/DraftOrder/${stamp}B`, staysD)]);
  check("both drafts are here to begin with", (await drafts()).length === 2);

  const { error: e4 } = await admin.rpc("abo_shopify_customer_redact_email", {
    p_shop: shop,
    p_email: goneD,
  });
  check("an erasure by email is accepted", !e4);
  if (e4) console.log("     →", e4.message);
  const leftDrafts = await drafts();
  check("their draft is gone", !leftDrafts.some((d) => d.email === goneD));
  check(
    "and the other person's is untouched",
    leftDrafts.some((d) => d.email === staysD)
  );
  // The trigger, on the new table: the next import must not undo it.
  const { error: e5 } = await admin.from("draft_orders").insert(draft(`gid://shopify/DraftOrder/${stamp}A`, goneD));
  check("writing it again raises nothing", !e5);
  check("and it is still gone", !(await drafts()).some((d) => d.email === goneD));

  // By id, for a draft made before that person was ever a customer
  // row — the case a join through customers would have missed.
  const draftPerson = `gid://shopify/Customer/${stamp}2`;
  await admin.from("draft_orders").insert(draft(`gid://shopify/DraftOrder/${stamp}C`, null, draftPerson));
  const { error: e6 } = await admin.rpc("abo_shopify_customer_redact", {
    p_shop: shop,
    p_customer: draftPerson,
  });
  check("an erasure by id is accepted", !e6);
  if (e6) console.log("     →", e6.message);
  const afterId = await drafts();
  check("the draft naming them by id is gone", !afterId.some((d) => d.external_id.endsWith(`${stamp}C`)));
  check(
    "and the unrelated draft is still here",
    afterId.some((d) => d.email === staysD)
  );
} finally {
  await admin.from("projects").delete().eq("id", project.id);
  console.log("\nthe project is gone");
}

console.log(fails.length === 0 ? "\nerased means erased, carts included" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
