// Razorpay and Delhivery, stood in for (lib/connectors/razorpay, delhivery, 0216).
//
// No network: fetch answers as their APIs do. Holds Razorpay's key pair
// as its basic login, paise kept as rupees, a payment on the Shopify
// order it names (and never on Razorpay's own order id), payments then
// settlements walked page by page; Delhivery's token, its times in
// India's time, a parcel delivered, returned or stuck with its reason,
// and the store's own AWBs asked after fifty at a time until none is left.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-razorpay-delhivery.mjs
import { ConnectorBusy, ConnectorRefused } from "../src/lib/connectors/kit.ts";
import * as razorpay from "../src/lib/connectors/razorpay.ts";
import * as delhivery from "../src/lib/connectors/delhivery.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const caught = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

console.log("\nRazorpay");
{
  const wrong = await caught(() => razorpay.login({ key_id: "abc", key_secret: "s" }, async () => json(200, {})));
  check("a key id that is not Razorpay's is refused before any call", wrong instanceof ConnectorRefused);
  const asked = [];
  const ok = await razorpay.login({ key_id: "rzp_live_AbCd1234", key_secret: "sec" }, async (url, init) => {
    asked.push({ url: String(url), auth: init.headers.Authorization });
    return json(200, { items: [] });
  });
  check(
    "the key pair is proved once, as Razorpay's basic login",
    asked.length === 1 &&
      Buffer.from(asked[0].auth.replace("Basic ", ""), "base64").toString() === "rzp_live_AbCd1234:sec"
  );
  check(
    "named without its secret",
    ok.accountLabel === "Razorpay (rzp_live_…1234)" && !ok.accountLabel.includes("sec")
  );
  const refused = await caught(() =>
    razorpay.login({ key_id: "rzp_live_x", key_secret: "bad" }, async () =>
      json(401, { error: { description: "The api key provided is invalid" } })
    )
  );
  check(
    "a refused pair is said in Razorpay's words",
    refused instanceof ConnectorRefused && /invalid/.test(refused.message)
  );

  const row = razorpay.paymentRow({
    id: "pay_1",
    amount: 89900,
    currency: "INR",
    status: "captured",
    method: "upi",
    fee: 1798,
    tax: 324,
    amount_refunded: 0,
    email: "asha@x.in",
    contact: "+919876543210",
    notes: { shopify_order_name: "#1042" },
    created_at: 1760256000,
  });
  check("paise are kept as rupees", row.amount === 899 && row.fee === 17.98 && row.tax === 3.24);
  check("a payment carries the Shopify order its notes name", row.order_ref === "#1042" && row.method === "upi");
  check("and when it was made", row.paid_at === new Date(1760256000 * 1000).toISOString());
  check(
    "never Razorpay's own order id, and the description's order number when the notes name none",
    razorpay.orderRefOf({ notes: { order_id: "order_Abc" }, description: "Payment for Order #1043" }) === "#1043"
  );
  const s = razorpay.settlementRow({
    id: "setl_1",
    amount: 500000,
    fees: 10000,
    tax: 1800,
    utr: "UTR123",
    status: "processed",
    created_at: 1760256000,
  });
  check("a settlement keeps its UTR, in rupees", s.amount === 5000 && s.fees === 100 && s.utr === "UTR123");

  const put = {};
  const cursors = [];
  const calls = [];
  await razorpay.sync(
    { secret: ok.secret, cursors: { payments: { cursor: null, synced_through: "2026-10-10T00:00:00.000Z" } } },
    {
      deadline: Date.now() + 60_000,
      put: async (list, rows) => (put[list] ??= []).push(...rows),
      putCursor: async (resource, cursor, through) => cursors.push({ resource, through }),
    },
    async (url) => {
      const u = new URL(String(url));
      calls.push(u);
      const skip = Number(u.searchParams.get("skip"));
      const kind = u.pathname.includes("payments") ? "pay" : "setl";
      const full = Array.from({ length: 100 }, (_, i) => ({ id: `${kind}_${skip + i}`, amount: 100 }));
      return json(200, { items: skip === 0 ? full : full.slice(0, 5) });
    }
  );
  const pays = calls.filter((u) => u.pathname.endsWith("/payments"));
  check(
    "payments since three days before the last run",
    Number(pays[0].searchParams.get("from")) === Date.parse("2026-10-10T00:00:00.000Z") / 1000 - 3 * 86_400
  );
  check(
    "walked a hundred at a time until a short page",
    pays.length === 2 && pays[1].searchParams.get("skip") === "100"
  );
  check("then settlements the same way", calls.filter((u) => u.pathname.endsWith("/settlements")).length === 2);
  check("each into its own list", put.gateway_payments?.length === 105 && put.gateway_settlements?.length === 105);
  check("then where it got to is kept", cursors.at(-1)?.resource === "payments");
  const busy = await caught(() =>
    razorpay.sync(
      { secret: ok.secret, cursors: {} },
      { deadline: Date.now() + 60_000, put: async () => {}, putCursor: async () => {} },
      async () => json(429, {})
    )
  );
  check("Razorpay's limit is a wait", busy instanceof ConnectorBusy);
}

