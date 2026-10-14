// A store connects its courier (0204, docs/integrations/connectors.md).
//
// Only the owner connects, from Warmluke and not from their AI's token;
// the credential goes to the vault and no browser reads it back; a
// stranger sees nothing; rows are written only by the ticket's
// functions, and a ticket reaches its own connection for minutes and
// nothing else; a shipment lands on the Shopify order it names; a
// refused credential asks for the owner; a provider that posts to us
// reaches its own connection by the token in its address, and nothing
// else (0205); disconnecting takes the credential and the address, and
// keeps the rows.
//
//   ENV_FILE=.env.check.local node scripts/check-connectors.mjs
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
const worker = (ticket) =>
  createClient(URL_, ANON, { global: { headers: { "x-connector-ticket": ticket } }, auth: { persistSession: false } });

let failed = 0;
const check = (what, ok) => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`);
  if (!ok) failed++;
};

const stamp = Date.now();
async function person(tag) {
  const email = `connectors_${tag}_${stamp}@example.com`;
  const password = `pw_${stamp}_aA1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (!data.user) throw new Error(`could not create ${tag}: ${error?.message}`);
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error: signIn } = await client.auth.signInWithPassword({ email, password });
  if (signIn) throw new Error(`could not sign in ${tag}: ${signIn.message}`);
  return { id: data.user.id, client };
}

