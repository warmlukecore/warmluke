// A conversation, told as it happened: what the owner said and Luke
// answered, each turn's road, model, seconds and cost, what was built,
// the rules it made and whether they ever did anything, the radar's
// signs (0211), and what went wrong.
//
// Read only: every query goes through the management API with
// read_only set, so it can be pointed at production. Tanish's first
// meeting (a57134fd, 11 Oct) was taken apart by hand from these tables;
// this does it in one command.
//
//   node scripts/autopsy.mjs <conversation-id> [--env .env.local] [--full]
//
// The patterns for "Luke says he can't" and "the owner is unhappy" are
// 0211's (abo_trouble_scan), kept word for word here: change both.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const convo = args.find((a) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a));
const envFile = args.includes("--env") ? args[args.indexOf("--env") + 1] : ".env.local";
const full = args.includes("--full");
if (!convo) {
  console.error("Usage: node scripts/autopsy.mjs <conversation-id> [--env .env.local] [--full]");
  process.exit(2);
}

const env = Object.fromEntries(
  readFileSync(new URL(`../${envFile}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (!env.SUPABASE_ACCESS_TOKEN) throw new Error(`${envFile} has no SUPABASE_ACCESS_TOKEN`);
const REF = new URL(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL).hostname.split(".")[0];

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, read_only: true }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

// 0211's patterns, as Postgres reads them (~*), in JavaScript.
const CANT =
  /(\bi can.?t\b|\bi cannot\b|i.?m (not able|unable) to|i don.?t have (a way|access|the ability)|i have no way|only you can|you(.?ll| will) (need|have) to (check|open|look|do|type|change)|isn.?t something (i|this platform|the app) can|not something (i|this platform) can|this platform (can.?t|cannot|has no way))/i;
const UNHAPPY =
  /(\bwrong\b|not what i|\bdumb\b|\bstupid\b|still (not|broken|wrong)|doesn.?t work|didn.?t work|not working|\bmessed up\b|why (is|did|does) it|why would|why (isn.?t|can.?t|not)\b|\b(liar|lie|lying)\b|can.?t you|are you (sure|serious)|\bseriously\b|\bgalat\b|phir se|nahi chahiye|kaam nahi|nahi ho raha|nahi hua|samajh nahi|\bbekar\b|kya kar raha|kyu nahi|^\s*\?+\s*$|\?\?)/i;
/** The sentence that says it, as 0211 keeps it. */
const saying = (text, re) =>
  String(text ?? "")
    .split(/(?<=[.!?\n])/)
    .find((x) => re.test(x))
    ?.trim() ?? text;
const SLOW_MS = 90_000;

const [head] = await sql(`
  select c.id, c.title, c.created_at, p.id as project_id, p.name as project,
         s.shop_domain, coalesce(s.timezone, 'UTC') as zone
    from public.conversations c
    join public.projects p on p.id = c.project_id
    left join public.stores s on s.project_id = p.id and s.status in ('connected', 'uninstalled')
   where c.id = '${convo}'`);
if (!head) {
  console.error(`No conversation ${convo} on ${REF}.`);
  process.exit(1);
}
const zone = head.zone;
const at = (iso) =>
  new Date(iso).toLocaleString("en-IN", {
    timeZone: zone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const clip = (s, n = 260) => {
  const one = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return full || one.length <= n ? one : `${one.slice(0, n - 1)}…`;
};

const messages = await sql(`
  select m.id, m.role, m.created_at, m.payload->>'type' as type, m.payload->>'status' as status,
         coalesce(m.payload->>'text', m.payload->>'message') as words
    from public.messages m
   where m.conversation_id = '${convo}'
   order by m.created_at, m.id`);
const traces = await sql(`
  select t.turn_id, t.road, t.model, t.took_ms, t.repairs, t.critic->>'verdict' as verdict,
         jsonb_array_length(coalesce(t.unmet, '[]'::jsonb)) as unmet_n, t.unmet->>0 as unmet_first,
         (t.usage->>'usd')::numeric as usd
    from public.turn_traces t
   where t.conversation_id = '${convo}'`);
const trace = new Map(traces.map((t) => [t.turn_id, t]));

const first = messages[0]?.created_at ?? head.created_at;
const last = messages.at(-1)?.created_at ?? head.created_at;
// The rules this conversation's builds made: the project's, born while it ran.
const rules = await sql(`
  select a.id, a.name, a.enabled, a.created_at, a.definition->'trigger'->>'type' as trigger,
         a.definition->'trigger'->'when' is null as unconditional,
         (select count(*) from public.automation_runs r where r.automation_id = a.id) as runs,
         (select count(*) from public.automation_runs r where r.automation_id = a.id and not r.ok) as failed,
         (select coalesce(sum((r.detail->>'wrote')::int), 0) from public.automation_runs r
           where r.automation_id = a.id and r.detail ? 'wrote') as wrote,
         (select count(*) from public.automation_runs r where r.automation_id = a.id
           and exists (select 1 from jsonb_each(coalesce(r.detail->'read', '{}'::jsonb)) e where (e.value->>'cut')::boolean)) as cut,
         (select count(*) from public.code_jobs j where j.automation_id = a.id) as jobs,
         (select count(*) from public.code_jobs j where j.automation_id = a.id and j.status = 'failed') as jobs_failed
    from public.automations a
   where a.project_id = '${head.project_id}'
     and a.created_at between '${first}'::timestamptz and '${last}'::timestamptz + interval '1 hour'
   order by a.created_at`);
let stored = [];
try {
  stored = await sql(`
    select kind, at, detail, sample from public.trouble_signs
     where conversation_id = '${convo}' order by at`);
} catch {
  // 0211 is not on this database yet: the signs below are worked out here.
}

// ── The story ──
const usd = traces.reduce((n, t) => n + Number(t.usd ?? 0), 0);
console.log(`\n${head.title ?? "(untitled)"} · ${head.project}${head.shop_domain ? ` · ${head.shop_domain}` : ""}`);
console.log(
  `${at(first)} → ${at(last)} (${zone}) · ${messages.filter((m) => m.role === "user").length} from the owner · ${traces.length} Luke turns · $${usd.toFixed(2)}`
);
console.log("\nTHE STORY");
for (const m of messages) {
  const t = trace.get(m.id);
  const turn = t
    ? `  [${t.road} · ${t.model ?? "?"} · ${Math.round((t.took_ms ?? 0) / 1000)}s · $${Number(t.usd ?? 0).toFixed(3)}${t.repairs ? ` · ${t.repairs} repairs` : ""}${t.verdict === "redo" ? " · sent back" : ""}]`
    : "";
  const who = m.role === "user" ? "OWNER" : `LUKE ${m.type ?? ""}${m.status ? `/${m.status}` : ""}`.trim();
  console.log(`${at(m.created_at)}  ${who.padEnd(18)} ${clip(m.words ?? `(${m.type ?? "empty"})`)}${turn}`);
}

// ── By road ──
console.log("\nTURNS BY ROAD");
for (const road of new Set(traces.map((t) => t.road))) {
  const of = traces.filter((t) => t.road === road);
  const ms = of.map((t) => t.took_ms ?? 0);
  console.log(
    `${road.padEnd(8)} ${of.length} turns · $${of.reduce((n, t) => n + Number(t.usd ?? 0), 0).toFixed(2)} · avg ${Math.round(ms.reduce((a, b) => a + b, 0) / of.length / 1000)}s · max ${Math.round(Math.max(...ms) / 1000)}s · models ${[...new Set(of.map((t) => t.model))].join(", ")}`
  );
}

// ── Builds and rules ──
const builds = messages.filter((m) => m.type === "build");
console.log(`\nBUILDS (${builds.length})`);
for (const b of builds) console.log(`${at(b.created_at)}  ${b.status ?? ""}  ${clip(b.words, 200)}`);
console.log(`\nRULES MADE WHILE IT RAN (${rules.length})`);
for (const r of rules) {
  const ran = Number(r.runs) + Number(r.jobs);
  console.log(
    `${at(r.created_at)}  ${r.enabled ? "on " : "off"}  "${r.name}" (${r.trigger}) · ran ${ran}${Number(r.failed) + Number(r.jobs_failed) ? ` · failed ${Number(r.failed) + Number(r.jobs_failed)}` : ""}${Number(r.runs) ? ` · wrote ${r.wrote}` : ""}${Number(r.cut) ? ` · cut short ${r.cut}` : ""}`
  );
}

// ── Signs ──
const signs = [];
const sign = (kind, when, detail, sample = "") => signs.push({ kind, at: when, detail, sample });
for (const m of messages) {
  if (m.role === "user" && UNHAPPY.test(m.words ?? ""))
    sign("frustrated", m.created_at, "The owner sounds unhappy", m.words);
  if (
    m.role === "assistant" &&
    ["answer", "clarify", "plans", "blueprint"].includes(m.type) &&
    CANT.test(m.words ?? "")
  )
    sign("cant", m.created_at, "Luke says he can't", saying(m.words, CANT));
  if (m.type === "unanswered") sign("turn", m.created_at, "The turn failed", m.words);
  if (m.type === "stopped") sign("slow", m.created_at, "The turn was stopped before it answered");
  const t = trace.get(m.id);
  if (!t) continue;
  if ((t.took_ms ?? 0) > SLOW_MS) sign("slow", m.created_at, `A ${t.road} turn took ${Math.round(t.took_ms / 1000)} s`);
  if (t.repairs >= 2) sign("turn", m.created_at, `Needed ${t.repairs} repairs`);
  if (t.verdict === "redo") sign("turn", m.created_at, "The critic sent the design back");
  if (Number(t.unmet_n) > 0) sign("gap", m.created_at, "Asked for what the app can't do", t.unmet_first);
}
for (let i = 0; i + 2 < builds.length; i++) {
  const span = new Date(builds[i + 2].created_at) - new Date(builds[i].created_at);
  if (span <= 3600_000) {
    sign(
      "rebuilds",
      builds[i].created_at,
      `${builds.length} builds in this conversation, 3 within ${Math.round(span / 60000)} min`
    );
    break;
  }
}
for (const r of rules) {
  if (Number(r.failed) + Number(r.jobs_failed) > 0) sign("rule", r.created_at, `Rule "${r.name}" failed`);
  if (Number(r.cut) > 0) sign("cut", r.created_at, `Rule "${r.name}" read a list cut short`);
  if (Number(r.runs) >= 3 && Number(r.wrote) === 0)
    sign("idle", r.created_at, `Rule "${r.name}" ran ${r.runs} times and changed nothing`);
  if (
    r.enabled &&
    r.unconditional &&
    Number(r.runs) + Number(r.jobs) === 0 &&
    ["record_created", "record_updated"].includes(r.trigger)
  )
    sign("idle", r.created_at, `Rule "${r.name}" never ran`);
}
const lastOne = messages.at(-1);
if (
  lastOne?.role === "assistant" &&
  ["blueprint", "plans", "clarify"].includes(lastOne.type) &&
  Date.now() - new Date(lastOne.created_at) > 12 * 3600_000
)
  sign("left", lastOne.created_at, `The owner left a ${lastOne.type === "clarify" ? "question" : "plan"} unanswered`);

signs.sort((a, b) => new Date(a.at) - new Date(b.at));
console.log(`\nSIGNS (${signs.length})`);
for (const s of signs)
  console.log(`${at(s.at)}  ${s.kind.padEnd(10)} ${s.detail}${s.sample ? ` · “${clip(s.sample, 140)}”` : ""}`);
if (stored.length) {
  console.log(`\nSIGNS THE RADAR KEPT (${stored.length}, 0211)`);
  for (const s of stored) console.log(`${at(s.at)}  ${s.kind.padEnd(10)} ${s.detail}`);
}

// ── What went wrong ──
const count = (k) => signs.filter((s) => s.kind === k).length;
const wrong = [];
if (count("rebuilds"))
  wrong.push(
    `Rebuilt ${builds.length} times: Luke designed again instead of settling one design with the owner first.`
  );
if (count("cant"))
  wrong.push(
    `Luke said he couldn't ${count("cant")} times: a missing tool or a wall, not the owner's fault. Read the replies above.`
  );
if (count("frustrated")) wrong.push(`The owner sounded unhappy ${count("frustrated")} times.`);
const idle = signs.filter((s) => s.kind === "idle" || s.kind === "rule" || s.kind === "cut");
if (idle.length) wrong.push(`Rules that never did their job: ${idle.map((s) => s.detail).join("; ")}.`);
if (count("slow")) wrong.push(`${count("slow")} turns were slow or stopped (over ${SLOW_MS / 1000} s).`);
if (count("gap")) wrong.push(`${count("gap")} asks left partly undone (the gap check's "unmet").`);
if (count("turn")) wrong.push(`${count("turn")} turns failed, needed repairs, or were sent back.`);
if (count("left")) wrong.push("The owner left in the middle of a plan or a question.");
console.log("\nWHAT WENT WRONG");
console.log(wrong.length ? wrong.map((w) => `- ${w}`).join("\n") : "- Nothing the signs can see.");
console.log("");
