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
import { MODEL_OUTPUT_CHARS, STORE_TOOLS, aiStoreTools, fitForModel, storeTool } from "../src/lib/store-tools.ts";
import { STORE_TABLES } from "../src/lib/store-read.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

// Touching this is the failure: a refusal must come before any read.
const untouchable = new Proxy(
  {},
  {
    get: (_t, key) => {
      throw new Error(`the database was read (${String(key)})`);
    },
  }
);
const ctx = {
  db: untouchable,
  store: {
    id: "s1",
    project_id: "p1",
    shop_domain: "bishop.myshopify.com",
    timezone: "Asia/Kolkata",
    currency: "INR",
    last_synced_at: null,
  },
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
check(
  "the six reading tools, in the order clients are shown them",
  JSON.stringify(STORE_TOOLS.map((t) => t.name)) === JSON.stringify(NAMES)
);
check(
  "each found by its name, and nothing else",
  NAMES.every((n) => storeTool(n)?.name === n) && !storeTool("propose_change") && !storeTool(undefined)
);
check(
  "every schema is an object a model can fill in",
  STORE_TOOLS.every(
    (t) => t.inputSchema.type === "object" && (t.inputSchema.required ?? []).every((r) => r in t.inputSchema.properties)
  )
);
check(
  "and none asks which store: the caller settles that",
  STORE_TOOLS.every((t) => !("shop_domain" in t.inputSchema.properties))
);
check(
  "search_store offers every list the store holds",
  JSON.stringify(storeTool("search_store").inputSchema.properties.table.enum) ===
    JSON.stringify(Object.keys(STORE_TABLES))
);

console.log("\nthe MCP route sends that list, not a copy");
{
  const route = readFileSync(new URL("../src/app/api/mcp/route.ts", import.meta.url), "utf8");
  check("its tool list is the shared one", /\.\.\.STORE_TOOLS\.map\(forMcp\)/.test(route));
  check(
    "with no second definition of any of them",
    NAMES.every((n) => !route.includes(`name: "${n}"`))
  );
  check(
    "and no second handler",
    NAMES.every((n) => !route.includes(`name === "${n}"`)) && /storeTool\(name\)/.test(route)
  );
}

console.log("\na bad argument is refused in a sentence, before any read");
check(
  "a question is needed",
  (await run("ask_store", { question: "  " })).error === "What do you want to know? Pass question."
);
check(
  "a day that is not a date is refused, not ignored",
  /is not a date/.test((await run("search_orders", { day: "14/09/2026" })).error ?? "")
);
check(
  "an order needs a number",
  (await run("get_order", { order_number: "" })).error === "Which order? Pass order_number."
);
const wrongList = await run("search_store", { table: "secrets" });
check(
  "a list the store does not have is named, with the ones it does",
  /not one of the store's lists/.test(wrongList.error ?? "") &&
    wrongList.available?.length === Object.keys(STORE_TABLES).length
);
check("a threshold below zero is refused", /0 or more/.test((await run("low_stock", { threshold: -1 })).error ?? ""));
check(
  "and so is one that is not a number",
  /0 or more/.test((await run("low_stock", { threshold: "lots" })).error ?? "")
);

console.log("\nthe same tools, as the AI SDK takes them");
const ai = aiStoreTools(ctx);
check("one AI SDK tool per store tool, same names", JSON.stringify(Object.keys(ai)) === JSON.stringify(NAMES));
check(
  "each carries its description and schema",
  NAMES.every((n) => ai[n].description === storeTool(n).description && ai[n].inputSchema)
);
const viaSdk = await ai.low_stock.execute({ threshold: -1 }, { toolCallId: "t1", messages: [] });
check(
  "and answers exactly as the shared tool does",
  JSON.stringify(viaSdk) === JSON.stringify(await run("low_stock", { threshold: -1 }))
);

console.log("\nwhat a lookup is called, for the merchant");
const about = (n, a) => storeTool(n).about(a);
check(
  "an order, by its number, with or without the #",
  about("get_order", { order_number: "#1042" }) === "order #1042" &&
    about("get_order", { order_number: "1042" }) === "order #1042"
);
check(
  "orders by what was asked",
  about("search_orders", { day: "2026-09-20" }) === "orders on 2026-09-20" &&
    about("search_orders", { q: "Asha" }) === "orders matching “Asha”" &&
    about("search_orders", {}) === "the latest orders"
);
check(
  "a list, and what was searched in it",
  about("search_store", { table: "products", q: "linen" }) === "products matching “linen”"
);
check(
  "stock, at the threshold asked",
  about("low_stock", { threshold: 0 }) === "stock at or below 0" && about("low_stock", {}) === "stock at or below 5"
);
check(
  "and nothing odd for arguments that are not there",
  STORE_TOOLS.every((t) => typeof t.about({}) === "string" && t.about({}).length > 0)
);

console.log("\nan answer too long for a model is cut, and says so");
const rows = Array.from({ length: 400 }, (_, i) => ({ n: i, title: "x".repeat(200) }));
const fitted = fitForModel({ table: "products", matched: 400, rows });
check("it fits", JSON.stringify(fitted).length <= MODEL_OUTPUT_CHARS);
check(
  "it keeps the rows it can, from the top",
  fitted.rows.length > 0 && fitted.rows.length < 400 && fitted.rows[0].n === 0
);
check(
  "and says how many of how many",
  new RegExp(`first ${fitted.rows.length} of 400 rows`).test(fitted.trimmed ?? "")
);
check("the numbers beside the list are untouched", fitted.matched === 400 && fitted.table === "products");
const small = { count: 2, rows: [1, 2] };
check("a short answer is left exactly as it was", fitForModel(small) === small);

console.log("\nLuke's view of them");
const heard = [];
const luke = aiStoreTools(ctx, { only: ["get_order", "low_stock"], observe: (l) => heard.push(l) });
check("only the tools asked for", JSON.stringify(Object.keys(luke)) === JSON.stringify(["get_order", "low_stock"]));
await luke.get_order.execute({ order_number: "" }, { toolCallId: "t2", messages: [] });
check(
  "each lookup is heard once it has run, in words",
  heard.length === 1 && heard[0].tool === "get_order" && heard[0].about === "order #?" && heard[0].result?.error
);
const loud = aiStoreTools(ctx, {
  observe: () => {
    throw new Error("listener broke");
  },
});
const stillAnswers = await loud.low_stock.execute({ threshold: -1 }, { toolCallId: "t3", messages: [] });
check("and a listener that throws does not take the lookup with it", /0 or more/.test(stillAnswers?.error ?? ""));

console.log(fails.length === 0 ? "\nthe store's tools are declared once" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
