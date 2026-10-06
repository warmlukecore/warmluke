"use client";

// One account, all of it: opened from its row on the accounts screen.
//
// The row already has what they told us and the numbers. This adds what
// only the database can join: the apps they own with each one's stores,
// how they came to us (an invite, a demo request, or neither), and what
// administrators have done to the account. Read through
// abo_admin_account (0120), which refuses anyone who is not an
// administrator. It changes nothing; the row's own controls do that.
//
// Callers: src/app/[gate]/page.tsx.

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { Dialog } from "@/components/ui/Dialog";
import { button, field, label, note } from "@/components/ui/controls";
import { DEMO_STAGES, STAGE_TONE, scrollList, siteLink } from "@/components/AdminParts";
import {
  HEARD_OPTIONS,
  MEMBER_ROLE_OPTIONS,
  ORDER_OPTIONS,
  PLATFORM_OPTIONS,
  ROLE_OPTIONS,
  TEAM_OPTIONS,
  labelOf,
} from "@/lib/onboarding";
import { ago } from "@/lib/when";
import { CORE_STORE_TABLES, STORE_TABLES, type StoreShown, type StoreTable } from "@/lib/store-read";
import { Select } from "@/components/ui/Select";
import { Switch } from "@/components/ui/Switch";
import { TickBox } from "@/components/views";
import { modelName } from "@/lib/model-prices";
import { SHOWS_WORDS } from "@/components/LukeAccess";

/** A row of abo_admin_accounts. */
export type Account = {
  user_id: string;
  email: string;
  chat_enabled: boolean;
  mcp_enabled: boolean;
  store_actions_enabled: boolean;
  free_turns: number;
  turns_used: number;
  turns_unlimited: boolean;
  is_superadmin: boolean;
  projects: number;
  stores: number;
  created_at: string;
  // What they said in onboarding (0112). Absent on a database that has
  // not had it yet, and null for an account that has not answered.
  full_name?: string | null;
  business_name?: string | null;
  role?: string | null;
  monthly_orders?: string | null;
  platform?: string | null;
  website?: string | null;
  team_size?: string | null;
  heard_from?: string | null;
  heard_from_detail?: string | null;
  onboarded_at?: string | null;
  last_sign_in_at?: string | null;
  // 0118: whether they may sign in, and the apps they were invited into.
  suspended?: boolean;
  memberships?: Array<{
    project: string;
    owner: string | null;
    name: string | null;
    role: string | null;
    joined_at: string | null;
  }>;
};

type Story = {
  projects: Array<{
    id: string;
    name: string;
    created_at: string;
    members: number;
    /** 0140: who is on the team, where each stands, and what each can open. Absent before it. */
    team?: Array<{
      name: string | null;
      email: string | null;
      role: string | null;
      joined_at: string | null;
      last_seen_at: string | null;
      can_see_store: boolean;
      sections: number;
    }>;
    sections?: number;
    stores: Array<{
      domain: string | null;
      status: string;
      connected_at: string | null;
      last_synced_at: string | null;
      problem: string | null;
    }>;
  }>;
  invite: { by: string | null; note: string | null; made_at: string; claimed_at: string } | null;
  demos: Array<{ id: string; at: string; store: string | null; note: string | null; stage: string }>;
  trail: Array<{
    action: string;
    old_value: Record<string, unknown> | null;
    new_value: Record<string, unknown> | null;
    at: string;
    by: string | null;
  }>;
};

/** The switches, by the names the accounts table gives them. */
const SWITCH: Record<string, string> = { chat: "Warmluke AI", mcp: "Their own AI", store_actions: "Change their shop" };

/** A rename's apps, before or after: id to name. */
const appNames = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, string>) : {});

