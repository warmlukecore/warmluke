// A second opinion that changes nothing, and the ways it has to stay
// that way: no key means no call, a slow or broken answer means no
// verdict, and what it asks is one question per line the design left
// out — never more than the six anyone reads.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-judge.mjs
//
// With TYPESAFE_API_KEY in the environment or in the env file, one
// real call goes out at the end and its numbers are printed rather
// than pinned — a probability is not a fixture. Without it, that part
// is skipped and says so.

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { describeBuild, judgeDesign } from "../src/lib/judge.ts";
import { NOT_SUPPORTED } from "../src/lib/capabilities.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const realKey = process.env.TYPESAFE_API_KEY ?? "";

/** A Jev that answers however the test says, and keeps what it was asked. */
function fakeJev(reply) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ auth: req.headers.authorization ?? "", body: JSON.parse(body) });
      if (reply.hang) return;
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      process.env.TYPESAFE_API_URL = `http://127.0.0.1:${server.address().port}/v1/systemone`;
      resolve({
        seen,
        close: () => {
          server.closeAllConnections();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}
const answers = (n, addresses = 0.8) => {
  const a = { addresses: { type: "noul", noul: addresses } };
  for (let i = 0; i < n; i++) a[`unmet_${i}`] = { type: "noul", noul: 0.1 * (i + 1) };
  return { model: "jev-1.13.0", answers: a, usage: { input_tokens: 400, output_tokens: 40 } };
};
const design = {
  request: "add a Checked By field to Packing",
  built: "Add fields to Packing\n  New: Checked By",
  unmet: [],
};

console.log("without a key");
{
  delete process.env.TYPESAFE_API_KEY;
  const jev = await fakeJev({ body: answers(0) });
  check("there is no verdict", (await judgeDesign(design)) === null);
  check("and nothing was sent anywhere", jev.seen.length === 0);
  await jev.close();
}

process.env.TYPESAFE_API_KEY = "check-key-not-real";

console.log("\na design and what it left out");
{
  const jev = await fakeJev({ body: answers(2, 0.83) });
  const unmet = ["send them a WhatsApp", "a total per customer"];
  const out = await judgeDesign({ ...design, unmet });
  check("one probability for the request", out?.addresses === 0.83);
  check("and one per unmet line, in order", JSON.stringify(out?.unmet) === "[0.1,0.2]");
  check("the model that answered is what is written", out?.model === "jev-1.13.0");
  const sent = jev.seen[0];
  check(
    "the key travels as a bearer and nowhere else",
    sent.auth === "Bearer check-key-not-real" && !JSON.stringify(sent.body).includes("check-key-not-real")
  );
  check("one question per unmet line, plus one", Object.keys(sent.body.questions).length === 3);
  check(
    "the owner's words and the build are what is judged",
    sent.body.state.owner_said === design.request && sent.body.state.will_be_built === design.built
  );
  check(
    "what cannot be built is the real list, not a copy",
    NOT_SUPPORTED.every((n) => sent.body.state.abilities.cannot.includes(n.label))
  );
  check(
    "and what can comes from the declarations",
    sent.body.state.abilities.can.stats.some((s) => s.startsWith("max"))
  );
  await jev.close();
}

console.log("\nmore lines than anyone reads");
{
  const jev = await fakeJev({ body: answers(6) });
  const out = await judgeDesign({ ...design, unmet: Array.from({ length: 9 }, (_, i) => `line ${i}`) });
  check(
    "six are asked about, not nine",
    Object.keys(jev.seen[0].body.questions).length === 7 && out?.unmet.length === 6
  );
  await jev.close();
}

console.log("\nwhen the judge is not there");
{
  const jev = await fakeJev({ status: 429, body: { error: "slow down" } });
  check("a refusal is no verdict", (await judgeDesign(design)) === null);
  await jev.close();
}
{
  const jev = await fakeJev({ body: "<html>bad gateway</html>" });
  check("a page instead of JSON is no verdict", (await judgeDesign(design)) === null);
  await jev.close();
}
{
  const jev = await fakeJev({ body: { answers: { addresses: { noul: "yes" } } } });
  check("a wrong shape is no verdict", (await judgeDesign(design)) === null);
  await jev.close();
}
{
  const jev = await fakeJev({ body: { answers: { addresses: { noul: 1.7 } } } });
  check("a probability outside 0..1 is no verdict", (await judgeDesign(design)) === null);
  await jev.close();
}
{
  const jev = await fakeJev({ body: answers(0) });
  check("an answer with a hole in it is no verdict", (await judgeDesign({ ...design, unmet: ["x"] })) === null);
  await jev.close();
}
{
  const jev = await fakeJev({ hang: true });
  const t0 = Date.now();
  const out = await judgeDesign(design, 300);
  check("a slow one is given up on", out === null && Date.now() - t0 < 2000);
  await jev.close();
}

console.log("\nwhat the judge is shown");
{
  const plan = {
    changeType: "FIELD_ADD",
    targetModuleId: "m1",
    newModule: null,
    newSchema: { columns: [{ field: "checked_by", label: "Checked By", type: "text" }] },
    moduleUpdate: null,
    deleteConfirmName: null,
    features: null,
    automation: null,
    automationRemoveName: null,
    newRecords: null,
    explanation: "",
  };
  const text = describeBuild([plan], [{ id: "m1", nav_label: "Packing" }]);
  check("names the section and the field, as the card does", /Packing/.test(text) && /Checked By/.test(text));
}

console.log("\nand once, for real");
{
  delete process.env.TYPESAFE_API_URL;
  const envFile = new URL(`../${process.env.ENV_FILE ?? ".env.local"}`, import.meta.url);
  const fromFile = existsSync(envFile)
    ? (readFileSync(envFile, "utf8")
        .match(/^TYPESAFE_API_KEY=(.+)$/m)?.[1]
        ?.trim() ?? "")
    : "";
  const key = realKey || fromFile;
  if (!key) {
    console.log("  skip  no TYPESAFE_API_KEY — the real call was not made");
  } else {
    process.env.TYPESAFE_API_KEY = key;
    const out = await judgeDesign({
      ...design,
      unmet: ["send the customer a WhatsApp when it ships", "a Checked By text field"],
    });
    check("a verdict came back", out !== null);
    if (out) {
      console.log(
        `  →     addresses ${out.addresses.toFixed(2)} · could-build [${out.unmet.map((p) => p.toFixed(2)).join(", ")}] · ${out.model} · ${out.ms}ms`
      );
      check("the build that does what was asked reads as doing it", out.addresses > 0.5);
      check("messaging reads as not buildable", out.unmet[0] < 0.5);
      check("a text field reads as buildable", out.unmet[1] > 0.5);
    }
  }
}

console.log(fails.length === 0 ? "\nthe judge only watches" : `\n${fails.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
