// Browsing the landing never uses up a booking's room (0116).
//
// Every click in the landing's glimpse of the app is an event, and a
// session may write sixty an hour. A booking counted against the same
// sixty was refused after enough curiosity: the lead lost to the
// clicks. Bookings are counted on their own now, with their own cap.
//
// As a visitor writes them: the public key, nobody signed in.
//
//   node scripts/check-landing-cap.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const URL_ = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const visitor = createClient(URL_, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY);
const admin = createClient(URL_, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const session = `chk_cap_${Date.now()}`;
const book = (i) =>
  visitor.from("landing_events").insert({ session_id: session, event: "demo_booked", idem: `cap${i}`, payload: { name: "Cap check" } });

try {
  console.log("a visitor who clicks around, then books");
  const clicks = await visitor
    .from("landing_events")
    .insert(Array.from({ length: 60 }, (_, i) => ({ session_id: session, event: "cta_click", payload: { cta: `preview_${i}` } })));
  check("sixty clicks in an hour are taken", !clicks.error);
  const more = await visitor.from("landing_events").insert({ session_id: session, event: "cta_click" });
  check("the sixty-first is refused", more.error?.code === "53400");
  const first = await book(1);
  check("and a booking still goes through", !first.error);

  console.log("\nand a script that books over and over");
  const next = await Promise.all([2, 3, 4, 5].map(book));
  check("five bookings in an hour are taken", next.every((r) => !r.error));
  const sixth = await book(6);
  check("the sixth is refused", sixth.error?.code === "53400");
} finally {
  await admin.from("landing_events").delete().eq("session_id", session);
}

console.log(fails.length === 0 ? "\nbrowsing never costs a booking" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