/** What an administrator did, as a sentence. */
function said({ action, old_value, new_value }: Story["trail"][number]): string {
  const was = old_value ?? {};
  const now = new_value ?? {};
  switch (action) {
    case "set_feature":
      return `${SWITCH[String(now.feature)] ?? String(now.feature)} switched ${now.enabled ? "on" : "off"}`;
    case "set_turns":
      return `Included designs ${was.free_turns ?? "?"} → ${now.free_turns ?? "?"}`;
    case "set_unlimited":
      return now.turns_unlimited ? "Design limit removed" : "Design limit put back";
    case "reset_turns":
      return `Used designs reset from ${was.turns_used ?? "?"} to 0`;
    case "suspend":
      return "Suspended";
    case "restore":
      return "Let back in";
    case "rename": {
      const parts = [
        now.full_name ? `name ${String(was.full_name ?? "?")} → ${String(now.full_name)}` : null,
        now.business_name ? `business ${String(was.business_name ?? "?")} → ${String(now.business_name)}` : null,
        ...Object.entries(appNames(now.apps)).map(([id, name]) => `app ${appNames(was.apps)[id] ?? "?"} → ${name}`),
      ].filter(Boolean);
      return `Renamed: ${parts.join("; ") || "nothing"}`;
    }
    case "set_columns": {
      const list = STORE_TABLES[String(now.list) as StoreTable]?.section.label ?? String(now.list);
      return Array.isArray(now.shown)
        ? `${list}: ${now.shown.length} ${now.shown.length === 1 ? "column" : "columns"} shown`
        : `${list}: every column shown`;
    }
    case "set_luke": {
      const models = Array.isArray(now.models) ? (now.models as string[]).map(modelName).join(", ") : "every model";
      const shows = SHOWS_WORDS.find(([v]) => v === now.shows)?.[1].toLowerCase() ?? String(now.shows);
      return `Luke: ${models}; under each reply, ${shows}`;
    }
    default:
      // One added since this list, by its own name ("set_x" as "Set x").
      return action.charAt(0).toUpperCase() + action.slice(1).replaceAll("_", " ");
  }
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="mb-2 text-xs font-medium text-fg-muted">{title}</h3>
      <div className="text-[13px] text-fg">{children}</div>
    </section>
  );
}

