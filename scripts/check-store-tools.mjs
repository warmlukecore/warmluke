// The store's reading tools are declared once, and say no before they read.
//
// A merchant's own assistant (MCP) and Luke call the same six tools from
// src/lib/store-tools.ts. This holds that there is one list, that the
// MCP route sends it rather than a copy, that each schema is one a model
// can fill in, and that a bad argument is refused in a sentence before
// the database is touched: the stand-in database here throws if a tool
// reaches it.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-store-tools.mjs

import { readFileSync } from "node:fs";
import { STORE_TOOLS, aiStoreTools, storeTool } from "../src/lib/store-tools.ts";
import { STORE_TABLES } from "../src/lib/store-read.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// Touching this is the failure: a refusal must come before any read.
const untouchable = new Proxy({}, { get: (_t, key) => { throw new Error(`the database was read (${String(key)})`); } });
const ctx = {
  db: untouchable,
  store: { id: "s1", project_id: "p1", shop_domain: "bishop.myshopify.com", timezone: "Asia/Kolkata", currency: "INR", last_synced_at: null },
};
const run = async (name, args) => {
  try {
    return await storeTool(name).run(args, ctx);
  } catch (e) {
    return { threw: e.message };
  }
};

console.log("one list");
const NAMES = ["ask_store", "store_overview", "search_orders", "get_order", "search_store", "low_stock"];
check("the six reading tools, in the order clients are shown them", JSON.stringify(STORE_TOOLS.map((t) => t.name)) === JSON.stringify(NAMES));
check("each found by its name, and nothing else", NAMES.every((n) => storeTool(n)?.name === n) && !storeTool("propose_change") && !storeTool(undefined));
check(
  "every schema is an object a model can fill in",
  STORE_TOOLS.every((t) => t.inputSchema.type === "object" && (t.inputSchema.required ?? []).every((r) => r in t.inputSchema.properties))
);
check("and none asks which store: the caller settles that", STORE_TOOLS.every((t) => !("shop_domain" in t.inputSchema.properties)));
check(
  "search_store offers every list the store holds",
  JSON.stringify(storeTool("search_store").inputSchema.properties.table.enum) === JSON.stringify(Object.keys(STORE_TABLES))
);

console.log("\nthe MCP route sends that list, not a copy");
{
  const route = readFileSync(new URL("../src/app/api/mcp/route.ts", import.meta.url), "utf8");
  check("its tool list is the shared one", /\.\.\.STORE_TOOLS\.map\(forMcp\)/.test(route));
  check("with no second definition of any of them", NAMES.every((n) => !route.includes(`name: "${n}"`)));
  check("and no second handler", NAMES.every((n) => !route.includes(`name === "${n}"`)) && /storeTool\(name\)/.test(route));
}

console.log("\na bad argument is refused in a sentence, before any read");
check("a question is needed", (await run("ask_store", { question: "  " })).error === "What do you want to know? Pass question.");
check("a day that is not a date is refused, not ignored", /is not a date/.test((await run("search_orders", { day: "14/09/2026" })).error ?? ""));
check("an order needs a number", (await run("get_order", { order_number: "" })).error === "Which order? Pass order_number.");
const wrongList = await run("search_store", { table: "secrets" });
check("a list the store does not have is named, with the ones it does", /not one of the store's lists/.test(wrongList.error ?? "") && wrongList.available?.length === Object.keys(STORE_TABLES).length);
check("a threshold below zero is refused", /0 or more/.test((await run("low_stock", { threshold: -1 })).error ?? ""));
check("and so is one that is not a number", /0 or more/.test((await run("low_stock", { threshold: "lots" })).error ?? ""));

console.log("\nthe same tools, as the AI SDK takes them");
const ai = aiStoreTools(ctx);
check("one AI SDK tool per store tool, same names", JSON.stringify(Object.keys(ai)) === JSON.stringify(NAMES));
check("each carries its description and schema", NAMES.every((n) => ai[n].description === storeTool(n).description && ai[n].inputSchema));
const viaSdk = await ai.low_stock.execute({ threshold: -1 }, { toolCallId: "t1", messages: [] });
check("and answers exactly as the shared tool does", JSON.stringify(viaSdk) === JSON.stringify(await run("low_stock", { threshold: -1 })));

console.log(fails.length === 0 ? "\nthe store's tools are declared once" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
