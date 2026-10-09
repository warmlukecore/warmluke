import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { leadEventId, leadPayload, sendMetaLead } from "../src/lib/meta-conversions.ts";
import { initMetaPixel, trackMetaLead } from "../src/lib/meta-pixel.ts";
import { chooseMeasure } from "../src/lib/consent.ts";
import { followAnalyticsChoice } from "../src/lib/google-analytics.ts";

const lead = {
  eventId: leadEventId("session", "submission"),
  eventTime: 1791540000,
  email: "  OWNER@EXAMPLE.COM ",
  sourceUrl: "https://example.com/",
  fbp: "fb.1.1791540000000.123",
  fbc: "fb.1.1791540000000.real-click",
  ip: "203.0.113.1",
  userAgent: "Test browser",
};
const payload = leadPayload(lead);
assert.equal(payload.event_name, "Lead");
assert.equal(payload.action_source, "website");
assert.equal(payload.user_data.em[0], createHash("sha256").update("owner@example.com").digest("hex"));
assert.equal(payload.user_data.fbc, lead.fbc);
assert.equal(payload.user_data.fbp, lead.fbp);
assert.equal(payload.user_data.client_ip_address, lead.ip);
assert.equal(leadEventId("session", "submission"), lead.eventId);
assert.notEqual(leadEventId("other-session", "submission"), lead.eventId);
assert.equal(leadPayload({ ...lead, fbc: "invalid", ip: "forged" }).user_data.fbc, undefined);
assert.equal(leadPayload({ ...lead, ip: "forged" }).user_data.client_ip_address, undefined);
assert.ok(!JSON.stringify(payload).includes("OWNER@"));

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const savedEnv = { ...process.env };
const warnings = [];
console.warn = (...args) => warnings.push(JSON.stringify(args));
const calls = [];
try {
  delete process.env.NEXT_PUBLIC_META_PIXEL_ID;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return Response.json({ events_received: 1 });
  };
  await sendMetaLead(lead);
  assert.equal(calls.length, 0);
  process.env.NEXT_PUBLIC_META_PIXEL_ID = "123456";
  process.env.META_CAPI_ACCESS_TOKEN = "private-token";
  process.env.META_CAPI_TEST_EVENT_CODE = "TEST123";
  delete process.env.META_GRAPH_API_VERSION;
  await sendMetaLead(lead);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://graph.facebook.com/v26.0/123456/events");
  assert.equal(calls[0][1].headers.Authorization, "Bearer private-token");
  assert.equal(JSON.parse(calls[0][1].body).test_event_code, "TEST123");
  calls.length = 0;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return calls.length === 1
      ? Response.json({ error: { code: 2 } }, { status: 503 })
      : Response.json({ events_received: 1 });
  };
  await sendMetaLead(lead);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].body, calls[1][1].body);
  calls.length = 0;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return Response.json({ error: { code: 190 } }, { status: 400 });
  };
  await sendMetaLead(lead);
  assert.equal(calls.length, 1);
  globalThis.fetch = async () => {
    throw Error("private-token owner@example.com");
  };
  await sendMetaLead(lead);
  assert.ok(warnings.length);
  assert.ok(!warnings.join().includes("private-token"));
  assert.ok(!warnings.join().includes("owner@example.com"));

  // Execute the real booking action with only its external boundaries replaced.
  const harness = { after: [], rpc: [], error: null, headers: new Headers(), cookies: new Map() };
  globalThis.metaTestHarness = harness;
  const bundled = await build({
    entryPoints: ["src/app/actions.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "booking-boundaries",
        setup(b) {
          b.onResolve({ filter: /^(next\/headers|next\/server|@supabase\/supabase-js)$/ }, (args) => ({
            path: args.path,
            namespace: "mock",
          }));
          b.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
            contents:
              args.path === "next/server"
                ? "export const after = fn => globalThis.metaTestHarness.after.push(fn);"
                : args.path === "next/headers"
                  ? "export const headers = async () => globalThis.metaTestHarness.headers; export const cookies = async () => ({get: name => {const value=globalThis.metaTestHarness.cookies.get(name); return value ? {value} : undefined;}});"
                  : "export const createClient = () => ({rpc: async (...args) => {globalThis.metaTestHarness.rpc.push(args); return {error: globalThis.metaTestHarness.error};}});",
          }));
        },
      },
    ],
  });
  const { bookDemo } = await import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  );
  process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY = "mock-anon";
  process.env.BOOKING_KEY = "mock-booking";
  process.env.META_EVENT_SOURCE_URL = "https://example.com/?email=private#fragment";
  delete process.env.TURNSTILE_SECRET_KEY;
  const form = new FormData();
  for (const [k, v] of Object.entries({
    name: "Owner",
    email: "owner@example.com",
    business: "Test",
    store: "https://shop.example",
    session_id: "session",
    idem: "submission",
    meta_consent: "1",
  }))
    form.set(k, v);
  const invalid = new FormData();
  assert.equal((await bookDemo({ ok: false }, invalid)).ok, false);
  assert.equal(harness.after.length, 0);
  harness.error = { code: "42501" };
  assert.equal((await bookDemo({ ok: false }, form)).ok, false);
  assert.equal(harness.after.length, 0);
  harness.error = { code: "23505" };
  assert.equal((await bookDemo({ ok: false }, form)).eventId, lead.eventId);
  assert.equal(harness.after.length, 0);
  harness.error = null;
  calls.length = 0;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return Response.json({ events_received: 1 });
  };
  harness.cookies.set("_fbp", lead.fbp);
  harness.cookies.set("_fbc", lead.fbc);
  harness.headers.set("x-vercel-forwarded-for", lead.ip);
  assert.equal((await bookDemo({ ok: false }, form)).eventId, lead.eventId);
  assert.equal(calls.length, 0, "delivery does not block booking response");
  await harness.after.pop()();
  assert.equal(calls.length, 1);
  const delivered = JSON.parse(calls[0][1].body).data[0];
  assert.equal(delivered.event_source_url, "https://example.com/");
  assert.equal(delivered.event_id, lead.eventId);
  assert.equal(delivered.user_data.fbp, lead.fbp);
  for (const header of ["dnt", "sec-gpc"]) {
    harness.headers.set(header, "1");
    await bookDemo({ ok: false }, form);
    await harness.after.pop()();
    harness.headers.delete(header);
    assert.equal(calls.length, 1);
  }
  // Opt-in: a form that does not carry the visitor's yes sends nothing,
  // whether they said no, were never asked, or had no script.
  for (const given of ["", "0", null]) {
    if (given === null) form.delete("meta_consent");
    else form.set("meta_consent", given);
    await bookDemo({ ok: false }, form);
    await harness.after.pop()();
    assert.equal(calls.length, 1, `no Lead without a yes (meta_consent=${given})`);
  }
  delete globalThis.metaTestHarness;

  // Browser queue and deduplication, including delayed/blocked script loading.
  const scripts = [];
  const stored = new Map();
  globalThis.window = { dispatchEvent: () => true };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k) => stored.get(k) ?? null,
      setItem: (k, v) => stored.set(k, v),
      removeItem: (k) => stored.delete(k),
    },
  });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { doNotTrack: "0" } });
  globalThis.document = { createElement: () => ({}), head: { appendChild: (el) => scripts.push(el) } };
  // Never asked, or a no: nothing loads.
  initMetaPixel();
  assert.equal(scripts.length, 0, "no Pixel before the visitor answers");
  chooseMeasure("no");
  initMetaPixel();
  assert.equal(scripts.length, 0, "no Pixel after No thanks");
  // A yes the browser overrules: still nothing.
  chooseMeasure("yes");
  globalThis.navigator.doNotTrack = "1";
  initMetaPixel();
  assert.equal(scripts.length, 0, "Do Not Track wins over a yes");
  globalThis.navigator.doNotTrack = "0";
  initMetaPixel();
  initMetaPixel();
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, "https://connect.facebook.net/en_US/fbevents.js");
  trackMetaLead(lead.eventId);
  trackMetaLead(lead.eventId);
  const leads = window.fbq.queue.filter((args) => args[1] === "Lead");
  assert.equal(leads.length, 1);
  assert.deepEqual(leads[0], ["track", "Lead", {}, { eventID: lead.eventId }]);
  navigator.globalPrivacyControl = true;
  trackMetaLead("other");
  assert.equal(window.fbq.queue.filter((args) => args[1] === "Lead").length, 1);

  // Google Analytics waits on the same yes, and a no sets Google's own off switch.
  navigator.globalPrivacyControl = false;
  process.env.NEXT_PUBLIC_GA_ID = "G-TEST123";
  chooseMeasure("no");
  followAnalyticsChoice();
  assert.equal(window["ga-disable-G-TEST123"], true);
  assert.equal(window.gtag, undefined, "no Google tag on a no");
  chooseMeasure("yes");
  followAnalyticsChoice();
  assert.equal(window["ga-disable-G-TEST123"], false);
  assert.ok(scripts.some((s) => s.src === "https://www.googletagmanager.com/gtag/js?id=G-TEST123"));
  assert.deepEqual([...window.dataLayer.at(-1)], ["config", "G-TEST123"]);
  chooseMeasure("no");
  followAnalyticsChoice();
  assert.equal(window["ga-disable-G-TEST123"], true);
  assert.deepEqual([...window.dataLayer.at(-1)], ["consent", "update", { analytics_storage: "denied" }]);
  console.log(
    "Meta conversions: payload, booking success/failure/duplicate, opt-out, retries, and browser deduplication passed"
  );
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
}
