// What a reply's tokens cost, which model made it, and which models an
// account may pick.
//
// Priced from the table in model-prices.ts, never guessed: a model it
// does not list has no price, and a newer minor version is not an older
// one's. The meter (usage.ts) sums each call into the turn it runs in,
// by model and job, and a call outside a turn is not counted. The model
// a turn is made on is one the account may use, or its default.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-model-prices.mjs

import { PRICES, costOf, dollars, modelName, priceOf, tokensShort } from "../src/lib/model-prices.ts";
import { asJob, metered, record } from "../src/lib/usage.ts";
import { lukeSettings, modelFor } from "../src/lib/luke-models.ts";

// Read when called, not when loaded: a replayed run asks no API, and the
// server's model is Opus 5.5 as production's is.
process.env.MODEL_TAPE = "replay";
process.env.ANTHROPIC_MODEL = "claude-opus-5-5";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const near = (a, b) => a !== null && Math.abs(a - b) < 1e-9;

console.log("a model's price");
check("a model by its own name", priceOf("claude-opus-5-5")?.input === 4);
check("a dated snapshot is its model", priceOf("claude-haiku-4-5-20251001")?.name === "Haiku 4.5");
check("a newer version is not an older one's", priceOf("claude-opus-5-7") === null);
check("nor is a name that only starts the same", priceOf("claude-opus-5-5-fast") === null);
check(
  "a model it does not list has none",
  priceOf("Atria-Dawn-Preview") === null && priceOf("gemini-3.6-flash") === null
);
check("and is called what its provider called it", modelName("gemini-3.6-flash") === "gemini-3.6-flash");
check("the listed ones by name", modelName("claude-sonnet-5") === "Sonnet 5");
check(
  "every row reads cache cheaper than input, and output dearest",
  Object.values(PRICES).every((p) => p.cacheRead < p.input && p.input < p.cacheWrite && p.output > p.input)
);

console.log("\nwhat tokens cost");
// 10k fresh, 20k from cache, 1k written to it, 800 out, on Opus 5.5.
const t = { input: 31_000, cacheRead: 20_000, cacheWrite: 1_000, output: 800 };
check("fresh, cached, written and out, each at its own price", near(costOf("claude-opus-5-5", t), 0.065));
check("no price, no cost", costOf("Atria-Dawn-Preview", t) === null);
check("never below nothing when the counts disagree", costOf("claude-haiku-4-5", { ...t, input: 0 }) >= 0);
check("dollars as a small reply needs them", dollars(0.0421) === "$0.042" && dollars(0.0031) === "$0.0031");
check("and a reply too small to say", dollars(0.00001) === "<$0.0001" && dollars(1.234) === "$1.23");
check("tokens short", tokensShort(12_400) === "12.4k" && tokensShort(820) === "820" && tokensShort(2_000_000) === "2M");

console.log("\na turn's meter");
const use = (i, o, read = 0, write = 0) => ({
  inputTokens: i,
  outputTokens: o,
  inputTokenDetails: { cacheReadTokens: read, cacheWriteTokens: write },
});
record("anthropic", "claude-opus-5-5", use(100, 10));
const [answer, took] = await metered(async () => {
  record("anthropic", "claude-opus-5-5", use(10_000, 500, 6_000));
  // A repair on the same model: one row, two calls.
  record("anthropic", "claude-opus-5-5", use(12_000, 700, 6_000));
  await asJob("gap", async () => record("anthropic", "claude-haiku-4-5-20251001", use(900, 40)));
  record("jev", "jev-1.13.0", { inputTokens: 300, outputTokens: 20 }, "route");
  record("anthropic", "claude-opus-5-5", { inputTokens: Number.MAX_SAFE_INTEGER * 2, outputTokens: -5 });
  return "done";
});
const u = took();
const reply = u?.uses.find((x) => x.job === "reply");
check("the turn's own answer comes back", answer === "done");
check("a call outside a turn is not counted", reply?.input === 22_000);
check(
  "calls of one model and job are one row",
  reply?.calls === 3 && reply?.output === 1_200 && reply?.cacheRead === 12_000
);
check("a count that is not one counts nothing", reply?.input === 22_000 && reply?.output === 1_200);
check(
  "the gap pass apart, on its own model",
  u?.uses.some((x) => x.job === "gap" && x.model.startsWith("claude-haiku"))
);
check("the reply's model is the one that made it", u?.model === "claude-opus-5-5");
check(
  "an unpriced router is said, not priced",
  u?.partial === true && u.uses.find((x) => x.job === "route")?.usd === null
);
check(
  "and the rest is priced",
  near(u?.usd ?? null, (reply?.usd ?? 0) + (u?.uses.find((x) => x.job === "gap")?.usd ?? 0)) && (u?.usd ?? 0) > 0
);
const [, nothing] = await metered(async () => "no calls");
check("a turn that made no call has no usage", nothing() === null);
check("a job outside a turn simply runs", (await asJob("gap", async () => 7)) === 7);

console.log("\nwhich model a turn is made on");
const client = (row, error = null) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }) }) }),
});
const all = await lukeSettings(client(null), "u");
check("an account nobody set sees everything on offer", all.shows === "cost" && all.models.length >= 3);
check("with the server's model the default", all.default === "claude-opus-5-5" && all.server === "claude-opus-5-5");
check("a model on offer is used when asked for", modelFor(all, "claude-sonnet-5") === "claude-sonnet-5");
check("one not on offer is not", modelFor(all, "claude-opus-4-1") === "claude-opus-5-5");
check("nor is anything that is not a name", modelFor(all, { id: "claude-sonnet-5" }) === "claude-opus-5-5");
const cut = await lukeSettings(client({ luke_models: ["claude-haiku-4-5"], luke_shows: "model" }), "u");
check(
  "a list cuts the offer to it",
  cut.models.map((m) => m.id).join() === "claude-haiku-4-5" && cut.shows === "model"
);
check("and its default is on it", cut.default === "claude-haiku-4-5");
check("a model off their list is never used", modelFor(cut, "claude-opus-5-5") === "claude-haiku-4-5");
const gone = await lukeSettings(client({ luke_models: ["claude-opus-4-1"], luke_shows: "tokens" }), "u");
check("a list with nothing left on offer answers on the server's model", gone.default === "claude-opus-5-5");
const unread = await lukeSettings(client(null, { message: "down" }), "u");
check(
  "settings that cannot be read give the server's model alone",
  unread.models.map((m) => m.id).join() === "claude-opus-5-5" && unread.shows === "model"
);
const odd = await lukeSettings(client({ luke_models: null, luke_shows: "everything" }), "u");
check("a word it does not know shows the cost, the default", odd.shows === "cost");

console.log(fails.length === 0 ? "\npriced from the table, counted by the turn" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
