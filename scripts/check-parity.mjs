// Every door a merchant has, Luke and their own AI have too, or the
// registry says why not (lib/parity.ts, docs/ai-builder/parity.md).
//
// Reads the code for doors: each API route method, each database function
// a screen calls, each table a screen writes straight to. Fails on a door
// parity.ts does not list, an entry that matches no door any more, a tool
// named there that neither Luke nor MCP has, and an entry with neither
// tools nor a reason. A new screen action is written down before it ships.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-parity.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DOORS, covers } from "../src/lib/parity.ts";
import { STORE_TOOLS } from "../src/lib/store-tools.ts";
import { appTools } from "../src/lib/section-read.ts";
import { appActionTools } from "../src/lib/app-actions.ts";

const root = new URL("..", import.meta.url).pathname;
const fails = [];
const check = (name, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

// ── The doors, from the code ─────────────────────────────────
const doors = new Set();
for (const f of walk(join(root, "src/app/api")).filter((p) => p.endsWith("/route.ts"))) {
  const path = "/" + relative(join(root, "src/app"), f).replace(/\/route\.ts$/, "");
  for (const m of readFileSync(f, "utf8").matchAll(/export (?:async )?function (GET|POST|PATCH|PUT|DELETE)\b/g))
    doors.add(`${m[1]} ${path}`);
}
const screens = [
  ...walk(join(root, "src/components")),
  ...walk(join(root, "src/app")).filter((p) => !p.includes("/api/")),
].filter((p) => /\.(tsx?|jsx?)$/.test(p));
for (const f of screens) {
  const s = readFileSync(f, "utf8");
  for (const m of s.matchAll(/rpc\(\s*"(abo_[a-z_]+)"/g)) doors.add(`rpc ${m[1]}`);
  for (const m of s.matchAll(/from\(\s*"([a-z_]+)"\s*\)\s*\.\s*(?:insert|update|delete|upsert)\b/g))
    doors.add(`write ${m[1]}`);
}

// ── The tools, from the code ─────────────────────────────────
const nobody = { db: null, projectId: "" };
const luke = new Set([
  ...STORE_TOOLS.map((t) => t.name),
  ...Object.keys(appTools(nobody)),
  ...Object.keys(appActionTools(nobody)),
  "propose_store_action",
  // His design reply: plans the owner approves on its card.
  "design",
]);
const mcpSource = readFileSync(join(root, "src/app/api/mcp/route.ts"), "utf8");
const list = mcpSource.slice(mcpSource.indexOf("const TOOLS = ["), mcpSource.indexOf("] as const;"));
const mcp = new Set([
  ...[...list.matchAll(/^\s{4}name: "([a-z_]+)",/gm)].map((m) => m[1]),
  ...(list.includes("...STORE_TOOLS") ? STORE_TOOLS.map((t) => t.name) : []),
]);
try {
  const { TEST_BUILD } = await import("../src/lib/verify-tool.ts");
  luke.add(TEST_BUILD.name);
  if (list.includes("TEST_BUILD.name")) mcp.add(TEST_BUILD.name);
} catch {
  // No test tool in this tree.
}

console.log(`\n${doors.size} doors found; ${luke.size} tools for Luke, ${mcp.size} for their own AI`);

console.log("\nevery door is written down");
const unlisted = [...doors].filter((d) => !DOORS.some((e) => covers(e.door, d)));
check("each door the code has is in lib/parity.ts", unlisted.length === 0);
for (const d of unlisted) console.log(`     → ${d}`);
const stale = DOORS.filter((e) => ![...doors].some((d) => covers(e.door, d)));
check("and each entry there is a door the code still has", stale.length === 0);
for (const e of stale) console.log(`     → ${e.door}`);

console.log("\nwhat each door has");
const reasonless = DOORS.filter((e) => !(e.luke?.length && e.mcp?.length) && !e.why?.trim());
check("Luke and their AI both have it, or the entry says why not", reasonless.length === 0);
for (const e of reasonless) console.log(`     → ${e.door}`);
const noLuke = DOORS.flatMap((e) => (e.luke ?? []).filter((t) => !luke.has(t)).map((t) => `${e.door}: ${t}`));
check("every tool named for Luke is his", noLuke.length === 0);
for (const t of noLuke) console.log(`     → ${t}`);
const noMcp = DOORS.flatMap((e) => (e.mcp ?? []).filter((t) => !mcp.has(t)).map((t) => `${e.door}: ${t}`));
check("every tool named for their own AI is theirs", noMcp.length === 0);
for (const t of noMcp) console.log(`     → ${t}`);

console.log("\nthe hands");
check("Luke can ask to change rows, and read what waits", luke.has("change_rows") && luke.has("whats_waiting"));
check(
  "and so can their own AI, through the same door",
  mcp.has("propose_row_change") && mcp.has("whats_waiting") && /proposeRowChange\(/.test(mcpSource)
);

console.log(fails.length === 0 ? "\nnothing a merchant does that an AI cannot, unsaid" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
