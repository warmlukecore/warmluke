"use client";

// ─────────────────────────────────────────────────────────────
// Invites — links an administrator sends a customer (0119).
//
// A link opens a sign-up with what is already known filled in (their
// email, name, business), then onboarding. It works for 72 hours unless
// set otherwise, can be made to end sooner or later from here, and can be
// withdrawn. An invite for one email is for that one person; one without
// an email can be for several.
//
// Everything goes through functions that refuse anyone who is not an
// administrator; the page itself decides nothing.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy } from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";
import { PageFrame } from "@/components/PageFrame";
import { Choices } from "@/components/AdminParts";
import { button, card, field, fieldOf, label, note } from "@/components/ui/controls";

type Invite = {
  id: string;
  token: string;
  email: string | null;
  full_name: string | null;
  business_name: string | null;
  note: string | null;
  max_uses: number;
  uses: number;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  state: "open" | "used" | "expired" | "revoked";
  claimed_by: Array<{ email: string; at: string }>;
};

/** How long a link works, in hours: the choices, with 72 the default. */
const LASTS: Array<[number, string]> = [
  [24, "24 hours"],
  [72, "72 hours"],
  [168, "7 days"],
  [720, "30 days"],
];
const DEFAULT_HOURS = 72;

const STATE: Record<Invite["state"], [string, string]> = {
  open: ["Open", "bg-tone-success text-tone-success-fg"],
  used: ["Used", "bg-tone-neutral text-tone-neutral-fg"],
  expired: ["Ran out", "bg-tone-attention text-tone-attention-fg"],
  revoked: ["Withdrawn", "bg-tone-critical text-tone-critical-fg"],
};

const linkFor = (token: string) => `${window.location.origin}/start/${token}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/** "in 2 days" or "3 h ago", for a moment either side of now. */
function relative(iso: string, now: number) {
  const ms = Date.parse(iso) - now;
  const mins = Math.round(Math.abs(ms) / 60000);
  const say = mins < 60 ? `${Math.max(1, mins)} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
  return ms >= 0 ? `in ${say}` : `${say} ago`;
}