export function AccountDetail({
  account: a,
  now,
  onClose,
  onChanged,
}: {
  account: Account;
  now: number;
  onClose: () => void;
  /** After a rename: the list reads the account again. */
  onChanged?: () => void;
}) {
  // The console's own address ([gate]), for links to its other screens.
  const gate = useParams<{ gate: string }>().gate;
  const [story, setStory] = useState<Story | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    // A second row opened before the first answered keeps its own answer.
    let current = true;
    supabase.rpc("abo_admin_account", { p_user: a.user_id }).then(({ data, error: err }) => {
      if (!current) return;
      if (err) {
        setError(
          err.code === "P0002"
            ? "This account no longer exists. Close this and the list will catch up."
            : err.code === "PGRST202"
              ? "This database does not have account details yet: apply migration 0120."
              : err.message
        );
        return;
      }
      setStory(data as Story);
    });
    return () => {
      current = false;
    };
  }, [a.user_id]);

  const site = siteLink(a.website);
  const told = (
    [
      ["Business", a.business_name],
      ["Role", labelOf(ROLE_OPTIONS, a.role)],
      ["Orders a month", labelOf(ORDER_OPTIONS, a.monthly_orders)],
      ["Sells on", labelOf(PLATFORM_OPTIONS, a.platform)],
      ["Team", labelOf(TEAM_OPTIONS, a.team_size)],
      [
        "Website",
        site ? (
          // A value in a [label, value] pair, not a list item: the rows are keyed by label where they render.
          // oxlint-disable-next-line react/jsx-key
          <a href={site.href} target="_blank" rel="noopener noreferrer nofollow" className="text-link hover:underline">
            {site.text}
          </a>
        ) : (
          a.website
        ),
      ],
      [
        "Heard of us",
        a.heard_from
          ? `${labelOf(HEARD_OPTIONS, a.heard_from)}${a.heard_from_detail ? ` (${a.heard_from_detail})` : ""}`
          : null,
      ],
    ] as Array<[string, ReactNode]>
  ).filter(([, v]) => !!v);

  return (
    <Dialog
      tall
      title={a.full_name || a.email}
      description={
        <>
          {a.full_name ? `${a.email} · ` : ""}joined {day(a.created_at)} ·{" "}
          {ago(a.last_sign_in_at, now, "never signed in")}
          {a.suspended && (
            <span className="ml-1.5 rounded-full bg-tone-critical px-1.5 py-px text-[10px] font-medium text-tone-critical-fg">
              suspended
            </span>
          )}
        </>
      }
      onClose={onClose}
    >
      <div className="space-y-4">
        {/* The whole console narrowed to them (0184): spend, Luke, trouble, their AI, what stuck, as theirs. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link
            href={`/${gate}?account=${a.user_id}`}
            onClick={onClose}
            className="inline-flex text-[13px] font-medium text-link hover:underline"
          >
            See only this account across the console
          </Link>
          {/* Another administrator is not changed from here (abo_admin_may_manage). */}
          {!a.is_superadmin && story && !renaming && (
            <button onClick={() => setRenaming(true)} className={button("secondary", "sm")}>
              Rename
            </button>
          )}
        </div>
        {renaming && story && (
          <Rename
            account={a}
            apps={story.projects}
            onCancel={() => setRenaming(false)}
            onDone={() => {
              setRenaming(false);
              // Read again, so the apps and the trail say what changed.
              void supabase
                .rpc("abo_admin_account", { p_user: a.user_id })
                .then(({ data }) => data && setStory(data as Story));
              onChanged?.();
            }}
          />
        )}
        <Section title="What they told us">
          {a.is_superadmin ? (
            <p className="text-fg-muted">Warmluke team, not onboarded as a business.</p>
          ) : told.length ? (
            <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1.5">
              {told.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-fg-muted">{k}</dt>
                  <dd className="min-w-0 break-words">{v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-fg-muted">Nothing yet.</p>
          )}
          {!a.is_superadmin && !a.onboarded_at && (
            <p className="mt-2 text-xs text-tone-attention-fg">Onboarding not finished.</p>
          )}
        </Section>

        {error ? (
          <div role="alert" className={note.critical}>
            {error}
          </div>
        ) : !story ? (
          <div aria-busy className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-control bg-surface-hover" />
            ))}
          </div>
        ) : (
          <>
            <Section title="How they came to us">
              <ul className="space-y-1.5">
                {story.invite && (
                  <li>
                    Through an invite{story.invite.by ? ` from ${story.invite.by}` : ""}, made{" "}
                    {day(story.invite.made_at)}, used {ago(story.invite.claimed_at, now)}.
                    {story.invite.note && (
                      <span className="block text-xs text-fg-muted">&ldquo;{story.invite.note}&rdquo;</span>
                    )}
                  </li>
                )}
                {story.demos.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-1.5">
                    Asked for a demo {ago(d.at, now)}
                    {d.store ? ` for ${d.store}` : ""}
                    <span
                      className={`rounded-full px-1.5 py-px text-[10px] font-medium ${STAGE_TONE[d.stage] ?? STAGE_TONE.new}`}
                    >
                      {labelOf(DEMO_STAGES, d.stage)}
                    </span>
                    <Link
                      href={`/${gate}/demos?find=${encodeURIComponent(a.email)}`}
                      className="text-xs text-link hover:underline"
                    >
                      Open
                    </Link>
                  </li>
                ))}
                {!story.invite && story.demos.length === 0 && (
                  <li className="text-fg-muted">Signed up on their own.</li>
                )}
              </ul>
            </Section>

            <Section
              title={story.projects.length === 1 ? "The app they own" : `Apps they own (${story.projects.length})`}
            >
              {story.projects.length === 0 ? (
                <p className="text-fg-muted">None.</p>
              ) : (
                <ul className="space-y-2.5">
                  {story.projects.map((p) => (
                    <li key={p.id} className="rounded-control border border-line px-3 py-2">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-xs text-fg-muted">
                        Made {day(p.created_at)}
                        {p.members > 0 && ` · ${p.members} team ${p.members === 1 ? "member" : "members"}`}
                      </div>
                      {!!p.team?.length && (
                        // The team they built, as the owner sees it on People.
                        <ul className="mt-1.5 space-y-1 border-l border-line pl-2.5 text-xs">
                          {p.team.map((m, i) => (
                            <li key={`${m.email}-${i}`}>
                              <span className="font-medium text-fg">{m.name ?? m.email ?? "Someone"}</span>
                              {m.role && (
                                <span className="text-fg-muted"> · {labelOf(MEMBER_ROLE_OPTIONS, m.role)}</span>
                              )}
                              <span className="block text-fg-muted">
                                {m.name && m.email ? `${m.email} · ` : ""}
                                {m.last_seen_at
                                  ? `last active ${ago(m.last_seen_at, now)}`
                                  : m.joined_at
                                    ? `joined ${ago(m.joined_at, now)}, not back since`
                                    : "not joined yet"}
                                {` · sees ${m.sections} of ${p.sections ?? 0} sections`}
                                {m.can_see_store ? " · store" : " · no store"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {p.stores.length === 0 ? (
                        <div className="mt-1 text-xs text-fg-faint">No store connected</div>
                      ) : (
                        p.stores.map((s, i) => (
                          <div key={`${s.domain}-${i}`} className="mt-1.5 text-xs">
                            <div className="flex flex-wrap items-center gap-x-1.5">
                              <span className="font-medium text-fg">{s.domain ?? "A store"}</span>
                              <span
                                className={`rounded-full px-1.5 py-px text-[10px] font-medium ${
                                  s.status === "connected"
                                    ? "bg-tone-success text-tone-success-fg"
                                    : "bg-tone-neutral text-tone-neutral-fg"
                                }`}
                              >
                                {s.status}
                              </span>
                              {s.status === "connected" && (
                                <span className="text-fg-muted">synced {ago(s.last_synced_at, now, "never")}</span>
                              )}
                            </div>
                            {s.problem && <div className={`${note.critical} mt-1`}>{s.problem}</div>}
                          </div>
                        ))
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {!!a.memberships?.length && (
              <Section title="Seats in other people’s apps">
                <ul className="space-y-1.5">
                  {a.memberships.map((m) => (
                    <li key={`${m.project}-${m.joined_at}`}>
                      <span className="font-medium">{m.project}</span>
                      {m.role && <span className="text-fg-muted"> · {labelOf(MEMBER_ROLE_OPTIONS, m.role)}</span>}
                      <span className="block text-xs text-fg-muted">
                        {m.owner ? `Invited by ${m.owner}` : "Team member"}
                        {m.joined_at ? `, joined ${ago(m.joined_at, now)}` : ", not joined yet"}
                      </span>
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {!a.is_superadmin && (
              <StoreColumns
                userId={a.user_id}
                onSaved={() =>
                  // Read again, so the trail below says what changed.
                  void supabase
                    .rpc("abo_admin_account", { p_user: a.user_id })
                    .then(({ data }) => data && setStory(data as Story))
                }
              />
            )}

            <Section title="What administrators did">
              {story.trail.length === 0 ? (
                <p className="text-fg-muted">Nothing yet.</p>
              ) : (
                <ol className={`${scrollList} space-y-1.5`}>
                  {story.trail.map((t, i) => (
                    <li key={`${t.at}-${i}`} className="flex items-baseline justify-between gap-3">
                      <span>{said(t)}</span>
                      <span className="shrink-0 text-xs text-fg-faint" title={new Date(t.at).toLocaleString()}>
                        {t.by ?? "a former administrator"} · {ago(t.at, now)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The names an administrator may correct (0187): the person's, their
 * business's as onboarding took them, and each app they own. Blank keeps
 * a name; what changed goes in the access log.
 */
function Rename({
  account: a,
  apps,
  onCancel,
  onDone,
}: {
  account: Account;
  apps: Story["projects"];
  onCancel: () => void;
  onDone: () => void;
}) {
  // Onboarding made the profile; before it there is no name or business to correct.
  const hasProfile = a.full_name != null || a.business_name != null;
  const [name, setName] = useState(a.full_name ?? "");
  const [business, setBusiness] = useState(a.business_name ?? "");
  const [names, setNames] = useState<Record<string, string>>(Object.fromEntries(apps.map((p) => [p.id, p.name])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.rpc("abo_admin_rename", {
      p_user: a.user_id,
      p_full_name: hasProfile ? name : null,
      p_business: hasProfile ? business : null,
      p_apps: apps.map((p) => ({ id: p.id, name: names[p.id] ?? p.name })),
    });
    setBusy(false);
    if (err) {
      setError(err.code === "PGRST202" ? "This database cannot rename yet: apply migration 0187." : err.message);
      return;
    }
    onDone();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="space-y-3 rounded-control border border-line p-3"
    >
      {hasProfile ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className={label}>Name</span>
            <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className={field} />
          </label>
          <label>
            <span className={label}>Business</span>
            <input value={business} maxLength={160} onChange={(e) => setBusiness(e.target.value)} className={field} />
          </label>
        </div>
      ) : (
        <p className="text-xs text-fg-muted">No name or business yet: they have not finished onboarding.</p>
      )}
      {apps.map((p) => (
        <label key={p.id} className="block">
          <span className={label}>App</span>
          <input
            value={names[p.id] ?? ""}
            maxLength={120}
            onChange={(e) => setNames((n) => ({ ...n, [p.id]: e.target.value }))}
            className={field}
          />
        </label>
      ))}
      {error && (
        <div role="alert" className={note.critical}>
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={button("secondary", "sm")}>
          Cancel
        </button>
        <button type="submit" disabled={busy} className={button("primary", "sm")}>
          {busy ? "Saving…" : "Save names"}
        </button>
      </div>
    </form>
  );
}

/**
 * What this account is shown of each store list (0192), in every app it
 * owns and for its team there: every column, or the ones ticked. Luke and
 * their own AI see the same; the rows are still read whole. One list at a
 * time, saved when asked, each change in the trail.
 */
function StoreColumns({ userId, onSaved }: { userId: string; onSaved: () => void }) {
  const lists = [
    ...CORE_STORE_TABLES,
    ...(Object.keys(STORE_TABLES) as StoreTable[]).filter((t) => !CORE_STORE_TABLES.includes(t)),
  ];
  const [shown, setShown] = useState<StoreShown | null>(null);
  const [table, setTable] = useState<StoreTable>("orders");
  // Null: every column.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    void supabase.rpc("abo_admin_store_columns", { p_user: userId }).then(({ data, error }) => {
      if (error) setSaid(error.message);
      else setShown((data ?? {}) as StoreShown);
    });
  }, [userId]);
  useEffect(() => {
    setDraft(shown?.[table] ?? null);
  }, [shown, table]);

  const columns = STORE_TABLES[table].columns;
  const saved = shown?.[table] ?? null;
  const same = (x: string[] | null) => (x ? [...x].sort().join() : null);
  const dirty = same(draft) !== same(saved);
  const save = async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc("abo_admin_set_store_columns", {
      p_user: userId,
      p_table: table,
      p_shown: draft,
    });
    setBusy(false);
    if (error) return setSaid(error.message);
    setShown((data ?? {}) as StoreShown);
    setSaid("Saved");
    onSaved();
  };

  return (
    <Section title="Store columns">
      <p className="mb-2.5 text-xs text-fg-muted">
        What this account sees of each list from its store, in every app it owns and for its team there. Luke and their
        own AI see the same; the rows are still read whole.
      </p>
      {!shown ? (
        <div aria-busy className="h-16 animate-pulse rounded-control bg-surface-hover" />
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="w-56 max-w-full">
              <Select
                label="Store list"
                value={table}
                clearable={false}
                options={lists.map((t) => ({
                  value: t,
                  label: `${STORE_TABLES[t].section.label}${shown[t] ? ` · ${shown[t]!.length} of ${STORE_TABLES[t].columns.length}` : ""}`,
                }))}
                onChange={(v) => {
                  setTable(v as StoreTable);
                  setSaid(null);
                }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={!draft}
                onChange={(all) => {
                  setDraft(all ? null : columns.map((c) => c.field));
                  setSaid(null);
                }}
                label="Every column"
              />
              <span>Every column</span>
            </div>
          </div>
          {draft && (
            <fieldset className="grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3">
              <legend className="sr-only">Columns shown on {STORE_TABLES[table].section.label}</legend>
              {columns.map((c) => (
                <label key={c.field} className="flex min-w-0 items-center gap-1.5">
                  <TickBox
                    label={c.label}
                    checked={draft.includes(c.field)}
                    onChange={(on) => {
                      setDraft((d) => (on ? [...(d ?? []), c.field] : (d ?? []).filter((f) => f !== c.field)));
                      setSaid(null);
                    }}
                  />
                  <span className="truncate">{c.label}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={save}
              disabled={!dirty || busy || draft?.length === 0}
              className={button("primary", "sm")}
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <span role="status" className="text-xs text-fg-muted">
              {draft?.length === 0 ? "Keep at least one column, or show every column." : said}
            </span>
          </div>
        </div>
      )}
    </Section>
  );
}
