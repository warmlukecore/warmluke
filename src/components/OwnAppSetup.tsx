"use client";

// ─────────────────────────────────────────────────────────────
// OwnAppSetup — a merchant sets up their own Shopify app, and connects
// their store through it (0156).
//
// While Warmluke is in internal mode a store cannot come through the
// public app, so the merchant creates one of their own in Shopify's Dev
// Dashboard. Six steps, one open at a time: the store, creating the app,
// its settings (copied from here, the same list the admin page shows),
// its two keys, agreeing to how the secret is kept, and connecting. The
// place they are at is kept in this browser, never the secret, so a
// merchant who goes off to Shopify and comes back is where they were.
//
// A store that already has an app here — one they set up before, or one
// an administrator did — goes straight to Connect.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { apiFetch } from "@/lib/auth";
import { supabase } from "@/lib/supabase-client";
import { readShopAddress } from "@/lib/shop-address";
import { ownAppSettings } from "@/lib/shopify-resources";
import { button, field, fieldOf, hint, label, note } from "@/components/ui/controls";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Switch } from "@/components/ui/Switch";

type MyApp = {
  id: string;
  client_id: string;
  all_orders: boolean;
  enabled: boolean;
  mine: boolean;
  shops: Array<{ shop: string; verified: boolean; connected: boolean }>;
};

const STEPS = ["Your store", "Create the app", "Set it up", "Copy its keys", "Keep them safe", "Connect"] as const;
const LAST = STEPS.length - 1;
const DEV_DASHBOARD = "https://dev.shopify.com/dashboard/";
const SHOPIFY_GUIDE = "https://help.shopify.com/en/manual/apps/app-types/custom-apps";

const CLIENT_ID = /^[0-9a-f]{32}$/;
const SECRET = /^shpss_[A-Za-z0-9]{16,}$/;

