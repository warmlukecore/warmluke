"use client";

// ─────────────────────────────────────────────────────────────
// Learning: what Luke learned for each store (0176), and whether it
// helped. A lesson is a mistake not to make again, or the owner's way of
// doing a thing; a skill is a way of building something that worked.
// Each store's own list opens from its row (?project=, so a link to it
// opens it): every lesson with its version and counts, what happened to
// them on a timeline, each time the reflector ran and what it cost, and
// the owner's thumbs on Luke's replies.
//
// Everything goes through a function that refuses anyone who is not an
// administrator; the page itself decides nothing.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ThumbsDown, ThumbsUp } from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";
import { ago } from "@/lib/when";
import { dollars, modelName } from "@/lib/model-prices";
import { PageFrame } from "@/components/PageFrame";
import { Choices, adminError } from "@/components/AdminParts";
import { button, card, note } from "@/components/ui/controls";

type Kind = "lesson" | "skill";
type Learning = {
  totals: {
    active_skills: number;
    active_lessons: number;
    created: number;
    patched: number;
    retired: number;
    struck: number;
    used: number;
    helped: number;
    hurt: number;
    repeats: number;
    repeat_rate: number;
    /** The reflector's runs, and what they cost: it writes its own dollars down. */
    reflections: number;
    learning_usd: number;
    feedback_up: number;
    feedback_down: number;
  };
  projects: Array<{
    project_id: string;
    project: string;
    active_skills: number;
    active_lessons: number;
    created: number;
    used: number;
    helped: number;
    hurt: number;
    repeats: number;
    reflections: number;
    learning_usd: number;
    feedback_up: number;
    feedback_down: number;
    last_at: string | null;
  }>;
  top: Array<{ title: string; kind: Kind; projects: number; uses: number; helped: number; hurt: number }>;
};
type Event = {
  at: string;
  event: "created" | "patched" | "used" | "helped" | "hurt" | "retired" | "struck" | "repeat" | "reflected";
  skill_id: string | null;
  title: string | null;
  kind: Kind | null;
  detail: Record<string, unknown> | null;
  conversation_id: string | null;
  version: number | null;
};
type Store = {
  project: { id: string; name: string } | null;
  skills: Array<{
    id: string;
    kind: Kind;
    title: string;
    when_to_use: string;
    body: string;
    status: "active" | "retired" | "struck";
    version: number;
    uses: number;
    helped: number;
    hurt: number;
    created_by: "reflector" | "owner";
    updated_at: string;
  }>;
  events: Event[];
  feedback: Array<{
    at: string;
    verdict: "up" | "down";
    note: string | null;
    message_id: string;
    conversation_id: string | null;
  }>;
};

const DAYS: Array<[number, string]> = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
];
const KIND: Record<Kind, [string, string]> = {
  lesson: ["Lesson", "bg-tone-attention text-tone-attention-fg"],
  skill: ["Skill", "bg-tone-info text-tone-info-fg"],
};
const EVENT_TONE: Record<Event["event"], string> = {
  created: "bg-tone-success text-tone-success-fg",
  patched: "bg-tone-info text-tone-info-fg",
  used: "bg-tone-neutral text-tone-neutral-fg",
  helped: "bg-tone-success text-tone-success-fg",
  hurt: "bg-tone-critical text-tone-critical-fg",
  retired: "bg-tone-neutral text-tone-neutral-fg",
  struck: "bg-tone-attention text-tone-attention-fg",
  repeat: "bg-tone-warning text-tone-warning-fg",
  reflected: "bg-tone-neutral text-tone-neutral-fg",
};
const badge = "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap";

/** Why, when the writer said: a retirement's cap, a lesson's reason for changing. */
const reasonOf = (e: Event) => (typeof e.detail?.reason === "string" && e.detail.reason ? e.detail.reason : null);

/** Nothing is "$0", not the four places a small reply needs. */
const money = (n: number) => (n === 0 ? "$0" : dollars(n));

/** One run of the reflector, as it wrote itself down: why it ran, how much it kept, on what, for what. */
function reflection(e: Event) {
  const d = e.detail ?? {};
  const outcome = (d.outcome ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof outcome[k] === "number" ? (outcome[k] as number) : 0);
  return {
    why: typeof d.why === "string" && d.why ? d.why : "nothing named",
    kept: n("created") + n("patched"),
    model: typeof d.model === "string" && d.model ? d.model : null,
    usd: typeof d.usd === "number" ? d.usd : null,
  };
}

