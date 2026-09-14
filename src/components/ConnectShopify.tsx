"use client";

// ─────────────────────────────────────────────────────────────
// ConnectShopify — the merchant types their store address and is
// handed to Shopify to approve it. Nothing is decided here: the
// server builds the authorization URL and the state that proves,
// on the way back, that this project asked for it.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { apiFetch } from "@/lib/auth";

/** Reasons the server can refuse, said the way the owner would ask. */
function explain(status: number, message?: string): string {
  if (status === 503) return "Shopify isn't set up on this deployment yet.";
  if (status === 409) return "That store is already connected to another project.";
  if (status === 400) return message ?? "That doesn't look like a store address.";
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

  async function connect() {
    const value = shop.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);

    const { ok, status, data } = await apiFetch("/api/shopify/install", {
      projectId,
      shop: value,
    });

    if (!ok || typeof data.url !== "string") {
      setBusy(false);
      setError(explain(status, data.error as string | undefined));
      return;
    }
    // Leaving the app for Shopify's own approval screen — the merchant
    // signs in there, not here, and we never see their password.
    window.location.href = data.url;
  }

  return (
    <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        value={shop}
        onChange={(e) => setShop(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") connect();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="yourstore.myshopify.com"
        spellCheck={false}
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
      />
      {error && <div className="text-[11px] leading-relaxed text-rose-400">{error}</div>}
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
        . We read your store; we never write to it.
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
