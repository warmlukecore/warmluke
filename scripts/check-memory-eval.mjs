// What Luke learns from three exchanges, on a real model.
//
// Two turns that say something about the business (couriers and when
// the money comes; who packs and when) and one that only answers from
// the store. The learner should keep facts from the first two and
// nothing from the third. Model tier: real calls, by hand, on a
// throwaway project of the check database, when the learner's prompt
// or model changes.
//
//   ENV_FILE=.env.check.local ANTHROPIC_MEMORY_MODEL=… node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-memory-eval.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "./owner-session.mjs";
import { memoryModel } from "../src/lib/ai.ts";
import { learn, notesFor } from "../src/lib/memory.ts";

const model = memoryModel();
if (!model) {
  console.log("ANTHROPIC_MEMORY_MODEL is not set; nothing checked");
  process.exit(0);
}
const envFile = process.env.ENV_FILE ?? ".env.local";
const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  console.log(`${envFile} does not declare CHECK_PROJECT=1, and this writes; nothing checked`);
  process.exit(0);
}

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};

const url = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL;
const anon = env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY;
const admin = createClient(url, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
const me = await signInAsCheckUser(createClient(url, anon), env);
if (!me.session) throw new Error(`no check user: ${me.why}`);
const owner = createClient(url, anon, {
  global: { headers: { Authorization: `Bearer ${me.session.access_token}` } },
  auth: { persistSession: false, autoRefreshToken: false },
});
const project = await throwawayProject(admin, me.user.id, "memory eval");

const turns = [
  {
    says: "couriers and when the money comes",
    message:
      "mujhe COD orders ka hisaab rakhna hai — courier se paisa aaya ya nahi, kis din aaya, kitna kam aaya. Hum Delhivery aur Bluedart dono use karte hain, remittance har hafte aati hai.",
    reply: {
      type: "blueprint",
      title: "COD orders ka hisaab",
      message: "Aapke Shopify orders par hi ek COD Hisaab section banega.",
      blueprint: { plans: [], unmet: [] },
    },
    want: (notes) => notes.some((n) => /delhivery|bluedart/i.test(n)) && notes.some((n) => /hafte|week/i.test(n)),
  },
  {
    says: "who packs and when",
    message:
      "I want to scan orders as I pack them so I know which are still left to pack. My sister and I pack every evening around 6.",
    reply: {
      type: "answer",
      kind: "product_help",
      title: "Packing",
      message: "This would put a scan bar on your orders.",
    },
    want: (notes) => notes.some((n) => /sister|6/i.test(n)),
  },
  {
    says: "nothing — an answer read from the store",
    message: "Which orders are still waiting for payment?",
    reply: {
      type: "answer",
      kind: "store",
      title: "Orders waiting for payment",
      message: "2 orders are waiting: #1006 and #1008.",
    },
    want: (notes) => notes.length === 0,
  },
];

try {
  console.log(`the learner on ${model}`);
  let known = [];
  for (const t of turns) {
    const t0 = Date.now();
    const got = await learn(owner, { projectId: project.id, message: t.message, reply: t.reply, known });
    console.log(`\n${t.says}  (${Date.now() - t0}ms)`);
    console.log(`     → ${JSON.stringify(got)}`);
    check(`learned ${t.says}`, t.want(got));
    check("nothing that reads as a request or a design", !got.some((n) => /scan bar|section|build|design/i.test(n)));
    known = await notesFor(owner, project.id);
  }
  console.log(`\n  known now: ${JSON.stringify(known)}`);
} finally {
  await project.remove();
}

console.log(
  fails.length === 0 ? "\nthe learner keeps facts about the business and nothing else" : `\n${fails.length} FAILED`
);
process.exit(fails.length === 0 ? 0 : 1);