/** What happened, in words. */
function said(e: Event): string {
  switch (e.event) {
    case "created":
      return "learned";
    case "patched":
      return e.version ? `changed (v${e.version})` : "changed";
    case "hurt":
      return "made it worse";
    case "retired":
      return reasonOf(e) ? `retired: ${reasonOf(e)}` : "retired";
    case "struck":
      return "struck by the owner";
    case "repeat":
      return "broken again";
    default:
      return e.event;
  }
}

export default function LearningPage() {
  const { user, loading } = useUser();
  const router = useRouter();
  const gate = useParams<{ gate: string }>().gate;
  const open = useSearchParams().get("project");
  const [error, setError] = useState<string | null>(null);
  const [l, setL] = useState<Learning | null>(null);
  const [days, setDays] = useState(30);
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, router]);

  // The store is the address (?project=), so a link to it opens it and Back closes it.
  const show = useCallback((id: string | null) => {
    const at = new URLSearchParams(window.location.search);
    if (id) at.set("project", id);
    else at.delete("project");
    const qs = at.toString();
    window.history.pushState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, []);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc("abo_admin_learning", { p_days: days });
    if (err) {
      setError(adminError(err, "0176"));
      return;
    }
    setError(null);
    setL(data as Learning);
    setNow(Date.now());
  }, [days]);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  if (loading || !user || (!l && !error)) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-28 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-card bg-surface shadow-card" />
            ))}
          </div>
          <div className="mt-4 h-72 animate-pulse rounded-card bg-surface shadow-card" />
        </div>
      </PageFrame>
    );
  }

  const refused = error === "This page is for administrators.";
  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        {open && !refused ? (
          <StoreLearning id={open} days={days} gate={gate} now={now} onBack={() => show(null)}>
            <Choices options={DAYS} value={days} onChange={setDays} />
          </StoreLearning>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold tracking-tight text-fg">Learning</h1>
                <p className="mt-1 text-[13px] text-fg-muted">
                  What Luke learned for each store, how it changed, and whether it helped.
                </p>
              </div>
              <Choices options={DAYS} value={days} onChange={setDays} />
            </div>

            {error && (
              <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
                {error}
              </div>
            )}

            {l && <Overview l={l} days={days} now={now} onOpen={show} />}
          </>
        )}
      </div>
    </PageFrame>
  );
}

