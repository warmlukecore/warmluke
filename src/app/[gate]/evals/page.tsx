"use client";

// ─────────────────────────────────────────────────────────────
// Evals — Luke in whole conversations with a simulated owner, graded
// (scripts/eval-luke.mjs, evals/README.md).
//
// The runs are JSON committed in evals/runs/ and imported when the app is
// built (evals/runs/all.ts, which the harness rewrites after each run), so
// the page reads no database: production shows what was measured on the
// check project. The one call it makes is the gate.
//
// Two runs are compared only on the same design model: a change of model
// moves every number, and would be read as the change being tested.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronRight } from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";
import { dollars, modelName } from "@/lib/model-prices";
import { PageFrame } from "@/components/PageFrame";
import { scrollList } from "@/components/AdminParts";
import { Select } from "@/components/ui/Select";
import { card, label, note } from "@/components/ui/controls";
import {
  SCORE_KEYS,
  SCORE_NAMES,
  casePassed,
  signCount,
  type CaseResult,
  type EvalRun,
  type RunEntry,
} from "@/lib/eval-report";
import entries from "../../../../evals/runs/index.json";
import { RUN_FILES } from "../../../../evals/runs/all";

type Run = EvalRun & { file: string };

/** Newest first. An index line whose file is not there is left out, not drawn empty. */
const RUNS: Run[] = (entries as unknown as RunEntry[])
  .filter((e) => RUN_FILES[e.file])
  .map((e) => ({ ...RUN_FILES[e.file], file: e.file }))
  .toSorted((a, b) => b.started.localeCompare(a.started));

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const pct = (n: number) => `${Math.round(n * 100)}%`;
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;
const money = (n: number) => (n === 0 ? "$0" : dollars(n));
const mean = (s: Record<string, number>) => {
  const v = Object.values(s);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
};
/** "+1.0", "−0.5", "±0": what moved, and which way. */
const moved = (n: number, show: (n: number) => string) => (n > 0 ? `+${show(n)}` : n < 0 ? `−${show(-n)}` : "±0");

const TONE = {
  success: "bg-tone-success text-tone-success-fg",
  critical: "bg-tone-critical text-tone-critical-fg",
  attention: "bg-tone-attention text-tone-attention-fg",
  neutral: "bg-tone-neutral text-tone-neutral-fg",
} as const;