const owner = await person("owner");
const stranger = await person("stranger");
let projectId = null;
try {
  const { data: project, error: pe } = await admin
    .from("projects")
    .insert({ owner_id: owner.id, name: `connectors-check ${stamp}` })
    .select("id")
    .single();
  if (pe) throw new Error(`could not make the project: ${pe.message}`);
  projectId = project.id;
  const { data: store, error: se } = await admin
    .from("stores")
    .insert({ project_id: projectId, shop_domain: `connectors-${stamp}.myshopify.com`, status: "connected" })
    .select("id")
    .single();
  if (se) throw new Error(`could not make the store: ${se.message}`);
  const { data: order } = await admin
    .from("orders")
    .insert({ store_id: store.id, external_id: "gid://shopify/Order/7001", order_number: "#1042", source: "shopify" })
    .select("id")
    .single();
  const secret = JSON.stringify({ email: "api@example.com", password: "not-real", token: "tok-1" });
  const save = (client, extra = {}) =>
    client.rpc("abo_connector_save", {
      p_store: store.id,
      p_provider: "shiprocket",
      p_account_ref: "api@example.com",
      p_account_label: "Shiprocket · api@example.com",
      p_secret: secret,
      ...extra,
    });

  console.log("\nonly the owner connects");
  const refused = await save(stranger.client);
  check("a stranger cannot", refused.error?.code === "42501");
  const { data: id, error: saveError } = await save(owner.client);
  check("the owner can", !saveError && typeof id === "string");
  if (saveError) console.log("     →", saveError.message);

  console.log("\nwho sees what");
  const { data: mine } = await owner.client.from("store_connections").select("*").eq("id", id);
  check("the owner sees the connection", mine?.length === 1 && mine[0].status === "connected");
  check("with no credential on it", !JSON.stringify(mine ?? []).includes("not-real"));
  const { data: theirs } = await stranger.client.from("store_connections").select("id").eq("id", id);
  check("a stranger sees nothing", (theirs ?? []).length === 0);
  const forged = await owner.client.from("courier_shipments").insert({
    project_id: projectId,
    store_id: store.id,
    connection_id: id,
    provider: "shiprocket",
    shipment_ref: "forged",
  });
  check("no browser writes a shipment straight", !!forged.error);
  const bumped = await owner.client.from("store_connections").update({ status: "disconnected" }).eq("id", id);
  const { data: still } = await admin.from("store_connections").select("status").eq("id", id).single();
  check("nor changes the connection straight", !!bumped.error || still?.status === "connected");

  console.log("\na ticket reaches its own connection, for minutes");
  const nobody = worker("x".repeat(64));
  const { data: noJob } = await nobody.rpc("abo_connector_job");
  check("a made-up ticket gets nothing", noJob === null);
  const blind = await nobody.rpc("abo_connector_put_shipments", { p_rows: [] });
  check("and writes nothing", blind.error?.code === "42501");
  const { data: ticket } = await admin.rpc("abo_connector_mint", { p_connection: id });
  check("a ticket is minted", typeof ticket === "string" && ticket.length >= 32);
  const { data: second } = await admin.rpc("abo_connector_mint", { p_connection: id });
  check("and only one at a time", second === null);
  const w = worker(ticket);
  const { data: job } = await w.rpc("abo_connector_job");
  check("its worker reads the credential", job?.id === id && job?.secret === secret && job?.provider === "shiprocket");
  const { data: put, error: putError } = await w.rpc("abo_connector_put_shipments", {
    p_rows: [
      {
        shipment_ref: "SR-1",
        awb: "AWB1",
        order_ref: "1042",
        courier: "Delhivery",
        status: "DELIVERED",
        delivered_at: "2026-10-10T09:00:00Z",
        cod_amount: 899,
        payment_mode: "cod",
      },
      { shipment_ref: "SR-2", awb: "AWB2", order_ref: "9999", status: "IN TRANSIT" },
    ],
  });
  check("a page of shipments is written", !putError && put === 2);
  if (putError) console.log("     →", putError.message);
  const { data: rows } = await owner.client
    .from("store_courier_shipments")
    .select("awb, order_number, status, delivered_at, cod_amount")
    .eq("store_id", store.id)
    .order("awb");
  check("the owner reads them as a list", rows?.length === 2);
  check(
    "a shipment lands on the Shopify order it names",
    rows?.[0]?.order_number === "#1042" && Number(rows?.[0]?.cod_amount) === 899
  );
  const { data: matched } = await admin
    .from("courier_shipments")
    .select("order_id")
    .eq("shipment_ref", "SR-1")
    .single();
  check("by the order's own row", matched?.order_id === order.id);
  check("and one it cannot find keeps the courier's own reference", rows?.[1]?.order_number === "9999");
  await w.rpc("abo_connector_put_shipments", { p_rows: [{ shipment_ref: "SR-2", status: "DELIVERED" }] });
  const { data: moved } = await admin
    .from("courier_shipments")
    .select("status, awb")
    .eq("shipment_ref", "SR-2")
    .single();
  check(
    "a later page moves it on, keeping what it did not say",
    moved?.status === "DELIVERED" && moved?.awb === "AWB2"
  );
  await w.rpc("abo_connector_put_cursor", { p_resource: "orders", p_cursor: "page:2" });
  const { data: again } = await w.rpc("abo_connector_job");
  check("its place is kept", again?.cursors?.orders?.cursor === "page:2");
  await admin
    .from("connector_leases")
    .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq("connection_id", id);
  const { data: lapsed } = await w.rpc("abo_connector_job");
  check("a lapsed ticket gets nothing", lapsed === null);

  console.log("\nwhat the store's ads cost (0214)");
  await admin.from("connector_leases").delete().eq("connection_id", id);
  const { data: courierTicket } = await admin.rpc("abo_connector_mint", { p_connection: id });
  const shipping = await worker(courierTicket).rpc("abo_connector_put_ad_spend", { p_rows: [] });
  check(
    "a courier's ticket writes no spend",
    shipping.error?.code === "42501" && /does not bring ad spend/.test(shipping.error?.message ?? "")
  );
  await admin.from("connector_leases").delete().eq("connection_id", id);
  const { data: adsId, error: adsError } = await owner.client.rpc("abo_connector_save", {
    p_store: store.id,
    p_provider: "meta_ads",
    p_account_ref: "act_1234567890",
    p_account_label: "Shop Ads (act_1234567890)",
    p_secret: JSON.stringify({ token: "not-real-meta", account: "act_1234567890" }),
  });
  check("the owner connects an ad account", !adsError && typeof adsId === "string");
  const { data: adsTicket } = await admin.rpc("abo_connector_mint", { p_connection: adsId });
  const ads = worker(adsTicket);
  const day = { campaign_id: "120200000000001", campaign_name: "Diwali sale", day: "2026-10-12", currency: "INR" };
  const { data: spent, error: spentError } = await ads.rpc("abo_connector_put_ad_spend", {
    p_rows: [
      { ...day, spend: 1000, impressions: 48211, clicks: 903, purchases: 10, purchase_value: 25000 },
      { campaign_id: "", day: "2026-10-12", spend: 5 },
      { campaign_id: "9", day: "12 Oct", spend: 5 },
    ],
  });
  check("its ticket writes a page of days, skipping rows with no campaign or day", !spentError && spent === 1);
  if (spentError) console.log("     →", spentError.message);
  await ads.rpc("abo_connector_put_ad_spend", {
    p_rows: [{ ...day, spend: 1250, purchases: 12, purchase_value: 30000 }],
  });
  const { data: spend } = await owner.client
    .from("store_ad_spend")
    .select("day, campaign_name, spend, purchases, roas, cost_per_purchase")
    .eq("store_id", store.id);
  check("Meta's later word on a day replaces its first", spend?.length === 1 && Number(spend[0].spend) === 1250);
  check(
    "with ROAS and cost per purchase worked out",
    Number(spend?.[0]?.roas) === 24 && Number(spend?.[0]?.cost_per_purchase) === 104.17
  );
  const { data: hidden } = await stranger.client.from("store_ad_spend").select("id").eq("store_id", store.id);
  check("a stranger sees none of it", (hidden ?? []).length === 0);
  const forgedSpend = await owner.client.from("ad_spend").insert({
    project_id: projectId,
    store_id: store.id,
    connection_id: adsId,
    provider: "meta_ads",
    campaign_id: "forged",
    day: "2026-10-12",
  });
  check("and no browser writes spend straight", !!forgedSpend.error);
  await admin.from("connector_leases").delete().eq("connection_id", adsId);

  console.log("\nthe rest of the store's day (0215)");
  const { data: buyer } = await admin
    .from("customers")
    .insert({
      store_id: store.id,
      external_id: "gid://shopify/Customer/88",
      name: "Asha",
      email: "Asha@Shop.in",
      phone: "+91 98765 43210",
      orders_count: 3,
    })
    .select("id")
    .single();
  // Each list: the provider that brings it, one row as its adapter hands it over, and its view.
  const lists = [
    {
      list: "web_traffic",
      provider: "google_analytics",
      view: "store_web_traffic",
      row: {
        day: "2026-10-12",
        source: "facebook",
        medium: "paid",
        campaign: "diwali",
        sessions: 200,
        users: 150,
        purchases: 4,
        revenue: 3600,
        currency: "INR",
      },
    },
    {
      list: "email_campaigns",
      provider: "mailchimp",
      view: "store_email_campaigns",
      row: {
        campaign_ref: "c1",
        name: "Diwali",
        sent_at: "2026-10-10T08:00:00Z",
        sent: 1000,
        delivered: 975,
        opens: 420,
        clicks: 61,
      },
    },
    {
      list: "support_tickets",
      provider: "zendesk",
      view: "store_support_tickets",
      row: {
        ticket_ref: "9",
        subject: "Where is my order?",
        status: "open",
        requester_email: "asha@shop.in",
        tags: ["wismo"],
      },
    },
    {
      list: "crm_contacts",
      provider: "hubspot",
      view: "store_crm_contacts",
      row: { contact_ref: "77", name: "Asha", phone: "098765 43210", lifecycle_stage: "customer" },
    },
    {
      list: "social_posts",
      provider: "meta_social",
      view: "store_social_posts",
      row: {
        post_ref: "p1",
        network: "facebook",
        posted_at: "2026-10-11T10:00:00Z",
        likes: 40,
        comments: 3,
        shares: 2,
      },
    },
  ];
  for (const { list, provider, view, row } of lists) {
    const { data: cid } = await owner.client.rpc("abo_connector_save", {
      p_store: store.id,
      p_provider: provider,
      p_account_ref: `${provider}-1`,
      p_account_label: provider,
      p_secret: JSON.stringify({ key: "not-real" }),
    });
    const { data: t } = await admin.rpc("abo_connector_mint", { p_connection: cid });
    const { data: n, error: e } = await worker(t).rpc(`abo_connector_put_${list}`, { p_rows: [row] });
    check(`${provider} connects and its ticket writes ${list}`, !e && n === 1);
    if (e) console.log("     →", e.message);
    const other = await worker(t).rpc(
      list === "web_traffic" ? "abo_connector_put_social_posts" : "abo_connector_put_web_traffic",
      { p_rows: [] }
    );
    check(`and no other list`, other.error?.code === "42501");
    const { data: seen } = await owner.client.from(view).select("*").eq("store_id", store.id);
    check(`the owner reads ${list} as a list`, seen?.length === 1);
    const { data: hiddenRows } = await stranger.client.from(view).select("id").eq("store_id", store.id);
    check(`a stranger reads none of it`, (hiddenRows ?? []).length === 0);
    const straight = await owner.client
      .from(list)
      .insert({ project_id: projectId, store_id: store.id, connection_id: cid, provider });
    check(`no browser writes it straight`, !!straight.error);
    await admin.from("connector_leases").delete().eq("connection_id", cid);
  }
  const { data: ticketRow } = await admin
    .from("support_tickets")
    .select("customer_id")
    .eq("store_id", store.id)
    .single();
  check("a ticket lands on the Shopify customer its email names", ticketRow?.customer_id === buyer?.id);
  const { data: contactRow } = await admin.from("crm_contacts").select("customer_id").eq("store_id", store.id).single();
  check("and a contact on the one its phone's last ten digits name", contactRow?.customer_id === buyer?.id);
  const { data: rate } = await owner.client
    .from("store_web_traffic")
    .select("conversion_rate")
    .eq("store_id", store.id)
    .single();
  check("a day's conversion rate is worked out", Number(rate?.conversion_rate) === 2);

  console.log("\na refused credential asks for the owner");
  await admin.from("connector_leases").delete().eq("connection_id", id);
  const { data: t2 } = await admin.rpc("abo_connector_mint", { p_connection: id });
  await worker(t2).rpc("abo_connector_done", { p_error: "Shiprocket refused the login.", p_refused: true });
  const { data: attention } = await owner.client
    .from("store_connections")
    .select("status, last_error")
    .eq("id", id)
    .single();
  check("it is marked for their attention", attention?.status === "needs_attention" && !!attention?.last_error);
  const { data: t3 } = await admin.rpc("abo_connector_mint", { p_connection: id });
  check("and no sync runs until they connect again", t3 === null);
  await save(owner.client);
  const { data: back } = await owner.client
    .from("store_connections")
    .select("status, last_error")
    .eq("id", id)
    .single();
  check("connecting again clears it", back?.status === "connected" && back?.last_error === null);

  console.log("\na provider that tells us itself");
  const hookToken = randomBytes(32).toString("hex");
  const unheld = await nobody.rpc("abo_connector_put_hook", { p_token: hookToken });
  check("no address is kept without a ticket", unheld.error?.code === "42501");
  await admin.from("connector_leases").delete().eq("connection_id", id);
  const { data: t5 } = await admin.rpc("abo_connector_mint", { p_connection: id });
  const w5 = worker(t5);
  const { error: hookError } = await w5.rpc("abo_connector_put_hook", { p_token: hookToken });
  check("its sync keeps the address's token", !hookError);
  if (hookError) console.log("     →", hookError.message);
  const { data: shown } = await owner.client.from("store_connections").select("*").eq("id", id);
  check("as a hash nobody can post with", !JSON.stringify(shown ?? []).includes(hookToken));
  const post = (token, delivered, provider = "shiprocket") =>
    anon.rpc("abo_connector_hook", { p_provider: provider, p_token: token, p_rows: delivered });
  const guessed = await post(randomBytes(32).toString("hex"), [{ shipment_ref: "SR-X", status: "DELIVERED" }]);
  check("an address we never made is refused", guessed.error?.code === "42501");
  const crossed = await post(hookToken, [{ shipment_ref: "SR-X" }], "goswift");
  check("and so is the right token for another provider", crossed.error?.code === "42501");
  const { data: told, error: toldError } = await post(hookToken, [
    { shipment_ref: "SR-3", awb: "AWB3", order_ref: "1042", status: "Undelivered", ndr_reason: "Customer Unavailable" },
  ]);
  check("the right one writes its rows", !toldError && told === 1);
  if (toldError) console.log("     →", toldError.message);
  const { data: three } = await owner.client
    .from("store_courier_shipments")
    .select("order_number, status, ndr_reason")
    .eq("store_id", store.id)
    .eq("awb", "AWB3")
    .single();
  check("on the order it names", three?.order_number === "#1042" && three?.ndr_reason === "Customer Unavailable");
  await post(hookToken, [{ shipment_ref: "SR-3", courier: "BLUEDART" }]);
  const { data: kept3 } = await admin
    .from("courier_shipments")
    .select("ndr_reason, courier")
    .eq("shipment_ref", "SR-3")
    .single();
  check(
    "a delivery with no status leaves the NDR as it was",
    kept3?.ndr_reason === "Customer Unavailable" && kept3?.courier === "BLUEDART"
  );
  await post(hookToken, [{ shipment_ref: "SR-3", status: "In Transit" }]);
  const { data: moved3 } = await admin
    .from("courier_shipments")
    .select("ndr_reason")
    .eq("shipment_ref", "SR-3")
    .single();
  check("and a new status clears it", moved3?.ndr_reason === null);
  await admin
    .from("courier_shipments")
    .update({ updated_at: new Date(Date.now() - 7 * 3600_000).toISOString() })
    .eq("connection_id", id);
  const { data: quiet } = await w5.rpc("abo_connector_open_shipments", { p_settled: ["DELIVERED"], p_limit: 10 });
  check("its sync is told which have gone quiet, not the settled", JSON.stringify(quiet) === JSON.stringify(["SR-3"]));
  const { data: quietBlind } = await nobody.rpc("abo_connector_open_shipments", { p_settled: [], p_limit: 10 });
  check("and nobody else is told anything", Array.isArray(quietBlind) && quietBlind.length === 0);
  await w5.rpc("abo_connector_release");

  console.log("\ndisconnecting");
  const theirOff = await stranger.client.rpc("abo_connector_disconnect", { p_connection: id });
  check("a stranger cannot", theirOff.error?.code === "42501");
  const { error: offError } = await owner.client.rpc("abo_connector_disconnect", { p_connection: id });
  const { data: off } = await owner.client
    .from("store_connections")
    .select("status, disconnected_at")
    .eq("id", id)
    .single();
  check("the owner can", !offError && off?.status === "disconnected" && !!off?.disconnected_at);
  const { data: kept } = await owner.client.from("store_courier_shipments").select("awb").eq("store_id", store.id);
  check("and the rows already brought stay", kept?.length === 3);
  const late = await post(hookToken, [{ shipment_ref: "SR-3", status: "Delivered" }]);
  check("its address is refused from then", late.error?.code === "42501");
  await admin.from("connector_leases").delete().eq("connection_id", id);
  const { data: t4 } = await admin.rpc("abo_connector_mint", { p_connection: id });
  check("with nothing left to sync", t4 === null);
} finally {
  if (projectId) await admin.from("projects").delete().eq("id", projectId);
  await admin.auth.admin.deleteUser(owner.id);
  await admin.auth.admin.deleteUser(stranger.id);
}

console.log(failed ? `\n${failed} failed` : "\na store connects its courier, and only its owner does");
process.exit(failed ? 1 : 0);