export default function Invites() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [rows, setRows] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The new invite.
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [business, setBusiness] = useState("");
  const [memo, setMemo] = useState("");
  const [hours, setHours] = useState(DEFAULT_HOURS);
  const [many, setMany] = useState(false);
  const [count, setCount] = useState("10");
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<{ token: string; until: string } | null>(null);

  // One row at a time: the one whose end is being moved, or withdrawn.
  const [moving, setMoving] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && !user) router.replace("/login?next=/admin/invites");
  }, [loading, user, router]);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc("abo_admin_invites");
    setNow(Date.now());
    if (err) {
      setError(
        err.code === "42501"
          ? "This page is for administrators."
          : err.code === "PGRST202"
            ? "This database does not have invites yet: apply migration 0119."
            : err.message
      );
      setRows([]);
      return;
    }
    setError(null);
    setRows((data ?? []) as Invite[]);
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  const named = email.trim().length > 0;
  const uses = named || !many ? 1 : Math.min(1000, Math.max(1, Number.parseInt(count, 10) || 1));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    const { data, error: err } = await supabase.rpc("abo_admin_invite_create", {
      p_email: email,
      p_full_name: fullName,
      p_business_name: business,
      p_note: memo,
      p_hours: hours,
      p_max_uses: uses,
    });
    setCreating(false);
    if (err || !data) {
      setError(err?.message ?? "The invite couldn’t be made. Try again.");
      return;
    }
    setMade({ token: data as string, until: new Date(Date.now() + hours * 3600e3).toISOString() });
    setEmail("");
    setFullName("");
    setBusiness("");
    setMemo("");
    setMany(false);
    load();
  }

  async function copy(token: string) {
    try {
      await navigator.clipboard.writeText(linkFor(token));
      setCopied(token);
      setTimeout(() => setCopied((c) => (c === token ? null : c)), 2000);
    } catch {
      setError("Copying was refused by the browser. Select the link and copy it by hand.");
    }
  }

  async function change(id: string, next: { hours?: number; revoke?: boolean }) {
    setBusy(id);
    setError(null);
    const { error: err } = await supabase.rpc("abo_admin_invite_update", {
      p_id: id,
      p_hours: next.hours ?? null,
      p_revoke: !!next.revoke,
    });
    setBusy(null);
    setMoving(null);
    setWithdrawing(null);
    if (err) {
      setError(err.message);
      return;
    }
    load();
  }

  if (loading || !user || rows === null) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-32 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 h-72 animate-pulse rounded-card bg-surface shadow-card" />
        </div>
      </PageFrame>
    );
  }

  const refused = error === "This page is for administrators.";
  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Invites</h1>
        <p className="mt-1 text-[13px] text-fg-muted">
          A link you send a customer. It opens a sign-up with what you already know filled in, then onboarding.
        </p>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {!refused && (
          <>
            <form onSubmit={create} className={`${card} mt-6 p-5`}>
              <h2 className="text-[13px] font-semibold text-fg">New invite</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="inv-email" className={label}>
                    Their email <span className="font-normal text-fg-faint">(optional)</span>
                  </label>
                  <input
                    id="inv-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="asha@raoceramics.in"
                    autoComplete="off"
                    className={field}
                  />
                </div>
                <div>
                  <label htmlFor="inv-name" className={label}>
                    Their name <span className="font-normal text-fg-faint">(optional)</span>
                  </label>
                  <input id="inv-name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={120} className={field} />
                </div>
                <div>
                  <label htmlFor="inv-business" className={label}>
                    Their business <span className="font-normal text-fg-faint">(optional)</span>
                  </label>
                  <input id="inv-business" value={business} onChange={(e) => setBusiness(e.target.value)} maxLength={160} className={field} />
                </div>
                <div>
                  <label htmlFor="inv-note" className={label}>
                    A note for you <span className="font-normal text-fg-faint">(only admins see it)</span>
                  </label>
                  <input
                    id="inv-note"
                    value={memo}
                    onChange={(e) => setMemo(e.target.value)}
                    maxLength={300}
                    placeholder="Met at the Mumbai expo"
                    className={field}
                  />
                </div>
              </div>

              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <div>
                  <div className={label}>Works for</div>
                  <Choices options={LASTS} value={hours} onChange={setHours} />
                </div>
                <div>
                  <div className={label}>Who can use it</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Choices
                      options={[
                        [0, "One person"],
                        [1, "Several people"],
                      ]}
                      value={named || !many ? 0 : 1}
                      onChange={(v) => setMany(v === 1)}
                      disabled={named}
                    />
                    {many && !named && (
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        value={count}
                        onChange={(e) => setCount(e.target.value)}
                        aria-label="How many people"
                        className={`${fieldOf("sm")} w-20 tabular-nums`}
                      />
                    )}
                  </div>
                  {named && <p className="mt-1.5 text-[11px] text-fg-faint">An invite for one email is for that one person.</p>}
                </div>
              </div>

              <div className="mt-5 flex items-center justify-end">
                <button type="submit" disabled={creating} className={button("primary")}>
                  {creating ? "Making the link…" : "Create link"}
                </button>
              </div>

              {made && (
                <div className={`${note.info} mt-4`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs">{linkFor(made.token)}</code>
                    <button type="button" onClick={() => copy(made.token)} className={button("secondary", "sm")}>
                      {copied === made.token ? <Check aria-hidden size={13} strokeWidth={2} /> : <Copy aria-hidden size={13} strokeWidth={2} />}
                      {copied === made.token ? "Copied" : "Copy link"}
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs">Send it to them however you talk to them. It works until {when(made.until)}.</p>
                </div>
              )}
            </form>

            <div className={`${card} thin-scroll mt-6 overflow-x-auto`}>
              {rows.length === 0 ? (
                <p className="px-4 py-8 text-center text-[13px] text-fg-muted">No invites yet. The first one you make appears here.</p>
              ) : (
                <table className="w-full text-left text-[13px]">
                  <thead className="border-b border-line bg-surface-subdued text-xs text-fg-muted">
                    <tr>
                      <th className="px-4 py-2.5 font-medium">For</th>
                      <th className="px-3 py-2.5 font-medium">State</th>
                      <th className="px-3 py-2.5 font-medium">Ends</th>
                      <th className="px-3 py-2.5 font-medium">Taken by</th>
                      <th className="px-3 py-2.5 font-medium">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((r) => {
                      const [stateText, tone] = STATE[r.state];
                      return (
                        <tr key={r.id} className="align-top">
                          <td className="px-4 py-3">
                            <div className="max-w-64 min-w-44">
                              <div className="truncate font-medium text-fg">{r.email ?? "Anyone with the link"}</div>
                              {(r.full_name || r.business_name) && (
                                <div className="truncate text-xs text-fg-muted">{[r.full_name, r.business_name].filter(Boolean).join(" · ")}</div>
                              )}
                              {r.note && (
                                <div className="truncate text-[11px] text-fg-faint" title={r.note}>
                                  {r.note}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-3">
                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${tone}`}>{stateText}</span>
                            <div className="mt-1 text-[11px] text-fg-faint tabular-nums">
                              {r.uses} of {r.max_uses} used
                            </div>
                          </td>
                          <td className="px-3 py-3 whitespace-nowrap text-fg-muted" title={when(r.expires_at)}>
                            {r.state === "revoked" ? null : relative(r.expires_at, now)}
                          </td>
                          <td className="px-3 py-3">
                            {r.claimed_by.length === 0 ? (
                              <span className="text-xs text-fg-faint">Nobody yet</span>
                            ) : (
                              <ul className="max-w-56 space-y-0.5 text-xs">
                                {r.claimed_by.map((c) => (
                                  <li key={c.email} className="truncate text-fg">
                                    {c.email}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            {r.state === "revoked" ? null : withdrawing === r.id ? (
                              <div className={`${note.attention} min-w-56`}>
                                <p>Withdraw this link? Anyone who opens it after this is told it was withdrawn.</p>
                                <div className="mt-2 flex gap-1.5">
                                  <button onClick={() => change(r.id, { revoke: true })} disabled={busy === r.id} className={button("critical", "sm")}>
                                    Withdraw
                                  </button>
                                  <button onClick={() => setWithdrawing(null)} className={button("plain", "sm")}>
                                    Keep it
                                  </button>
                                </div>
                              </div>
                            ) : moving === r.id ? (
                              <div className="min-w-56">
                                <div className="mb-1.5 text-xs text-fg-muted">End it, from now, in</div>
                                <div className="flex flex-wrap gap-1">
                                  {LASTS.map(([h, text]) => (
                                    <button key={h} onClick={() => change(r.id, { hours: h })} disabled={busy === r.id} className={button("secondary", "sm")}>
                                      {text}
                                    </button>
                                  ))}
                                  <button onClick={() => setMoving(null)} className={button("plain", "sm")}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex flex-wrap justify-end gap-1">
                                {r.state === "open" && (
                                  <button onClick={() => copy(r.token)} className={button("secondary", "sm")}>
                                    {copied === r.token ? "Copied" : "Copy link"}
                                  </button>
                                )}
                                <button onClick={() => setMoving(r.id)} className={button("plain", "sm")}>
                                  {r.state === "expired" ? "Reopen" : "Change end"}
                                </button>
                                <button onClick={() => setWithdrawing(r.id)} className={button("critical-plain", "sm")}>
                                  Withdraw
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </PageFrame>
  );
}
