"use client";

// ─────────────────────────────────────────────────────────────
// Shopify apps: stores that come through an app of their own (0150).
//
// Until the public app is approved, a merchant's store reaches Warmluke
// through an app made for it: one they created in their own Dev
// Dashboard, or one made for them with custom distribution. It is added
// here once (its client ID and secret, the stores it serves, the
// Warmluke account it is for) and from then on that store's install,
// tokens, webhooks and imports go through it.
//
// The secret is written and never read back. Everything goes through
// functions that refuse anyone who is not an administrator.
// ─────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Plus } from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { useUser } from "@/lib/auth";
import { PageFrame } from "@/components/PageFrame";
import { Dialog } from "@/components/ui/Dialog";
import { Switch } from "@/components/ui/Switch";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { button, card, field, label, note } from "@/components/ui/controls";
import { missingScopes, ownAppSettings } from "@/lib/shopify-resources";
import { windowName } from "@/lib/when";

type Shop = {
  shop: string;
  status: string | null;
  connected_at: string | null;
  last_synced_at: string | null;
  webhook_error: string | null;
  scopes: string[] | null;
  project: string | null;
  owner: string | null;
  /** The store came through this app (0156): the one its deliveries and renewals use. */
  verified: boolean;
};
type App = {
  id: string;
  label: string;
  client_id: string;
  owner_email: string | null;
  /** Set up by the merchant themselves, in onboarding (0156). */
  self_serve: boolean;
  all_orders: boolean;
  enabled: boolean;
  secret_set_at: string | null;
  created_at: string;
  shops: Shop[];
};
type State = { internal: boolean; server_key_set: boolean; apps: App[] };
type Draft = {
  id: string | null;
  label: string;
  client_id: string;
  secret: string;
  shops: string;
  owner_email: string;
  all_orders: boolean;
  enabled: boolean;
};

const EMPTY: Draft = {
  id: null,
  label: "",
  client_id: "",
  secret: "",
  shops: "",
  owner_email: "",
  all_orders: false,
  enabled: true,
};

const STATUS: Record<string, [string, string]> = {
  connected: ["Connected", "bg-tone-success text-tone-success-fg"],
  uninstalled: ["Uninstalled", "bg-tone-attention text-tone-attention-fg"],
  pending: ["Connecting", "bg-tone-neutral text-tone-neutral-fg"],
};

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";

/** The scopes an app is asked for: the same list the install asks for. */
const scopesAsked = (allOrders: boolean) => ({
  ...process.env,
  SHOPIFY_READ_ALL_ORDERS: allOrders ? "true" : "false",
});

