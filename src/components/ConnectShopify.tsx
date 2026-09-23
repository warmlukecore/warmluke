"use client";

// ─────────────────────────────────────────────────────────────
// ConnectShopify — the merchant says which store, and is handed to
// Shopify to approve it. Nothing is decided here: the server reads
// the address again, builds the authorization URL and the state that
// proves, on the way back, that this project asked for it.
// ─────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import ErrorNote from "@/components/ErrorNote";
import { asError } from "@/lib/errors";
import { apiFetch } from "@/lib/auth";
import { readShopAddress } from "@/lib/shop-address";
import { whatCanChange } from "@/lib/store-actions";

/** Reasons the server can refuse, said the way the owner would ask. */
function explain(status: number, message?: string, hint?: string): string {
  if (status === 503) return "Shopify isn't set up on this deployment yet.";
  if (status === 409) return message ?? "That store is already connected to another project.";
  if (status === 400) return [message ?? "That doesn't look like a store address.", hint].filter(Boolean).join(" ");
  return message ?? "Couldn't reach Shopify. Try again in a moment.";
}

export default function ConnectShopify({
  projectId,
  onCancel,
  // Reconnecting is the same flow with the address already known, so it
  // reuses this rather than growing a second near-identical component.
  initialShop = "",
  submitLabel = "Connect",
}: {
  projectId: string;
  onCancel: () => void;
  initialShop?: string;
  submitLabel?: string;
}) {
  const [shop, setShop] = useState(initialShop);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether to say what is wrong yet. Not while they are still
  // typing: "mystore.c" is on its way to "mystore.com", and a red
  // line under every keystroke is a box shouting at somebody for
  // being halfway through a word.
  const [judged, setJudged] = useState(false);

  // The same reading the server does, so what is shown is what will
  // be used. The server reads it again; this is only for the person.
  const read = useMemo(() => readShopAddress(shop), [shop]);
  const understood = "domain" in read ? read.domain : null;
  // Said back only when it is not what they typed, which is the case
  // worth confirming.
  const differs = understood !== null && understood !== shop.trim().toLowerCase();

  // Built from what the app can really do, not written here: this is
  // the last sentence a merchant reads before connecting.
  const changes = whatCanChange();

  async function connect() {
    if (busy || !shop.trim()) return;
    setJudged(true);
    if (!understood) return;
    setBusy(true);
    setError(null);

    // The raw text, not the reading: the server does its own, and a
    // page that sent only its conclusion would be trusted with it.
    const { ok, status, data } = await apiFetch("/api/shopify/install", {
      projectId,
      shop,
    });

    if (!ok || typeof data.url !== "string") {
      setBusy(false);
      setError(explain(status, data.error as string | undefined, data.hint as string | undefined));
      return;
    }
    // Leaving the app for Shopify's own approval screen — the merchant
    // signs in there, not here, and we never see their password.
    window.location.href = data.url;
  }

  const shownError =
    error ?? (judged && "error" in read && shop.trim() ? [read.error, read.hint].filter(Boolean).join(" ") : null);

  return (
    <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        value={shop}
        onChange={(e) => {
          setShop(e.target.value);
          setError(null);
          setJudged(false);
        }}
        onBlur={() => shop.trim() && setJudged(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") connect();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="mystore, or its address"
        aria-label="Your Shopify store"
        aria-invalid={!!shownError}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
      />
      {differs && !shownError && (
        <p className="text-[11px] text-slate-400">
          Connecting <span className="text-slate-200">{understood}</span>
        </p>
      )}
      {shownError && <ErrorNote error={asError(shownError)} compact dark />}
      {/* Shown before the button, not after: an agreement a merchant
          only meets once they have already left for Shopify is not one. */}
      <p className="text-[11px] leading-relaxed text-slate-500">
        Connecting agrees to our{" "}
        <a href="/terms" target="_blank" className="underline hover:text-slate-300">
          terms
        </a>{" "}
        and{" "}
        <a href="/privacy" target="_blank" className="underline hover:text-slate-300">
          privacy policy
        </a>
        .{" "}
        {changes
          ? `Warmluke reads your store, and can ${changes}, but only when you say yes to that change.`
          : "Warmluke reads your store and changes nothing in it."}
      </p>
      <div className="flex gap-1.5">
        <button
          onClick={connect}
          disabled={busy || !shop.trim()}
          className="flex-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
        >
          {busy ? "Opening Shopify…" : submitLabel}
        </button>
        <button
          onClick={onCancel}
          className="rounded-lg px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:text-slate-200"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
