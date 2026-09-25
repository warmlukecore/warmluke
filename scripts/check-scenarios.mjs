// Behaviour regression check.
//
// tsc catches structure and check-operator-parity catches drift, but
// nothing caught the assistant quietly getting worse: a prompt edit
// made it stop producing an overdue rule at all, and only a hand-run
// of one business found it. These are the business problems already
// used to find real bugs, kept as assertions on the SHAPE of the reply
// — never its wording, which is allowed to vary.
//
//   node scripts/check-scenarios.mjs            # all
//   node scripts/check-scenarios.mjs library    # one
//
// Needs a running dev server and ABO_JWT. Costs model calls, so it is
// a before-you-change-the-prompt check, not a per-commit one.

import { readTurn } from "./turn-lines.mjs";

const BASE = process.env.ABO_BASE ?? "http://localhost:3100";
const JWT = process.env.ABO_JWT;
if (!JWT) {
  console.error("Set ABO_JWT (a signed-in user's access token).");
  process.exit(1);
}

// A chat turn arrives in lines now, the reply last; readTurn hands
// back that last line, and a plain JSON body as itself.
const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${JWT}` },
    body: JSON.stringify(body),
  });
  return (await readTurn(r)).data;
};

/**
 * Every op anywhere inside a value — walks the whole object, not just
 * `args`. Following only `args` meant this missed operators used in an
 * action's `set`, and reported a passing app as broken. An assertion
 * that checks the wrong shape is worse than no assertion: it sends you
 * hunting a regression that never happened.
 */
const opsIn = (node, found = new Set()) => {
  if (!node || typeof node !== "object") return found;
  if (typeof node.op === "string") found.add(node.op);
  for (const v of Object.values(node)) opsIn(v, found);
  return found;
};

const rulesOf = (plans) => plans.filter((p) => p.automation).map((p) => p.automation);
const storedWrites = (plans) =>
  rulesOf(plans).flatMap((r) =>
    (r.definition.actions ?? []).flatMap((a) => (a.type === "set_fields" ? Object.values(a.set ?? {}) : []))
  );

const SCENARIOS = [
  {
    name: "library",
    problem:
      "I run a small library. People borrow books and just never bring them back, and I only notice when someone else asks for that book",
    answers: "I note member name, phone, book title, and the date they took it. Loans are 14 days. Just me.",
    // Being told without looking is the whole ask, so a schedule rule
    // is the only shape that answers it.
    expect: (b) => {
      const rules = rulesOf(b.plans);
      if (!rules.some((r) => r.definition.trigger.type === "schedule"))
        return "no scheduled rule — nothing notices an overdue book on its own";
      return null;
    },
  },
  {
    name: "cod",
    problem:
      "i sell sarees online mostly COD. courier deposits money weekly but i cant tell which orders. some orders ka paisa aata hi nahi and i find out months later",
    answers:
      "awb number, customer name phone, amount. excel aata hai but main match nahi karta. customer complain nahi karta. mujhe months baad yaad aata hai. 40-50 orders a week",
    expect: (b) => {
      const rules = rulesOf(b.plans);
      if (!rules.some((r) => r.definition.trigger.type === "schedule"))
        return "no scheduled rule — the owner still has to remember to check";
      return null;
    },
  },
  {
    name: "packing",
    problem: "Mere packer galat product bhej rahe hain. Customer complain karta hai tab pata chalta hai",
    answers:
      "Barcode scanner hai, SKU likha hota hai. Orders website se aate hain. Sirf main khud pack karta hoon. Similar dikhne wale products mix ho jate hain, size ya colour galat chala jata hai, quantity kam ya zyada pack hoti hai",
    // The owner named three faults; the third is the one a design can
    // silently drop. A scan that assigns the ordered quantity instead of
    // counting records a perfect pack every time, so the short pack they
    // asked us to catch becomes the one thing nobody can ever find.
    expect: (b) => {
      const scans = b.plans.map((p) => p.newSchema?.features?.scanMode).filter(Boolean);
      // They named three faults and own a scanner. A design with no
      // verification step solves none of it, which is allowed — saying
      // so is not. Silence here hands back the manual process they came
      // to replace and lets them approve it thinking it was solved.
      if (scans.length === 0) {
        return (b.unmet ?? []).length > 0
          ? null
          : "nothing verifies a pack and unmet never says what was left unsolved";
      }
      for (const sm of scans) {
        for (const [field, v] of Object.entries(sm.action?.set ?? {})) {
          if (!/qty|quantity|count/i.test(field)) continue;
          if (!JSON.stringify(v).includes(`"${field}"`))
            return `scanning sets ${field} without counting it — a short pack would still look complete`;
        }
      }
      const scanSteps = (b.workflow ?? []).filter((w) => /\bscan/i.test(w.step));
      if (scanSteps.length === 0) return "no scan step in the flow at all";
      if (!scanSteps.every((w) => /refused on screen/.test(w.step)))
        return "the flow describes scanning in the model's own words instead of the engine's";
      return null;
    },
  },
  // ── Detection: the owner finds out too late ──────────────────
  {
    name: "expiry",
    problem: "I run a chemist shop. Medicines expire on the shelf and I find out when a customer points at the date",
    answers: "Medicine name, batch number, expiry date, quantity. Just me and one helper.",
    // Nothing about a stored expiry date notices itself. Only a rule
    // that runs on its own can tell them before the customer does.
    expect: (b) => {
      const rules = rulesOf(b.plans);
      if (!rules.some((r) => r.definition.trigger.type === "schedule"))
        return "no scheduled rule — a date sitting in a column never speaks up";
      return null;
    },
  },
  {
    name: "warranty",
    problem:
      "Customers come back saying the product is under warranty and I have no way to check, so I end up repairing free",
    answers: "Invoice number, customer name, product, sale date. Warranty is 12 months. I check on paper bills.",
    // The answer is date arithmetic against the sale date, not a field
    // someone types "in warranty" into and forgets to update.
    // Anywhere in the plan: a computed column (newSchema.columns[].compute)
    // is the better answer and was not looked at, so a design that got it
    // right failed here.
    expect: (b) => {
      const ops = new Set(b.plans.flatMap((p) => [...opsIn(p)]));
      const dateAware = ["days_since", "days_until", "date_add", "before", "after"].some((o) => ops.has(o));
      if (!dateAware) return "nothing computes from the sale date — warranty would have to be maintained by hand";
      return null;
    },
  },
  {
    name: "service-due",
    problem: "I sell water purifiers with yearly servicing. I forget which customer is due and lose the AMC renewal",
    answers:
      "Customer name phone, model, installation date, last service date. Service every 12 months. 300 customers.",
    expect: (b) => {
      const rules = rulesOf(b.plans);
      if (!rules.some((r) => r.definition.trigger.type === "schedule"))
        return "no scheduled rule — nothing surfaces a due customer on its own";
      return null;
    },
  },

  // ── Counting other rows ──────────────────────────────────────
  {
    name: "duplicate-entry",
    problem:
      "Same customer gets entered twice with different spellings and then I cannot tell how much they actually owe",
    answers: "Name, phone number, amount. Phone number is the same, name spelling changes. I enter them myself.",
    // Catching a duplicate means looking at the other rows; nothing on
    // the row being typed can know it has a twin.
    expect: (b) => {
      const rules = rulesOf(b.plans);
      if (!rules.some((r) => opsIn(r.definition).has("count_matching")))
        return "no count_matching — a duplicate cannot be seen from inside the row being typed";
      return null;
    },
  },
  {
    name: "capacity",
    problem: "Mere tuition batch me 20 seat hain par main zyada admission le leta hoon aur phir jagah nahi hoti",
    answers: "Student naam, phone, batch ka naam, fees. Har batch me 20 seat. Main khud entry karta hoon.",
    expect: (b) => {
      const rules = rulesOf(b.plans);
      if (!rules.some((r) => opsIn(r.definition).has("count_matching")))
        return "no count_matching — a seat limit cannot be enforced without counting the batch";
      return null;
    },
  },

  // ── Cross-section writes ─────────────────────────────────────
  {
    name: "stock-depletion",
    problem:
      "When a repair job is done the parts used should come off my stock, right now I update a separate register and it is always wrong",
    answers:
      "Job card number, customer, device, parts used with quantity. Separate stock list with part name and quantity. Just me.",
    // Two sections that must move together. A rule whose target is
    // another module is the only shape that keeps them in step.
    expect: (b) => {
      const rules = rulesOf(b.plans);
      const crossWrite = rules.some((r) =>
        (r.definition.actions ?? []).some((a) => a.target?.module_id || a.target?.match)
      );
      if (!crossWrite) return "no rule writes into another section — stock would still be updated by hand";
      return null;
    },
  },
  {
    name: "partial-payment",
    problem: "Customers pay in parts and I lose track of who still owes me how much. I only realise at month end",
    answers: "Customer name phone, total amount, payments received. Amounts vary. About 60 customers.",
    // Money owed is arithmetic on two numbers, not a status someone
    // remembers to flip.
    // Anywhere in the plan, computed columns included: a balance column
    // worked out as total minus paid is the best answer, and was failed.
    expect: (b) => {
      const arith = b.plans.some((p) => opsIn(p).has("-"));
      if (!arith) return "nothing subtracts paid from total — the balance would be kept in someone's head";
      return null;
    },
  },

  // ── Asked for something the platform cannot do ───────────────
  {
    name: "whatsapp",
    problem: "I want to send WhatsApp reminders to customers whose payment is pending, and also track the payments",
    answers: "Customer name, phone, amount, due date. About 80 customers. Just me.",
    // Half the request is impossible. It must be said in the owner's
    // own words, not silently replaced with a status field and hoped for.
    expect: (b) => {
      const said = (b.unmet ?? []).some((u) => /whatsapp|message|remind|send/i.test(u));
      if (!said) return "the WhatsApp half was dropped and unmet never says so";
      if (!b.plans.some((p) => p.newModule)) return "the half that IS possible was not built either";
      return null;
    },
  },
  {
    name: "customer-portal",
    problem: "I want my customers to log in and see their order status themselves so they stop calling me",
    answers: "Order number, customer name phone, status. 200 orders a month.",
    expect: (b) => {
      const said = (b.unmet ?? []).some((u) => /customer|login|log in|portal|themselves|see/i.test(u));
      if (!said) return "a customer-facing login is impossible here and unmet never says so";
      return null;
    },
  },
  {
    name: "photo-proof",
    problem: "Delivery boys should click a photo at delivery so customers cannot claim they never got it",
    answers: "Order number, customer address, delivery boy name, delivery time. 50 deliveries a day.",
    expect: (b) => {
      const said = (b.unmet ?? []).some((u) => /photo|picture|image|proof|click/i.test(u));
      if (!said) return "photos are impossible here and unmet never says so";
      return null;
    },
  },

  // ── Shape of the reply itself ────────────────────────────────
  {
    name: "vague",
    problem: "mujhe apne business ke liye kuch banana hai",
    answers: null, // deliberately unanswered: the first reply must ask
    // Nothing here says what the business is. Building anything from
    // this is a guess dressed as a design.
    expectFirst: (reply) => {
      if (reply.type !== "clarify") return `expected questions first, got "${reply.type}"`;
      if ((reply.questions ?? []).length < 2) return "one question is not discovery";
      return null;
    },
  },
  {
    name: "two-sections",
    problem:
      "Har order me kai items hote hain aur main sab ek hi row me likhta hoon, phir count nahi kar pata kaunsa item kitna gaya",
    answers: "Order number, customer, aur us order ke items — product naam aur quantity. 40 orders roz.",
    // One row per order cannot hold many items. The fix is a second
    // section pointing back at the first, not more columns.
    expect: (b) => {
      const modules = b.plans.filter((p) => p.newModule);
      if (modules.length < 2) return "one section cannot hold many items per order";
      const linked = modules.some((p) => (p.newSchema?.columns ?? []).some((c) => c.type === "link"));
      if (!linked) return "the two sections are not linked — the items float free of their order";
      return null;
    },
  },

  // ── Language and phrasing ────────────────────────────────────
  {
    name: "hindi-heavy",
    problem: "Meri dukaan me udhaar bahut chalta hai. Kisne kitna udhaar liya aur kab tak dena hai, yaad nahi rehta",
    answers: "Grahak ka naam aur phone, kitna udhaar, kab liya, kab tak dena hai. Roz ke 20-30 grahak. Sirf main.",
    // The labels the owner reads must be their words, not a translation
    // into business English they never used.
    expect: (b) => {
      const rules = rulesOf(b.plans);
      if (!rules.some((r) => r.definition.trigger.type === "schedule"))
        return "no scheduled rule — an overdue udhaar still has to be remembered";
      return null;
    },
  },
  {
    name: "broken-english",
    problem: "my staff take tools from store and not return, tools missing every month",
    answers: "tool name, tool number, staff name, date taken, date returned. 15 staff. i keep register.",
    expect: (b) => {
      const rules = rulesOf(b.plans);
      const sched = rules.some((r) => r.definition.trigger.type === "schedule");
      const counts = rules.some((r) => opsIn(r.definition).has("count_matching"));
      if (!sched && !counts) return "nothing notices a tool that never came back";
      return null;
    },
  },

  // ── Traps ────────────────────────────────────────────────────
  {
    name: "just-a-list",
    problem: "I want a list of my suppliers with their phone numbers",
    answers: "Supplier name, phone, what they supply, city. About 25 suppliers.",
    // No problem to detect here. Inventing a rule to look clever is its
    // own failure: it gives the owner something to maintain for nothing.
    expect: (b) => {
      if (b.plans.filter((p) => p.newModule).length > 1)
        return "a plain list was split into several sections for no reason";
      return null;
    },
  },
  {
    name: "wrong-tool",
    problem: "I need proper accounting with GST returns and balance sheet for my shop",
    answers: "Sales, purchases, GST rates, monthly returns. Turnover about 50 lakh.",
    // This is not what the platform is. Saying so plainly beats building
    // a tracker the owner will trust for a statutory filing.
    expect: (b) => {
      if ((b.unmet ?? []).length === 0)
        return "statutory accounting was accepted whole, with nothing said about what is not covered";
      return null;
    },
  },

  {
    name: "double-booking",
    problem: "Two people book the same slot and I only find out on the day",
    answers:
      "Service appointments. I take them by phone. A slot is a date and a time. Just mark clashes clearly. I also track payment status.",
    expect: (b) => {
      const rules = rulesOf(b.plans);
      const uses = rules.some((r) => opsIn(r.definition).has("count_matching"));
      if (!uses) return "no count_matching — a clash cannot be detected without looking at other rows";
      return null;
    },
  },
];

// Applies to every scenario: a value counted from today must never be
// written into a field, or it is right for one day and wrong after.
const universal = (b) => {
  for (const v of storedWrites(b.plans)) {
    if (opsIn(v).has("days_since")) return "a rule stores a value counted from today; it will go stale";
  }
  if (!b.plans.some((p) => p.newModule)) return "no section was proposed";
  return null;
};

/** The run before this one, so a change can be compared rather than felt. */
async function previousRun() {
  try {
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(new URL("../evals/history.jsonl", import.meta.url), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    return lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
  } catch {
    return null;
  }
}

const only = process.argv[2];
let failed = 0;
const results = [];

for (const s of SCENARIOS) {
  if (only && s.name !== only) continue;
  process.stdout.write(`${s.name}… `);

  const { project } = await post("/api/projects", { name: `scenario ${s.name} ${Date.now()}` });
  const first = await post("/api/chat", { message: s.problem, projectId: project.id });

  // Some scenarios are about the FIRST reply — whether a request too
  // thin to design from gets questions instead of a guess. Those never
  // reach a blueprint, and demanding one would assert the opposite of
  // what they test.
  if (s.expectFirst) {
    const problem = first.reply
      ? s.expectFirst(first.reply)
      : `no reply at all: ${JSON.stringify(first).slice(0, 120)}`;
    console.log(problem ? `FAIL — ${problem}` : `ok (repairs: ${first.repairs ?? 0})`);
    results.push({ name: s.name, ok: !problem, why: problem, repairs: first.repairs ?? 0 });
    if (problem) failed++;
    continue;
  }

  // Discovery is not fixed at one round. A clear request can be designed
  // from straight away, and a murky one is entitled to ask twice — both
  // are the product working. A harness that demands the blueprint arrive
  // on turn two scores good behaviour as failure and hides the real ones.
  let turn = first;
  let convId = first.conversationId;
  for (let i = 0; turn.reply?.type !== "blueprint" && i < 3; i++) {
    if (turn.reply?.type === "plans") break; // already past the design
    turn = await post("/api/chat", {
      message: i === 0 ? s.answers : "Bas itna hi hai, isi se bana do.",
      projectId: project.id,
      conversationId: convId,
    });
    convId = turn.conversationId ?? convId;
  }

  const reply = turn.reply;
  const second = turn;
  if (reply?.type !== "blueprint") {
    console.log(`FAIL — expected a blueprint, got ${reply?.type ?? JSON.stringify(turn).slice(0, 120)}`);
    failed++;
    results.push({
      name: s.name,
      ok: false,
      why: `no blueprint (${reply?.type ?? "error"})`,
      repairs: turn.repairs ?? 0,
    });
    continue;
  }

  const problem = universal(reply.blueprint) ?? s.expect(reply.blueprint);
  results.push({ name: s.name, ok: !problem, why: problem, repairs: second.repairs ?? 0 });
  if (problem) {
    console.log(`FAIL — ${problem}`);
    failed++;
  } else {
    console.log(`ok (repairs: ${second.repairs ?? 0})`);
  }
}

// A run that leaves no trace cannot answer the only question that
// matters after a prompt change: is this better than last time? Without
// it a change that fixes one scenario and breaks another reads as "some
// pass, some fail", the same as before, and the regression ships.
if (!only) {
  const { appendFileSync, mkdirSync } = await import("node:fs");
  const { execSync } = await import("node:child_process");
  let commit = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {}
  // Read the previous run BEFORE writing this one, or the comparison is
  // against the line just appended and every run reports "+0, same as
  // last time" — a regression detector that can never detect one.
  const prev = await previousRun();

  mkdirSync(new URL("../evals/", import.meta.url), { recursive: true });
  appendFileSync(
    new URL("../evals/history.jsonl", import.meta.url),
    JSON.stringify({
      at: new Date().toISOString(),
      commit,
      model: process.env.ABO_EVAL_MODEL ?? "default",
      passed: results.filter((r) => r.ok).length,
      total: results.length,
      repairs: results.reduce((n, r) => n + r.repairs, 0),
      failures: results.filter((r) => !r.ok).map((r) => ({ name: r.name, why: r.why })),
    }) + "\n"
  );

  if (prev) {
    const now = results.filter((r) => r.ok).length;
    const delta = now - prev.passed;
    const nowFail = new Set(results.filter((r) => !r.ok).map((r) => r.name));
    const wasFail = new Set((prev.failures ?? []).map((f) => f.name));
    const fixed = [...wasFail].filter((n) => !nowFail.has(n));
    const broke = [...nowFail].filter((n) => !wasFail.has(n));
    const nowModel = process.env.ABO_EVAL_MODEL ?? "default";
    console.log(
      `\n${now}/${results.length} [${nowModel}] vs ${prev.passed}/${prev.total} ` +
        `[${prev.model ?? "?"}] at ${prev.commit} (${delta >= 0 ? "+" : ""}${delta})`
    );
    if ((prev.model ?? "default") !== nowModel)
      console.log("  different models — this is a comparison of providers, not of changes");
    if (fixed.length) console.log(`  fixed:  ${fixed.join(", ")}`);
    if (broke.length) console.log(`  BROKE:  ${broke.join(", ")}`);
    if (!fixed.length && !broke.length) console.log("  same scenarios as last run");
  }
}

process.exit(failed ? 1 : 0);