function Overview({ l, days, now, onOpen }: { l: Learning; days: number; now: number; onOpen: (id: string) => void }) {
  const t = l.totals;
  const cards: Array<[string, ReactNode, string]> = [
    [
      "Active now",
      (t.active_lessons + t.active_skills).toLocaleString(),
      `${t.active_lessons.toLocaleString()} ${t.active_lessons === 1 ? "lesson" : "lessons"} · ${t.active_skills.toLocaleString()} ${t.active_skills === 1 ? "skill" : "skills"}`,
    ],
    ["Learned", t.created.toLocaleString(), `new lessons and skills in ${days} days`],
    ["Changed", t.patched.toLocaleString(), `${t.retired} retired · ${t.struck} struck by an owner`],
    [
      "Reflected",
      `${t.reflections.toLocaleString()} ${t.reflections === 1 ? "time" : "times"}`,
      `${money(Number(t.learning_usd))} for the reflector's calls`,
    ],
    ["Used", t.used.toLocaleString(), "times one was read into a turn"],
    ["Helped / made worse", `${t.helped.toLocaleString()} / ${t.hurt.toLocaleString()}`, "turns it was used in"],
    [
      "Repeat mistakes",
      `${Math.round(Number(t.repeat_rate) * 100)}%`,
      "of the lessons Luke had in hand, broken anyway",
    ],
    [
      "Owners' verdicts",
      <span key="verdicts" className="inline-flex items-center gap-3">
        <span className="inline-flex items-center gap-1">
          <ThumbsUp aria-hidden size={16} strokeWidth={1.75} className="text-fg-muted" />
          {t.feedback_up.toLocaleString()}
          <span className="sr-only">up,</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <ThumbsDown aria-hidden size={16} strokeWidth={1.75} className="text-fg-muted" />
          {t.feedback_down.toLocaleString()}
          <span className="sr-only">down</span>
        </span>
      </span>,
      "thumbs on Luke's replies",
    ],
  ];
  return (
    <>
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cards.map(([name, value, sub]) => (
          <div key={name} className={`${card} p-4`}>
            <div className="text-xs text-fg-muted">{name}</div>
            <div className="mt-1 text-xl font-semibold tracking-tight text-fg tabular-nums">{value}</div>
            <div className="mt-0.5 text-xs text-fg-faint">{sub}</div>
          </div>
        ))}
      </div>

      <div className={`${card} mt-4 overflow-hidden`}>
        <div className="flex items-baseline justify-between gap-3 px-5 pt-5">
          <div className="text-[13px] font-medium text-fg">Stores</div>
          <div className="text-xs text-fg-faint">newest first; open one for its lessons</div>
        </div>
        {l.projects.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-fg-muted">Luke has learned nothing for any store yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {l.projects.map((s) => (
              <li key={s.project_id}>
                <button
                  type="button"
                  onClick={() => onOpen(s.project_id)}
                  className="flex w-full flex-col gap-1 px-5 py-3 text-left transition-colors hover:bg-surface-hover sm:flex-row sm:items-baseline sm:gap-4"
                >
                  <span className="min-w-0 truncate text-[13px] font-medium text-fg sm:flex-1">{s.project}</span>
                  <span className="flex flex-wrap gap-x-1.5 text-xs text-fg-muted tabular-nums">
                    <span>{s.active_lessons + s.active_skills} active</span>
                    <span>· {s.created} learned</span>
                    <span>· {s.used} used</span>
                    <span>
                      · {s.helped} helped, {s.hurt} worse
                    </span>
                    {s.repeats > 0 && <span className="text-tone-warning-fg">· {s.repeats} broken again</span>}
                    {s.reflections > 0 && (
                      <span>
                        · reflected {s.reflections} {s.reflections === 1 ? "time" : "times"} ·{" "}
                        {money(Number(s.learning_usd))}
                      </span>
                    )}
                    {s.feedback_up + s.feedback_down > 0 && (
                      <span>
                        · {s.feedback_up} up, {s.feedback_down} down
                      </span>
                    )}
                    <span className="text-fg-faint">· {ago(s.last_at, now)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={`${card} mt-4 overflow-hidden`}>
        <div className="px-5 pt-5">
          <div className="text-[13px] font-medium text-fg">Across stores</div>
          <p className="mt-0.5 text-xs text-fg-faint">
            Lessons and skills active today, by the name they share, most used first. One learned in many stores is one
            for every store.
          </p>
        </div>
        {l.top.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-fg-muted">Nothing active yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {l.top.map((x) => (
              <li key={`${x.kind}-${x.title}`} className="flex items-start gap-3 px-5 py-2.5">
                <span className={`${badge} mt-px ${KIND[x.kind]?.[1] ?? ""}`}>{KIND[x.kind]?.[0] ?? x.kind}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-fg">{x.title}</p>
                  <p className="mt-0.5 text-xs text-fg-faint tabular-nums">
                    in {x.projects} {x.projects === 1 ? "store" : "stores"} · used {x.uses} · helped {x.helped} · made
                    worse {x.hurt}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** One store's lessons and skills, its timeline, and its owner's verdicts. */
function StoreLearning({
  id,
  days,
  gate,
  now,
  onBack,
  children,
}: {
  id: string;
  days: number;
  gate: string;
  now: number;
  onBack: () => void;
  /** The window's choices, beside the store's name. */
  children: ReactNode;
}) {
  const [s, setS] = useState<Store | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    supabase.rpc("abo_admin_learning_project", { p_project: id, p_days: days }).then(({ data, error: err }) => {
      if (!live) return;
      if (err) setError(adminError(err, "0176"));
      else {
        setError(null);
        setS(data as Store);
      }
    });
    return () => {
      live = false;
      setS(null);
    };
  }, [id, days]);

  const thread = (conversation: string | null) =>
    conversation && (
      <span>
        ·{" "}
        <Link href={`/${gate}/conversations?id=${conversation}`} className="text-link hover:underline">
          Open the conversation
        </Link>
      </span>
    );

  return (
    <>
      <button type="button" onClick={onBack} className={button("plain", "sm")}>
        <ArrowLeft aria-hidden size={14} strokeWidth={1.75} />
        All stores
      </button>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-fg">
            {s ? (s.project?.name ?? "A store since deleted") : "Learning"}
          </h1>
          <p className="mt-1 text-[13px] text-fg-muted">
            Its lessons and skills, what happened to them in the last {days} days, and the owner&rsquo;s verdicts.
          </p>
        </div>
        {children}
      </div>

      {error && (
        <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
          {error}
        </div>
      )}

      {!s && !error && <div className="mt-6 h-72 animate-pulse rounded-card bg-surface shadow-card" />}

      {s && (
        <>
          <section className={`${card} mt-6 overflow-hidden`}>
            <h2 className="px-5 pt-5 text-[13px] font-medium text-fg">What Luke learned ({s.skills.length})</h2>
            {s.skills.length === 0 ? (
              <p className="px-5 py-4 text-[13px] text-fg-muted">Nothing learned for this store yet.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {s.skills.map((k) => (
                  <li key={k.id} className={`px-5 py-3 ${k.status === "active" ? "" : "opacity-70"}`}>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={`${badge} ${KIND[k.kind]?.[1] ?? ""}`}>{KIND[k.kind]?.[0] ?? k.kind}</span>
                      {k.status === "retired" && (
                        <span className={`${badge} bg-tone-neutral text-tone-neutral-fg`}>Retired</span>
                      )}
                      {k.status === "struck" && (
                        <span className={`${badge} bg-tone-attention text-tone-attention-fg`}>Struck by the owner</span>
                      )}
                      <span className="min-w-0 text-[13px] font-medium text-fg">{k.title}</span>
                    </div>
                    {k.when_to_use && <p className="mt-1 text-xs text-fg-muted">When: {k.when_to_use}</p>}
                    <details className="group mt-1 text-xs">
                      <summary className="w-fit cursor-pointer text-link select-none hover:underline">
                        <span className="group-open:hidden">Show</span>
                        <span className="hidden group-open:inline">Hide</span>
                      </summary>
                      <p className="mt-1.5 rounded-control bg-surface-subdued p-3 text-[13px] leading-relaxed whitespace-pre-wrap text-fg">
                        {k.body}
                      </p>
                    </details>
                    <p className="mt-1 flex flex-wrap gap-x-1.5 text-xs text-fg-faint tabular-nums">
                      <span>v{k.version}</span>
                      <span>· used {k.uses}</span>
                      <span>· helped {k.helped}</span>
                      <span>· made worse {k.hurt}</span>
                      {k.created_by === "owner" && <span>· written by the owner</span>}
                      <span title={new Date(k.updated_at).toLocaleString()}>· changed {ago(k.updated_at, now)}</span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={`${card} mt-4 overflow-hidden`}>
            <h2 className="px-5 pt-5 text-[13px] font-medium text-fg">Timeline</h2>
            {s.events.length === 0 ? (
              <p className="px-5 py-4 text-[13px] text-fg-muted">Nothing happened in this time.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {s.events.map((e, i) => (
                  <li key={`${e.at}-${e.event}-${i}`} className="flex items-start gap-3 px-5 py-2.5">
                    <span className={`${badge} mt-px ${EVENT_TONE[e.event] ?? "bg-tone-neutral text-tone-neutral-fg"}`}>
                      {said(e)}
                    </span>
                    <div className="min-w-0 flex-1">
                      {e.event === "reflected" ? (
                        <Reflected e={e} />
                      ) : (
                        <>
                          <p className="text-[13px] text-fg">{e.title ?? "A lesson since deleted"}</p>
                          {e.event !== "retired" && reasonOf(e) && (
                            <p className="mt-0.5 text-xs text-fg-muted">{reasonOf(e)}</p>
                          )}
                        </>
                      )}
                      <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-fg-faint">
                        <span title={new Date(e.at).toLocaleString()}>{ago(e.at, now)}</span>
                        {thread(e.conversation_id)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={`${card} mt-4 overflow-hidden`}>
            <h2 className="px-5 pt-5 text-[13px] font-medium text-fg">The owner&rsquo;s verdicts</h2>
            {s.feedback.length === 0 ? (
              <p className="px-5 py-4 text-[13px] text-fg-muted">No thumbs on a reply in this time.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {s.feedback.map((f, i) => (
                  <li key={`${f.message_id}-${i}`} className="flex items-start gap-3 px-5 py-2.5">
                    <span
                      className={`${badge} mt-px inline-flex items-center gap-1 ${
                        f.verdict === "up"
                          ? "bg-tone-success text-tone-success-fg"
                          : "bg-tone-critical text-tone-critical-fg"
                      }`}
                    >
                      {f.verdict === "up" ? (
                        <ThumbsUp aria-hidden size={12} strokeWidth={2} />
                      ) : (
                        <ThumbsDown aria-hidden size={12} strokeWidth={2} />
                      )}
                      {f.verdict === "up" ? "Up" : "Down"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={`text-[13px] ${f.note ? "text-fg" : "text-fg-faint"}`}>
                        {f.note ? `“${f.note}”` : "No note"}
                      </p>
                      <p className="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-fg-faint">
                        <span title={new Date(f.at).toLocaleString()}>{ago(f.at, now)}</span>
                        {thread(f.conversation_id)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}

/** "Luke reflected: <why> → kept N", and on what model, for what. */
function Reflected({ e }: { e: Event }) {
  const r = reflection(e);
  return (
    <>
      <p className="text-[13px] text-fg">
        Luke reflected: {r.why} → kept {r.kept}
      </p>
      {(r.model || r.usd !== null) && (
        <p className="mt-0.5 text-xs text-fg-muted tabular-nums">
          {[r.model && modelName(r.model), r.usd !== null && money(r.usd)].filter(Boolean).join(" · ")}
        </p>
      )}
    </>
  );
}