export default function OwnAppSetup({
  projectId,
  initialShop = "",
  onCancel,
  cancelLabel = "Cancel",
}: {
  projectId: string;
  initialShop?: string;
  /** A way out, where there is one: onboarding gives none. */
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  const saveKey = `wl_own_app_${projectId}`;
  // Where they were, if they were here before: never the keys. Read once,
  // as the state is made, so nothing writes the blank start over it.
  const [was] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(saveKey) ?? "null") as {
        step?: number;
        shop?: string;
        allOrders?: boolean;
        skipped?: boolean;
      } | null;
    } catch {
      return null;
    }
  });
  // Back at the keys, not past them: the secret was not kept. Saved
  // already, it is not needed again.
  const [step, setStep] = useState(() => (was?.step === LAST ? LAST : Math.min(was?.step ?? 0, 3)));
  const [shop, setShop] = useState(was?.shop || initialShop);
  const [allOrders, setAllOrders] = useState(!!was?.allOrders);
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [agreed, setAgreed] = useState(false);
  // An app of theirs set up for another store, used for this one too.
  const [reuse, setReuse] = useState<string | null>(null);
  // Already set up here, so the steps between went by without them.
  const [skipped, setSkipped] = useState(!!was?.skipped);
  const [apps, setApps] = useState<MyApp[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Only ever drawn in the browser (ConnectShopify decides first).
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));

  useEffect(() => {
    supabase.rpc("abo_my_shopify_apps").then(({ data }) => setApps((data as MyApp[] | null) ?? []));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(saveKey, JSON.stringify({ step, shop, allOrders, skipped }));
    } catch {
      /* the place is lost on a reload, nothing else */
    }
  }, [saveKey, step, shop, allOrders, skipped]);

  const read = useMemo(() => readShopAddress(shop), [shop]);
  const domain = "domain" in read ? read.domain : null;
  // Set up already, by them or for them: nothing to create.
  const ready = !!domain && !!apps?.some((a) => a.enabled && a.shops.some((s) => s.shop === domain));
  const theirs = (apps ?? []).filter((a) => a.mine && a.enabled && !a.shops.some((s) => s.shop === domain));
  const settings = ownAppSettings(origin, allOrders);
  const idOk = CLIENT_ID.test(clientId.trim().toLowerCase());
  const secretOk = SECRET.test(secret.trim());

  const go = (to: number) => {
    setError(null);
    setStep(Math.max(0, Math.min(to, LAST)));
  };

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  }

  async function save() {
    if (!domain) return go(0);
    setBusy(true);
    setError(null);
    const { error: refused } = await supabase.rpc("abo_my_shopify_app_save", {
      p_client_id: reuse ?? clientId.trim().toLowerCase(),
      p_secret: reuse ? null : secret.trim(),
      p_shop: domain,
      p_all_orders: allOrders,
    });
    setBusy(false);
    if (refused) {
      setError(refused.message);
      return;
    }
    setSecret("");
    const { data } = await supabase.rpc("abo_my_shopify_apps");
    setApps((data as MyApp[] | null) ?? []);
    go(LAST);
  }

  async function connect() {
    if (!domain) return go(0);
    setBusy(true);
    setError(null);
    const { ok, data } = await apiFetch("/api/shopify/install", { projectId, shop: domain });
    if (!ok || typeof data.url !== "string") {
      setBusy(false);
      setError((data.error as string) ?? "Couldn’t start the connection. Try again.");
      return;
    }
    try {
      localStorage.removeItem(saveKey);
    } catch {
      /* already gone */
    }
    window.location.href = data.url;
  }

  const copyButton = (key: string, value: string, text = "Copy") => (
    <button type="button" onClick={() => copy(key, value)} className={button("secondary", "sm")}>
      {copied === key ? (
        <Check aria-hidden size={13} strokeWidth={2.25} className="text-signal-success" />
      ) : (
        <Copy aria-hidden size={13} strokeWidth={1.75} />
      )}
      {copied === key ? "Copied" : text}
    </button>
  );

  const actions = (nextText: string, onNext: () => void, disabled = false) => (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <button type="button" onClick={onNext} disabled={disabled || busy} className={button("primary")}>
        {busy ? "One moment…" : nextText}
      </button>
      {step > 0 && (
        <button type="button" onClick={() => go(reuse && step === 4 ? 1 : step - 1)} className={button("plain")}>
          Back
        </button>
      )}
    </div>
  );

  const summary = (i: number): string | null => {
    if (i === 0) return domain;
    if (skipped) return "Already set up";
    if (i === 1) return reuse ? "Using an app you set up" : "Created";
    if (i === 2) return reuse ? "Already set" : allOrders ? "With full order history" : "Set and released";
    if (i === 3) return reuse ? "Already saved" : idOk ? `Client ID …${clientId.trim().slice(-4)}` : "Saved";
    if (i === 4) return "Saved";
    return null;
  };

  const body: Record<number, ReactNode> = {
    0: (
      <>
        <div>
          <label htmlFor="own-app-shop" className={label}>
            Store address
          </label>
          <input
            id="own-app-shop"
            className={field}
            value={shop}
            onChange={(e) => setShop(e.target.value)}
            placeholder="your-store.myshopify.com"
            autoComplete="off"
            spellCheck={false}
          />
          <p className={hint}>
            {"error" in read && shop.trim()
              ? [read.error, read.hint].filter(Boolean).join(" ")
              : "It ends in .myshopify.com. In Shopify, open Settings, then Domains."}
          </p>
        </div>
        {ready && <div className={note.success}>This store is already set up here. Next goes straight to Connect.</div>}
        {actions(
          "Next",
          () => {
            setSkipped(ready);
            go(ready ? LAST : 1);
          },
          !domain
        )}
      </>
    ),
    1: (
      <>
        <p className="text-sm text-fg-muted">
          Open Shopify&rsquo;s Dev Dashboard in another tab, signed in with the account you use for your Shopify admin.
        </p>
        <a href={DEV_DASHBOARD} target="_blank" rel="noopener noreferrer" className={button("secondary")}>
          Open the Dev Dashboard
          <ExternalLink aria-hidden size={14} strokeWidth={1.75} />
        </a>
        <ol className="space-y-2 text-sm text-fg">
          <li className="flex gap-2.5">
            <span className="w-4 shrink-0 text-right text-xs font-medium text-fg-faint tabular-nums">1</span>
            <span>
              <b className="font-medium">Apps</b>, then <b className="font-medium">Create app</b>, then{" "}
              <b className="font-medium">Start from Dev Dashboard</b>.
            </span>
          </li>
          <li className="flex items-center gap-2.5">
            <span className="w-4 shrink-0 text-right text-xs font-medium text-fg-faint tabular-nums">2</span>
            <span className="flex-1">
              Name it <b className="font-medium">Warmluke</b>, then <b className="font-medium">Create</b>.
            </span>
            {copyButton("name", "Warmluke", "Copy the name")}
          </li>
        </ol>
        <p className="text-xs text-fg-muted">
          Can&rsquo;t find it?{" "}
          <a href={SHOPIFY_GUIDE} target="_blank" rel="noopener noreferrer" className="text-link hover:underline">
            Shopify&rsquo;s own guide
          </a>{" "}
          walks through it.
        </p>
        {theirs.length > 0 && (
          <div className="rounded-control bg-surface-subdued px-3 py-2.5">
            <div className="text-[13px] font-medium text-fg">Or use an app you already set up</div>
            <p className="mt-0.5 text-xs text-fg-muted">
              That works when this store is in the same Shopify organization as the other.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {theirs.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    setReuse(a.client_id);
                    setAllOrders(a.all_orders);
                    go(4);
                  }}
                  className={button("secondary", "sm")}
                >
                  The app for {a.shops[0]?.shop ?? "another store"}
                </button>
              ))}
            </div>
          </div>
        )}
        {actions("I’ve created it", () => {
          setReuse(null);
          setSkipped(false);
          go(2);
        })}
      </>
    ),
    2: (
      <>
        <p className="text-sm text-fg-muted">
          In the app, open <b className="font-medium text-fg">Versions</b> and set these four.
        </p>
        <ul className="divide-y divide-line overflow-hidden rounded-control border border-line">
          {settings.map((s) => (
            <li key={s.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <span className="w-full shrink-0 text-xs text-fg-muted sm:w-36">{s.name}</span>
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={s.value}>
                {s.value}
              </code>
              {s.copy && copyButton(s.key, s.value)}
            </li>
          ))}
        </ul>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[13px] font-medium text-fg">Orders older than 60 days</div>
            <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
              Adds read_all_orders to the scopes above. Shopify may ask you to request it under the app&rsquo;s API
              access first.
            </p>
          </div>
          <Switch checked={allOrders} onChange={setAllOrders} label="Orders older than 60 days" />
        </div>
        <p className="text-sm text-fg-muted">
          Then select <b className="font-medium text-fg">Release</b>. Nothing changes in Shopify until a version is
          released.
        </p>
        {actions("It’s released", () => go(3))}
      </>
    ),
    3: (
      <>
        <p className="text-sm text-fg-muted">
          In the Dev Dashboard, open <b className="font-medium text-fg">App settings</b>, then the{" "}
          <b className="font-medium text-fg">Credentials</b> card, and copy both here.
        </p>
        <div>
          <label htmlFor="own-app-client" className={label}>
            Client ID
          </label>
          <input
            id="own-app-client"
            className={`${fieldOf("md")} w-full font-mono`}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!clientId.trim() && !idOk}
          />
          {clientId.trim() && !idOk && <p className={hint}>A client ID is 32 letters and digits.</p>}
        </div>
        <div>
          <label htmlFor="own-app-secret" className={label}>
            Client secret
          </label>
          <PasswordInput
            id="own-app-secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!secret.trim() && !secretOk}
          />
          {secret.trim() && !secretOk && <p className={hint}>A client secret starts with shpss_.</p>}
        </div>
        {actions("Next", () => go(4), !idOk || !secretOk)}
      </>
    ),
    4: (
      <>
        <ul className="space-y-1.5 text-sm text-fg">
          {[
            "Your app’s secret is stored encrypted, and never shown again: not to you, not to anyone at Warmluke.",
            "It is used only to connect this store and keep it up to date.",
            "Remove the store or the app, and it is deleted.",
          ].map((t) => (
            <li key={t} className="flex gap-2">
              <Check aria-hidden size={14} strokeWidth={2.25} className="mt-0.5 shrink-0 text-signal-success" />
              <span>{t}</span>
            </li>
          ))}
        </ul>
        <label className="flex items-start gap-2.5 text-sm text-fg">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
          />
          <span>
            I agree to the{" "}
            <a href="/terms" target="_blank" className="text-link hover:underline">
              Terms
            </a>{" "}
            and the{" "}
            <a href="/privacy" target="_blank" className="text-link hover:underline">
              Privacy Policy
            </a>
            .
          </span>
        </label>
        {actions(reuse ? "Use it for this store" : "Save", save, !agreed)}
      </>
    ),
    5: (
      <>
        <p className="text-sm text-fg-muted">
          Shopify asks you to approve the app on <b className="font-medium text-fg">{domain}</b>, then brings you back
          here.
        </p>
        {apps && !ready && (
          <div className={note.attention}>This store has no app here yet. Go back and save its keys first.</div>
        )}
        <button type="button" onClick={connect} disabled={busy || !ready} className={button("primary")}>
          {busy ? "Opening Shopify…" : "Connect with Shopify"}
        </button>
        {step > 0 && !ready && (
          <button type="button" onClick={() => go(4)} className={`${button("plain")} ml-2`}>
            Back
          </button>
        )}
      </>
    ),
  };

  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-fg-muted">
        Your store connects through an app you create in Shopify, in about five minutes. Keep Shopify open in another
        tab: this keeps your place.
      </p>
      <div className="h-1 overflow-hidden rounded-full bg-line" aria-hidden>
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
          style={{ width: `${(step / LAST) * 100}%` }}
        />
      </div>
      <ol className="space-y-2" aria-label="Setting up your app">
        {STEPS.map((title, i) => {
          const done = i < step;
          const open = i === step;
          const said = done ? summary(i) : null;
          return (
            <li
              key={title}
              aria-current={open ? "step" : undefined}
              className={`overflow-hidden rounded-card border bg-surface ${open ? "border-line-strong" : "border-line"}`}
            >
              <button
                type="button"
                disabled={!done}
                onClick={() => done && go(i)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left disabled:cursor-default"
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${
                    done
                      ? "bg-tone-success/40 text-tone-success-fg"
                      : open
                        ? "bg-primary text-on-primary"
                        : "border border-line-strong text-fg-faint"
                  }`}
                >
                  {done ? <Check aria-hidden size={13} strokeWidth={2.5} /> : i + 1}
                </span>
                <span className={`flex-1 text-sm font-medium ${open || done ? "text-fg" : "text-fg-faint"}`}>
                  {title}
                </span>
                {said && <span className="max-w-[45%] truncate text-xs text-fg-muted">{said}</span>}
              </button>
              {open && (
                <div className="space-y-3 border-t border-line px-4 py-4">
                  {body[i]}
                  {error && (
                    <div role="alert" className={note.critical}>
                      {error}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {onCancel && (
        <button type="button" onClick={onCancel} className={button("plain")}>
          {cancelLabel}
        </button>
      )}
    </div>
  );
}
