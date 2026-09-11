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

const BASE = process.env.ABO_BASE ?? "http://localhost:3100";
const JWT = process.env.ABO_JWT;
if (!JWT) {
  console.error("Set ABO_JWT (a signed-in user's access token).");
  process.exit(1);
}

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${JWT}` },
    body: JSON.stringify(body),
  });
  return r.json();
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
    (r.definition.actions ?? []).flatMap((a) =>
      a.type === "set_fields" ? Object.values(a.set ?? {}) : []
    )
  );

const SCENARIOS = [
  {
    name: "library",
    problem:
      "I run a small library. People borrow books and just never bring them back, and I only notice when someone else asks for that book",
    answers:
      "I note member name, phone, book title, and the date they took it. Loans are 14 days. Just me.",
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

const only = process.argv[2];
let failed = 0;

for (const s of SCENARIOS) {
  if (only && s.name !== only) continue;
  process.stdout.write(`${s.name}… `);

  const { project } = await post("/api/projects", { name: `scenario ${s.name} ${Date.now()}` });
  const first = await post("/api/chat", { message: s.problem, projectId: project.id });
  const second = await post("/api/chat", {
    message: s.answers,
    projectId: project.id,
    conversationId: first.conversationId,
  });

  const reply = second.reply;
  if (reply?.type !== "blueprint") {
    console.log(`FAIL — expected a blueprint, got ${reply?.type ?? JSON.stringify(second).slice(0, 120)}`);
    failed++;
    continue;
  }

  const problem = universal(reply.blueprint) ?? s.expect(reply.blueprint);
  if (problem) {
    console.log(`FAIL — ${problem}`);
    failed++;
  } else {
    console.log(`ok (repairs: ${second.repairs ?? 0})`);
  }
}

process.exit(failed ? 1 : 0);
