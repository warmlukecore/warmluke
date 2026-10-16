// Where a task with Luke stands (lib/task-state), from its thread's last line.
//
// Pure: every last line Luke writes maps to one state the owner reads, a
// build is done only when its test did not fail, and an owner's words
// with no answer yet say nothing rather than guess.
//
//   node --experimental-strip-types --import ./scripts/ts-hook.mjs scripts/check-task-state.mjs
import { TASK_LABEL, taskStateOf } from "../src/lib/task-state.ts";

const fails = [];
const check = (name, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`);
  if (!cond) fails.push(name);
};
const luke = (ptype, more = {}) => taskStateOf({ role: "assistant", ptype, ...more });

console.log("\nwhere a task stands");
check("no line, no state", taskStateOf(null) === null);
check("the owner spoke last: no state yet", taskStateOf({ role: "user", ptype: null }) === null);
check("answering is working", luke("answering") === "working");
check("a question asked needs their answer", luke("clarify") === "needs_answer");
check("a design needs their yes", luke("blueprint") === "needs_yes" && luke("plans") === "needs_yes");
check("a plan said in words needs their yes", luke("answer", { pkind: "proposal" }) === "needs_yes");
check("a plain answer is done", luke("answer") === "done");
check("building is working", luke("build", { pstatus: "building" }) === "working");
check("a build refused did not finish", luke("build", { pstatus: "refused" }) === "failed");
check("a build whose test failed says so", luke("build", { pstatus: "built", ptested: "false" }) === "check_failed");
check("a build tested and passing is done", luke("build", { pstatus: "built", ptested: "true" }) === "done");
check("a build not tested yet is done", luke("build", { pstatus: "built", ptested: null }) === "done");
check("applied is done", luke("applied") === "done");
check("unanswered did not finish", luke("unanswered") === "failed");
check("stopped is stopped", luke("stopped") === "stopped");
check("a line it does not know says nothing", luke("something new") === null);
check(
  "every state has words",
  ["working", "needs_answer", "needs_yes", "check_failed", "failed", "stopped", "done"].every((s) => !!TASK_LABEL[s])
);

console.log(fails.length ? `\n${fails.length} FAILED` : "\nevery task says where it stands");
process.exit(fails.length ? 1 : 0);