export default function ShopifyAppsAdmin() {
  const { user, loading } = useUser();
  const router = useRouter();
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    if (!loading && !user) router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }, [loading, user, router]);
  useEffect(() => setOrigin(window.location.origin), []);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc("abo_admin_shopify_apps");
    if (err) {
      setError(
        err.code === "42501"
          ? "This page is for administrators."
          : err.code === "PGRST202"
            ? "This database does not have Shopify apps yet: apply migration 0150."
            : err.message
      );
      setState({ internal: true, server_key_set: false, apps: [] });
      return;
    }
    setError(null);
    setState(data as State);
  }, []);
  useEffect(() => {
    if (user) load();
  }, [user, load]);

  async function setInternal(on: boolean) {
    const { error: err } = await supabase.rpc("abo_admin_set_shopify_internal", { p_on: on });
    if (err) setError(err.message);
    load();
  }

  async function save() {
    if (!draft) return;
    // An app nobody's account points at is never opened: Connect with
    // Shopify finds an app by its owner's sign-in email.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.owner_email.trim())) {
      setFormError("Whose Warmluke account is this for? Their sign-in email, please.");
      return;
    }
    setSaving(true);
    setFormError(null);
    const { error: err } = await supabase.rpc("abo_admin_shopify_app_save", {
      p_id: draft.id,
      p_label: draft.label,
      p_client_id: draft.client_id,
      p_secret: draft.secret || null,
      p_shops: draft.shops.split(/[\s,]+/).filter(Boolean),
      p_owner_email: draft.owner_email.trim(),
      p_all_orders: draft.all_orders,
      p_enabled: draft.enabled,
    });
    setSaving(false);
    if (err) {
      setFormError(err.message);
      return;
    }
    setDraft(null);
    load();
  }

  async function remove(app: App) {
    const { error: err } = await supabase.rpc("abo_admin_shopify_app_delete", { p_id: app.id });
    setDeleting(null);
    if (err) setError(err.message);
    load();
  }

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }

  function edit(app: App) {
    setFormError(null);
    setDraft({
      id: app.id,
      label: app.label,
      client_id: app.client_id,
      secret: "",
      shops: app.shops.map((s) => s.shop).join("\n"),
      owner_email: app.owner_email ?? "",
      all_orders: app.all_orders,
      enabled: app.enabled,
    });
  }

  if (loading || !user || state === null) {
    return (
      <PageFrame email={user?.email} isSuperadmin>
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
          <div className="h-6 w-40 animate-pulse rounded bg-surface-hover" />
          <div className="mt-6 h-72 animate-pulse rounded-card bg-surface shadow-card" />
        </div>
      </PageFrame>
    );
  }

  const refused = error === "This page is for administrators.";
  const setup: Array<[string, string, string]> = ownAppSettings(origin, false).map((s) => [s.key, s.name, s.value]);

  return (
    <PageFrame email={user.email} isSuperadmin={!refused}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-8 sm:py-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-fg">Shopify apps</h1>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-fg-muted">
              A merchant&rsquo;s store that comes through an app of its own, until the public app is approved. Add the
              app once, and its store&rsquo;s connection, webhooks and imports go through it.
            </p>
          </div>
          {!refused && (
            <button
              onClick={() => {
                setFormError(null);
                setDraft(EMPTY);
              }}
              className={button("primary", "sm")}
            >
              <Plus aria-hidden size={14} strokeWidth={2} />
              Add an app
            </button>
          )}
        </div>

        {error && (
          <div role="alert" className={`${note.critical} mt-5 text-[13px]`}>
            {error}
          </div>
        )}

        {!refused && !state.server_key_set && (
          <div className={`${note.attention} mt-5 text-[13px] leading-relaxed`}>
            The server key isn&rsquo;t set up on this database yet, so no store can use an app of its own. Run{" "}
            <code className="rounded bg-surface-subdued px-1">
              node scripts/set-shopify-apps-key.mjs --env .env.local
            </code>{" "}
            once, from the repository.
          </div>
        )}

        {!refused && (
          <div className={`${card} mt-6 flex items-start justify-between gap-4 p-5`}>
            <div>
              <div className="text-[13px] font-medium text-fg">Internal mode</div>
              <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-fg-muted">
                {state.internal
                  ? "On: a merchant connects only through an app set up here for their store. Anyone else is told their store isn't set up yet."
                  : "Off: every store can connect through the public app. Stores set up here still use their own app."}
              </p>
            </div>
            <Switch checked={state.internal} onChange={setInternal} label="Internal mode" />
          </div>
        )}

        {!refused && <OrderHistoryCard />}

        {!refused && (
          <div className={`${card} mt-4 p-5`}>
            <div className="text-[13px] font-medium text-fg">What the merchant sets in their app</div>
            <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
              In the Dev Dashboard, on their app&rsquo;s version: these four, then <strong>Release</strong>. Nothing
              changes until a version is released. Then they send you the Client ID and Client secret, from Settings.
            </p>
            <ul className="mt-3 divide-y divide-line overflow-hidden rounded-card border border-line">
              {setup.map(([key, name, value]) => (
                <li key={key} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-44 shrink-0 text-xs text-fg-muted">{name}</span>
                  <code className="min-w-0 flex-1 truncate text-xs text-fg">{value}</code>
                  <button
                    onClick={() => copy(key, value)}
                    aria-label={`Copy ${name}`}
                    className={button("secondary", "sm")}
                  >
                    {copied === key ? <Check aria-hidden size={13} /> : <Copy aria-hidden size={13} />}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs leading-relaxed text-fg-muted">
              Orders older than 60 days need Shopify&rsquo;s <code>read_all_orders</code> on their app as well. Switch
              on &ldquo;Has read all orders&rdquo; only once Shopify has granted it: asking for it before then stops the
              connection.
            </p>
          </div>
        )}

        {!refused && state.apps.length === 0 && (
          <div className="mt-6 rounded-card border border-dashed border-line-strong px-4 py-8 text-center text-[13px] text-fg-muted">
            No apps yet. Every store connects through the main app.
          </div>
        )}

        <div className="mt-6 space-y-4">
          {state.apps.map((app) => (
            <div key={app.id} className={`${card} p-5`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold text-fg">{app.label}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        app.enabled ? "bg-tone-success text-tone-success-fg" : "bg-tone-critical text-tone-critical-fg"
                      }`}
                    >
                      {app.enabled ? "On" : "Off"}
                    </span>
                    {app.all_orders && (
                      <span className="rounded-full bg-tone-neutral px-2 py-0.5 text-[11px] font-medium text-tone-neutral-fg">
                        All orders
                      </span>
                    )}
                    {app.self_serve && (
                      <span className="rounded-full bg-tone-info px-2 py-0.5 text-[11px] font-medium text-tone-info-fg">
                        Set up by the merchant
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-fg-muted">
                    Client ID <code>{app.client_id}</code> · secret set {when(app.secret_set_at)}
                    {app.owner_email && <> · for {app.owner_email}</>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => edit(app)} className={button("secondary", "sm")}>
                    Edit
                  </button>
                  {deleting === app.id ? (
                    <>
                      <button onClick={() => remove(app)} className={button("critical", "sm")}>
                        Delete
                      </button>
                      <button onClick={() => setDeleting(null)} className={button("plain", "sm")}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setDeleting(app.id)} className={button("plain", "sm")}>
                      Delete
                    </button>
                  )}
                </div>
              </div>

              <ul className="mt-4 divide-y divide-line overflow-hidden rounded-card border border-line">
                {app.shops.map((s) => {
                  // Connected, but through another app than this one: what this
                  // app was granted says nothing about that connection.
                  const elsewhere = s.status === "connected" && !s.verified;
                  const [word, tone] = elsewhere
                    ? ["Connected through another app", "bg-surface-subdued text-fg-muted"]
                    : (STATUS[s.status ?? ""] ?? ["Not connected yet", "bg-surface-subdued text-fg-muted"]);
                  const missing =
                    s.status === "connected" && s.verified ? missingScopes(s.scopes, scopesAsked(app.all_orders)) : [];
                  return (
                    <li key={s.shop} className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="text-[13px] text-fg">{s.shop}</code>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{word}</span>
                        {s.project && (
                          <span className="text-xs text-fg-muted">
                            {s.project}
                            {s.owner && <> · {s.owner}</>}
                          </span>
                        )}
                      </div>
                      {s.status === "connected" && (
                        <div className="mt-1 text-[11px] text-fg-faint">
                          Connected {when(s.connected_at)} · last import {when(s.last_synced_at)}
                        </div>
                      )}
                      {s.webhook_error && (
                        <div className="mt-1 text-xs text-tone-critical-fg">
                          Shopify wouldn&rsquo;t take its updates subscription: {s.webhook_error}
                        </div>
                      )}
                      {missing.length > 0 && (
                        <div className="mt-1 text-xs text-tone-critical-fg">
                          Their app didn&rsquo;t grant {missing.join(", ")}. Add these to the app&rsquo;s scopes,
                          release, and connect the store again.
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {draft && (
        <Dialog
          title={draft.id ? `Edit ${draft.label}` : "Add a Shopify app"}
          description="From the merchant's app in the Dev Dashboard: its Settings has the Client ID and Client secret."
          onClose={() => setDraft(null)}
          footer={
            <>
              <button onClick={() => setDraft(null)} className={`${button("plain")} ml-auto`}>
                Cancel
              </button>
              <button onClick={save} disabled={saving} className={button("primary")}>
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            {formError && <div className={note.critical}>{formError}</div>}
            <div>
              <label htmlFor="app-label" className={label}>
                Name
              </label>
              <input
                id="app-label"
                className={field}
                value={draft.label}
                placeholder="Tanish's stores"
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="app-client" className={label}>
                Client ID
              </label>
              <input
                id="app-client"
                className={field}
                value={draft.client_id}
                readOnly={!!draft.id}
                placeholder="32 letters and digits"
                onChange={(e) => setDraft({ ...draft, client_id: e.target.value.trim() })}
              />
            </div>
            <div>
              <label htmlFor="app-secret" className={label}>
                Client secret
              </label>
              <PasswordInput
                id="app-secret"
                value={draft.secret}
                autoComplete="off"
                placeholder={draft.id ? "Leave empty to keep the one saved" : "shpss_…"}
                onChange={(e) => setDraft({ ...draft, secret: e.target.value.trim() })}
              />
              <p className="mt-1 text-xs text-fg-muted">
                Saved encrypted and never shown again. A new secret means its stores connect again, so their updates
                arrive at the new address.
              </p>
            </div>
            <div>
              <label htmlFor="app-shops" className={label}>
                Stores, one per line
              </label>
              <textarea
                id="app-shops"
                className={`${field} min-h-[72px]`}
                value={draft.shops}
                placeholder="theirstore.myshopify.com"
                onChange={(e) => setDraft({ ...draft, shops: e.target.value })}
              />
            </div>
            <div>
              <label htmlFor="app-owner" className={label}>
                Warmluke account it&rsquo;s for
              </label>
              <input
                id="app-owner"
                type="email"
                required
                className={field}
                value={draft.owner_email}
                placeholder="their sign-in email"
                onChange={(e) => setDraft({ ...draft, owner_email: e.target.value })}
              />
              <p className="mt-1 text-xs text-fg-muted">
                Their Connect with Shopify then opens this app, with nothing to type.
              </p>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-[13px] text-fg">Has read all orders</span>
              <Switch
                checked={draft.all_orders}
                onChange={(on) => setDraft({ ...draft, all_orders: on })}
                label="Has read all orders"
              />
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-[13px] text-fg">On</span>
              <Switch checked={draft.enabled} onChange={(on) => setDraft({ ...draft, enabled: on })} label="On" />
            </div>
          </div>
        </Dialog>
      )}
    </PageFrame>
  );
}

type HistoryOffer = { enabled: boolean; choices: number[]; default_days: number };

/**
 * How far back merchants may bring orders and customers (0154): offered
 * here, chosen by each merchant right after Shopify says yes. Saved in
 * one go, and checked again by the database, which refuses a default
 * that is not one of the windows offered.
 */
function OrderHistoryCard() {
  const [saved, setSaved] = useState<HistoryOffer | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    supabase
      .from("history_settings")
      .select("enabled, choices, default_days")
      .maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        const offer = data as HistoryOffer;
        setSaved(offer);
        setEnabled(offer.enabled);
        setText(offer.choices.join(", "));
        setChosen(offer.default_days);
      });
  }, []);

  const words = text.split(/[\s,]+/).filter(Boolean);
  const notNumbers = words.some((w) => !/^\d+$/.test(w));
  const days = [...new Set(words.map(Number))].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const outOfRange = days.some((d) => d > 3650) || days.length > 12;
  const usable = !notNumbers && !outOfRange && days.length > 0 && chosen !== null && days.includes(chosen);
  const dirty =
    !!saved && (enabled !== saved.enabled || days.join() !== saved.choices.join() || chosen !== saved.default_days);

  async function save() {
    if (!saved) return;
    setBusy(true);
    setSaid(null);
    // Off, the windows are only kept for when it is on again: what was
    // saved goes back if what is typed would not be accepted.
    const keep = usable
      ? { p_choices: days, p_default: chosen }
      : { p_choices: saved.choices, p_default: saved.default_days };
    const { data, error } = await supabase.rpc("abo_admin_set_history_settings", { p_enabled: enabled, ...keep });
    setBusy(false);
    if (error) {
      setSaid({ ok: false, text: error.message });
      return;
    }
    const offer = data as HistoryOffer;
    setSaved(offer);
    setText(offer.choices.join(", "));
    setChosen(offer.default_days);
    setSaid({ ok: true, text: "Saved. New choices are offered from the next picker that opens." });
  }

  return (
    <div className={`${card} mt-4 p-5`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[13px] font-medium text-fg">Order history</div>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-fg-muted">
            {enabled
              ? "On: right after Shopify says yes, a merchant chooses how far back orders and customers come in. Products always come in full."
              : "Off: nobody is asked, and a new store brings everything Shopify shares. Windows merchants already chose stay as they are."}
          </p>
        </div>
        <Switch checked={enabled} onChange={setEnabled} label="Ask merchants how far back" />
      </div>
      {saved === null ? (
        <div className="mt-4 h-16 animate-pulse rounded-control bg-surface-subdued" aria-busy />
      ) : (
        enabled && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="history-windows" className={label}>
                Windows offered, in days
              </label>
              <input
                id="history-windows"
                className={field}
                value={text}
                placeholder="30, 60, 90, 180, 365"
                aria-invalid={notNumbers || outOfRange}
                onChange={(e) => setText(e.target.value)}
              />
              <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">
                {notNumbers
                  ? "Whole numbers of days only, separated by commas."
                  : outOfRange
                    ? "Up to twelve windows, each up to 3,650 days."
                    : "Past 60 days needs read_all_orders on the store\u2019s app; without it those are shown, greyed out."}
              </p>
            </div>
            <div>
              <div className={label}>Preselected, and taken when nobody chooses</div>
              <div role="radiogroup" aria-label="Default window" className="flex flex-wrap gap-1.5">
                {days.map((d) => (
                  <button
                    key={d}
                    role="radio"
                    aria-checked={chosen === d}
                    onClick={() => setChosen(d)}
                    className={button(chosen === d ? "secondary" : "plain", "sm")}
                  >
                    {chosen === d && <Check aria-hidden size={12} strokeWidth={2.5} />}
                    {windowName(d)}
                  </button>
                ))}
              </div>
              {days.length > 0 && (chosen === null || !days.includes(chosen)) && (
                <p className="mt-1.5 text-xs text-tone-critical-fg">Pick one of the windows as the default.</p>
              )}
            </div>
          </div>
        )
      )}
      {said && (
        <div role="status" className={`${said.ok ? note.success : note.critical} mt-4 text-[13px]`}>
          {said.text}
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <button onClick={save} disabled={!dirty || busy || (enabled && !usable)} className={button("primary", "sm")}>
          {busy ? "Saving\u2026" : "Save"}
        </button>
      </div>
    </div>
  );
}