console.log("\nDelhivery");
{
  check("its times are India's", delhivery.delhiveryTime("2026-10-12T14:33:00") === "2026-10-12T09:03:00.000Z");
  check("unless they say otherwise", delhivery.delhiveryTime("2026-10-12T14:33:00Z") === "2026-10-12T14:33:00.000Z");
  const delivered = delhivery.shipmentRow(
    {
      AWB: "D1",
      ReferenceNo: "#1042",
      Status: { Status: "Delivered", StatusType: "DL", StatusDateTime: "2026-10-12T14:33:00" },
      CODAmount: 899,
    },
    null
  );
  check("a delivered parcel says when", delivered.delivered_at === "2026-10-12T09:03:00.000Z" && !delivered.rto);
  check(
    "on the order it names, as cash on delivery",
    delivered.order_ref === "#1042" && delivered.payment_mode === "cod" && delivered.cod_amount === 899
  );
  const returned = delhivery.shipmentRow({ AWB: "D2", Status: { Status: "RTO", StatusType: "RT" } }, "#1043");
  check(
    "a returned one is RTO, on the order its fulfilment named",
    returned.rto && returned.order_ref === "#1043" && returned.delivered_at === null
  );
  const stuck = delhivery.shipmentRow(
    { AWB: "D3", Status: { Status: "Pending", StatusType: "UD", Instructions: "Consignee unavailable" } },
    null
  );
  check(
    "an attempt that did not land carries its reason",
    stuck.ndr_reason === "Consignee unavailable" && stuck.payment_mode === "prepaid"
  );
  const moving = delhivery.shipmentRow(
    { AWB: "D4", Status: { Status: "In Transit", StatusType: "UD", Instructions: "Shipment picked up" } },
    null
  );
  check("a parcel on its way has no NDR", moving.ndr_reason === null);

  const short = await caught(() => delhivery.login({ token: "abc" }, async () => json(200, {})));
  check("a token too short to be one is refused before any call", short instanceof ConnectorRefused);
  const asked = [];
  const ok = await delhivery.login({ token: "t".repeat(40) }, async (url, init) => {
    asked.push({ url: String(url), auth: init.headers.Authorization });
    return json(200, { ShipmentData: [], Error: "No such waybill or Order Id found" });
  });
  check(
    "a token that answers is kept, as Delhivery's header",
    asked[0].auth === `Token ${"t".repeat(40)}` && !!ok.secret
  );
  const bad = await caught(() =>
    delhivery.login({ token: "x".repeat(40) }, async () => json(401, { Error: "Unauthorized" }))
  );
  check("one it refuses is refused", bad instanceof ConnectorRefused);

  const due = Array.from({ length: 70 }, (_, i) => ({ awb: `AWB${i}`, order_number: `#${1000 + i}` }));
  const askedFor = [];
  const shipments = [];
  const calls = [];
  const { nextMinutes } = await delhivery.sync(
    { secret: ok.secret, cursors: {} },
    {
      deadline: Date.now() + 60_000,
      // The store's own AWBs, least lately asked first; the last batch comes round again.
      carrierAwbs: async (carrier, limit) => {
        askedFor.push([carrier, limit]);
        return askedFor.length === 1 ? due.slice(0, 50) : due.slice(50);
      },
      putShipments: async (rows) => shipments.push(...rows),
    },
    async (url) => {
      const awbs = new URL(String(url)).searchParams.get("waybill").split(",");
      calls.push(awbs.length);
      return json(200, {
        ShipmentData: awbs.map((AWB) => ({ Shipment: { AWB, Status: { Status: "In Transit", StatusType: "UD" } } })),
      });
    }
  );
  check(
    "asks for the store's own Delhivery AWBs, fifty at a time",
    askedFor.every(([c, l]) => c === "delhivery" && l === 50)
  );
  check("each batch tracked in one call", calls.join() === "50,20");
  check("every parcel written, on its order", shipments.length === 70 && shipments[0].order_ref === "#1000");
  check("and it stops once the same ones come round again", askedFor.length === 3 && nextMinutes === 60);
}

if (fails.length) {
  console.error(`\n${fails.length} failed`);
  process.exit(1);
}
console.log("\npayments and parcels are read as Razorpay and Delhivery write them");