function Pill({ tone, children }: { tone: keyof typeof TONE; children: ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

/** A criterion in a run: met, not met, or not in that run at all. */
function Met({ met }: { met: boolean | undefined }) {
  if (met === undefined) return <Pill tone="neutral">Not run</Pill>;
  return met ? <Pill tone="success">Met</Pill> : <Pill tone="critical">Not met</Pill>;
}
function Hit({ hit }: { hit: boolean | undefined }) {
  if (hit === undefined) return <Pill tone="neutral">Not run</Pill>;
  return hit ? <Pill tone="critical">Hit</Pill> : <Pill tone="success">Clear</Pill>;
}

/** A case in a run: passed, failed, or not in that run at all. */
function Verdict({ c }: { c: CaseResult | undefined }) {
  if (!c) return <Met met={undefined} />;
  return casePassed(c) ? <Pill tone="success">Passed</Pill> : <Pill tone="critical">Failed</Pill>;
}

/** The same thing in two runs, the earlier first. */
function Pair({ before, after }: { before: ReactNode; after: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {before}
      <ArrowRight aria-hidden size={12} strokeWidth={1.75} className="text-fg-faint" />
      <span className="sr-only">then</span>
      {after}
    </span>
  );
}

function Fig({ name, value }: { name: string; value: ReactNode }) {
  return (
    <span className="block min-w-0">
      <span className="block text-[11px] text-fg-faint">{name}</span>
      <span className="block truncate text-[13px] font-medium text-fg tabular-nums">{value}</span>
    </span>
  );
}

export default function EvalsPage() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [shown, setShown] = useState(RUNS[0]?.file ?? "");
  const [before, setBefore] = useState(RUNS[1]?.file ?? "");
  const [after, setAfter] = useState(RUNS[0]?.file ?? "");

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, router]);

  // The runs are in the page already; who may read them is still the server's to say.
  useEffect(() => {
    if (!user) return;
    supabase.rpc("abo_is_superadmin").then(({ data, error }) => setAdmin(!error && data === true));
  }, [user]);

  if (loading || !user || admin === null) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-24 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 h-72 animate-pulse rounded-card bg-surface shadow-card" />
        </div>
      </PageFrame>
    );
  }

  const run = RUNS.find((r) => r.file === shown);
  return (
    <PageFrame email={user.email} isSuperadmin={admin}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Evals</h1>
        <p className="mt-1 text-[13px] text-fg-muted">
          Luke in whole conversations with a simulated owner, graded on what he said and what he built. Newest first.
        </p>

        {!admin ? (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            This page is for administrators.
          </div>
        ) : RUNS.length === 0 ? (
          <div className={`${card} mt-6 px-5 py-10 text-center text-[13px] text-fg-muted`}>
            No eval runs yet. Run scripts/eval-luke.mjs (see evals/README.md).
          </div>
        ) : (
          <>
            <ul className={`${card} ${scrollList} mt-6 divide-y divide-line`}>
              {RUNS.map((r) => (
                <li key={r.file}>
                  <button
                    type="button"
                    aria-pressed={r.file === shown}
                    onClick={() => setShown(r.file)}
                    className={`block w-full px-4 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none sm:px-5 ${r.file === shown ? "bg-surface-hover" : ""}`}
                  >
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-[13px] font-medium text-fg">{r.label}</span>
                      {r.partial && <Pill tone="attention">Partial</Pill>}
                      <span className="text-xs text-fg-faint">
                        {when(r.started)} · {modelName(r.design_model)}
                      </span>
                    </span>
                    <span className="mt-2 grid grid-cols-3 gap-x-4 gap-y-2 sm:grid-cols-6">
                      <Fig name="Cases" value={r.cases.length} />
                      <Fig name="Passed" value={pct(r.summary.pass_rate)} />
                      <Fig name="Average score" value={`${mean(r.summary.avg_scores).toFixed(1)} of 5`} />
                      <Fig name="Signs" value={r.summary.signs_total} />
                      <Fig name="Cost" value={money(r.summary.cost)} />
                      <Fig name="Average time" value={secs(r.summary.avg_ms)} />
                    </span>
                    <span className="mt-2 block text-xs text-fg-muted">
                      {SCORE_KEYS.map((k) => `${SCORE_NAMES[k]} ${r.summary.avg_scores[k].toFixed(1)}`).join(" · ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <Compare before={before} after={after} setBefore={setBefore} setAfter={setAfter} />

            {run && (
              <section className="mt-8">
                <h2 className="text-sm font-semibold text-fg">The cases in {run.label}</h2>
                <p className="mt-0.5 text-xs text-fg-muted">
                  {modelName(run.design_model)} designing · the owner played by {modelName(run.sim_model)} · graded by{" "}
                  {modelName(run.grade_model)} · spent {money(run.spent)} of {money(run.cap)}
                  {run.partial ? " · stopped before every case ran" : ""}
                </p>
                <ul className="mt-3 space-y-2">
                  {run.cases.map((c) => (
                    <li key={c.id}>
                      <CaseDetail c={c} />
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </PageFrame>
  );
}

function Compare({
  before,
  after,
  setBefore,
  setAfter,
}: {
  before: string;
  after: string;
  setBefore: (f: string) => void;
  setAfter: (f: string) => void;
}) {
  const options = RUNS.map((r) => ({ value: r.file, label: `${r.label} · ${when(r.started)}` }));
  const a = RUNS.find((r) => r.file === before);
  const b = RUNS.find((r) => r.file === after);
  const same = !!a && !!b && a.design_model === b.design_model;
  return (
    <section className={`${card} mt-6 p-4 sm:p-5`}>
      <h2 className="text-sm font-semibold text-fg">Before and after</h2>
      <p className="mt-0.5 text-xs text-fg-muted">
        Two runs case by case: each criterion before and after, and what the scores and the cost moved by.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <div className={label}>Before</div>
          <Select label="Before" value={before} options={options} onChange={setBefore} empty="Choose a run" />
        </div>
        <div>
          <div className={label}>After</div>
          <Select label="After" value={after} options={options} onChange={setAfter} empty="Choose a run" />
        </div>
      </div>
      {a && b && !same && (
        <div className={`${note.attention} mt-3`}>
          Not compared: these runs were made on different design models ({modelName(a.design_model)} and{" "}
          {modelName(b.design_model)}). A change of model moves every number; compare two runs on the same one.
        </div>
      )}
      {a && b && same && (
        <ul className="mt-4 divide-y divide-line border-t border-line">
          {[...new Set([...a.cases.map((c) => c.id), ...b.cases.map((c) => c.id)])].map((id) => (
            <Compared key={id} x={a.cases.find((c) => c.id === id)} y={b.cases.find((c) => c.id === id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One case in two runs: either may be missing, when a run stopped before it. */
function Compared({ x, y }: { x: CaseResult | undefined; y: CaseResult | undefined }) {
  const title = (y ?? x)?.title ?? "";
  const criteria = [...new Set([...(x?.criteria ?? []), ...(y?.criteria ?? [])].map((c) => c.text))];
  const mustNot = [...new Set([...(x?.must_not ?? []), ...(y?.must_not ?? [])].map((c) => c.text))];
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[13px] font-medium text-fg">{title}</span>
        <Pair before={<Verdict c={x} />} after={<Verdict c={y} />} />
      </div>
      <ul className="mt-2 space-y-1.5">
        {criteria.map((text) => (
          <li key={text} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-xs">
            <span className="min-w-0 flex-1 basis-56 text-fg-muted">{text}</span>
            <Pair
              before={<Met met={x?.criteria.find((c) => c.text === text)?.met} />}
              after={<Met met={y?.criteria.find((c) => c.text === text)?.met} />}
            />
          </li>
        ))}
        {mustNot.map((text) => (
          <li key={`not-${text}`} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-xs">
            <span className="min-w-0 flex-1 basis-56 text-fg-muted">Must not: {text}</span>
            <Pair
              before={<Hit hit={x?.must_not.find((c) => c.text === text)?.hit} />}
              after={<Hit hit={y?.must_not.find((c) => c.text === text)?.hit} />}
            />
          </li>
        ))}
      </ul>
      {x && y && (
        <p className="mt-2 text-xs text-fg-faint">
          {SCORE_KEYS.map((k) => `${SCORE_NAMES[k]} ${moved(y.scores[k] - x.scores[k], (n) => n.toFixed(0))}`).join(
            " · "
          )}{" "}
          · Signs {moved(signCount(y) - signCount(x), String)} · Cost {money(x.cost)} then {money(y.cost)} (
          {moved(y.cost - x.cost, money)})
        </p>
      )}
    </li>
  );
}

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-fg-muted">{title}</h3>
      <div className="mt-1.5 space-y-2">{children}</div>
    </div>
  );
}

function Quoted({ text }: { text: string }) {
  return text ? <p className="mt-0.5 text-xs break-words text-fg-faint">“{text}”</p> : null;
}

function CaseDetail({ c }: { c: CaseResult }) {
  const passed = casePassed(c);
  return (
    <details className={`${card} group`}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 select-none sm:px-5">
        <ChevronRight
          aria-hidden
          size={14}
          strokeWidth={2}
          className="shrink-0 text-fg-faint transition-transform duration-150 group-open:rotate-90"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-fg">{c.title}</span>
          <span className="block text-xs text-fg-faint">
            {c.turns} turn{c.turns === 1 ? "" : "s"} · {c.built ? "built" : "nothing built"} · {money(c.cost)} ·{" "}
            {secs(c.ms)}
          </span>
        </span>
        <Pill tone={passed ? "success" : "critical"}>{passed ? "Passed" : "Failed"}</Pill>
      </summary>
      <div className="space-y-4 border-t border-line px-4 py-3 sm:px-5">
        <Part title="What it had to do">
          {c.criteria.map((x) => (
            <div key={x.text}>
              <div className="flex items-start gap-2 text-xs">
                <span className="min-w-0 flex-1 text-fg">{x.text}</span>
                <Met met={x.met} />
              </div>
              <Quoted text={x.evidence} />
            </div>
          ))}
        </Part>
        <Part title="What it must not do">
          {c.must_not.map((x) => (
            <div key={x.text}>
              <div className="flex items-start gap-2 text-xs">
                <span className="min-w-0 flex-1 text-fg">{x.text}</span>
                <Hit hit={x.hit} />
              </div>
              {x.hit && <Quoted text={x.evidence} />}
            </div>
          ))}
        </Part>
        <Part title="Signs">
          <ul className="space-y-1 text-xs text-fg">
            {c.signs.workarounds.map((w) => (
              <li key={w}>{w}</li>
            ))}
            {c.signs.jargon.length > 0 && <li>Words the owner read: {c.signs.jargon.join(", ")}</li>}
            <li className={c.built && !c.signs.proposed_first ? "" : "text-fg-muted"}>
              {c.signs.proposed_first
                ? "The plan was said in words first"
                : c.built
                  ? "Built with no plan said in words first"
                  : "No plan in words, and nothing built"}
            </li>
          </ul>
        </Part>
        <Part title="Scores">
          <p className="text-xs text-fg">
            {SCORE_KEYS.map((k) => `${SCORE_NAMES[k]} ${c.scores[k]} of 5`).join(" · ")}
          </p>
        </Part>
        {c.transcript && c.transcript.length > 0 && (
          <Part title="The conversation">
            {c.transcript.map((l, i) => (
              <p key={i} className="text-xs break-words whitespace-pre-wrap">
                <span className="font-medium text-fg">
                  {l.who === "owner" ? "Owner" : l.who === "luke" ? "Luke" : "App"}
                </span>{" "}
                <span className="text-fg-muted">{l.text}</span>
              </p>
            ))}
          </Part>
        )}
      </div>
    </details>
  );
}
