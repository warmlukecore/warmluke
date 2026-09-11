"use client";

// ─────────────────────────────────────────────────────────────
// ProjectSettings — rename a project, set how it writes money and
// dates, or delete it. Deleting cascades to every section, row, rule
// and conversation, so it asks for the name typed back: an accidental
// click here loses work that cannot be recovered.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { apiFetch } from "@/lib/auth";
import { makeFormatting } from "@/lib/format";
import type { ProjectRow } from "@/lib/types";

/** Common choices; any valid code can still be typed in. */
const LOCALES = [
  { locale: "en-IN", currency: "INR", label: "India — ₹, 1,23,456" },
  { locale: "en-GB", currency: "GBP", label: "UK — £, 123,456" },
  { locale: "en-US", currency: "USD", label: "US — $, 123,456" },
  { locale: "en-AE", currency: "AED", label: "UAE — AED" },
  { locale: "en-SG", currency: "SGD", label: "Singapore — S$" },
  { locale: "de-DE", currency: "EUR", label: "Germany — €, 123.456" },
];

export default function ProjectSettings({
  project,
  onSaved,
  onDeleted,
  onClose,
}: {
  project: ProjectRow;
  onSaved: (p: ProjectRow) => void;
  onDeleted: (id: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [locale, setLocale] = useState(project.locale ?? "en-IN");
  const [currency, setCurrency] = useState(project.currency ?? "INR");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const preview = makeFormatting(locale, currency);
  const canDelete = confirm.trim().toLowerCase() === project.name.trim().toLowerCase();
  const dirty =
    name.trim() !== project.name || locale !== project.locale || currency !== project.currency;

  async function save() {
    setBusy(true);
    setError(null);
    const { ok, data } = await apiFetch(
      "/api/projects",
      { id: project.id, name, locale, currency },
      "PATCH"
    );
    setBusy(false);
    if (!ok || data.error) {
      setError((data.error as string) ?? "Couldn't save.");
      return;
    }
    onSaved(data.project as ProjectRow);
    onClose();
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const { ok, data } = await apiFetch(
      "/api/projects",
      { id: project.id, confirmName: confirm },
      "DELETE"
    );
    setBusy(false);
    if (!ok || data.error) {
      setError((data.error as string) ?? "Couldn't delete.");
      return;
    }
    onDeleted(project.id);
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/70 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-slate-800 bg-slate-900 text-slate-200 shadow-2xl thin-scroll-dark sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
          <h2 className="font-display text-sm font-semibold text-white">Project settings</h2>
          <button
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {error && (
            <div className="rounded-lg border border-rose-900 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
              {error}
            </div>
          )}

          <div>
            <label className="mb-1 block text-[11px] font-medium tracking-wide text-slate-400 uppercase">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium tracking-wide text-slate-400 uppercase">
              Money and dates
            </label>
            <select
              value={`${locale}|${currency}`}
              onChange={(e) => {
                const [l, c] = e.target.value.split("|");
                setLocale(l);
                setCurrency(c);
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              {LOCALES.map((o) => (
                <option key={o.locale} value={`${o.locale}|${o.currency}`}>
                  {o.label}
                </option>
              ))}
              {!LOCALES.some((o) => o.locale === locale && o.currency === currency) && (
                <option value={`${locale}|${currency}`}>
                  {locale} — {currency}
                </option>
              )}
            </select>
            <div className="mt-1.5 text-[11px] text-slate-500">
              Amounts look like {preview.money(123456.5)} · dates like{" "}
              {preview.date("2026-03-14")}
            </div>
          </div>

          <button
            onClick={save}
            disabled={busy || !dirty || !name.trim()}
            className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save changes"}
          </button>

          <div className="border-t border-slate-800 pt-4">
            {!confirmingDelete ? (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="text-xs font-medium text-rose-400 transition-colors hover:text-rose-300"
              >
                Delete this project
              </button>
            ) : (
              <div className="space-y-2">
                <div className="rounded-lg border border-rose-900 bg-rose-950/40 px-3 py-2 text-[11px] leading-relaxed text-rose-200">
                  This removes every section, row, rule and conversation in{" "}
                  <b>{project.name}</b>. It cannot be undone.
                </div>
                <input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={`Type "${project.name}" to confirm`}
                  className="w-full rounded-lg border border-rose-900 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-rose-500"
                />
                <div className="flex gap-2">
                  <button
                    onClick={remove}
                    disabled={busy || !canDelete}
                    className="flex-1 rounded-lg bg-rose-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-rose-700 disabled:opacity-40"
                  >
                    {busy ? "Deleting…" : "Delete permanently"}
                  </button>
                  <button
                    onClick={() => {
                      setConfirmingDelete(false);
                      setConfirm("");
                    }}
                    className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 transition-colors hover:bg-slate-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
