// How a merchant connects the AI they already use (lib/connect-assistants):
// ChatGPT and Claude by name, any other MCP assistant by the rule, and
// every one of them handed this app's own address, or pointed at it. Pure.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-connect-assistants.mjs

import { ASSISTANTS } from "../src/lib/connect-assistants.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const address = "https://example.test/api/mcp";

console.log("\nthe assistants a merchant may already use");
for (const name of ["ChatGPT", "Claude"])
  check(
    `${name} is there`,
    ASSISTANTS.some((a) => a.name === name)
  );
check("and any other, by the rule", ASSISTANTS.at(-1)?.id === "any");
check("each once", new Set(ASSISTANTS.map((a) => a.id)).size === ASSISTANTS.length);
for (const a of ASSISTANTS) {
  const steps = a.steps(address);
  // The address itself, or where to paste the one shown above the list.
  check(
    `${a.name}: steps, and this app's address in one of them`,
    steps.some((s) => s.copy?.includes(address) || /\bthe address\b/.test(s.text))
  );
}
check(
  "ChatGPT's say it needs Developer mode and a sign-in",
  ASSISTANTS.find((a) => a.id === "chatgpt")
    ?.steps(address)
    .some((s) => /Developer mode/.test(s.text)) &&
    ASSISTANTS.find((a) => a.id === "chatgpt")
      ?.steps(address)
      .some((s) => /OAuth/.test(s.text))
);

console.log(fails.length === 0 ? "\nany assistant can be connected, and is told how" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
