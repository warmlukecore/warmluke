"use client";

// ─────────────────────────────────────────────────────────────
// ProjectSettings — rename a project, set how it writes money and
// dates, or delete it. Deleting cascades to every section, row, rule
// and conversation, so it asks for the name typed back: an accidental
// click here loses work that cannot be recovered.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/auth";
import { supabase } from "@/lib/supabase-client";
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

type MemberRow = { id: string; email: string | null; token: string; joined_at: string | null };

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
  const [autoBuild, setAutoBuild] = useState(project.auto_build === true);
  // Whether the currency below is an answer or just the column's
  // default. Kept apart from the value itself, because "INR" cannot
  // say which of the two it is.
  const [chose, setChose] = useState(project.currency_set_by_user === true);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [seats, setSeats] = useState<MemberRow[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  async function loadSeats() {
    const { data } = await supabase
      .from("project_members")
      .select("id, email, token, joined_at")
      .eq("project_id", project.id)
      .order("created_at");
    setSeats(data ?? []);
  }
  useEffect(() => {
    loadSeats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  async function addSeat() {
    await supabase.from("project_members").insert({ project_id: project.id });
    loadSeats();
  }

  async function removeSeat(id: string) {
    await supabase.from("project_members").delete().eq("id", id);
    loadSeats();
  }

  function copyLink(seat: MemberRow) {
    const url = `${window.location.origin}/join/${seat.token}`;
    navigator.clipboard?.writeText(url).catch(() => {});
    setCopied(seat.id);
    setTimeout(() => setCopied((c) => (c === seat.id ? null : c)), 1500);
  }

  const preview = makeFormatting(locale, currency);
  const canDelete = confirm.trim().toLowerCase() === project.name.trim().toLowerCase();
  const dirty =
    name.trim() !== project.name ||
    locale !== project.locale ||
    currency !== project.currency ||
    autoBuild !== (project.auto_build === true);

  async function save() {
    setBusy(true);
    setError(null);
    const { ok, data } = await apiFetch(
      "/api/projects",
      {
        id: project.id,
        name,
        locale,
        currency,
        // Sent every time, so choosing "Follow each shop" is a real
        // answer and not merely the absence of one.
        currency_set_by_user: chose,
        auto_build: autoBuild,
      },
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
              Locale and default currency
            </label>
            <select
              value={chose ? `${locale}|${currency}` : "default"}
              onChange={(e) => {
                if (e.target.value === "default") {
                  setChose(false);
                  return;
                }
                const [l, c] = e.target.value.split("|");
                setChose(true);
                setLocale(l);
                setCurrency(c);
              }}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-blue-500"
            >
              {/* Without this, a project that has never been touched
                  showed "India — ₹" as though somebody had picked it,
                  and there was no way back to not having picked. */}
              <option value="default">Follow each shop — no second currency shown</option>
              {LOCALES.map((o) => (
                <option key={o.locale} value={`${o.locale}|${o.currency}`}>
                  {o.label}
                </option>
              ))}
              {chose && !LOCALES.some((o) => o.locale === locale && o.currency === currency) && (
                <option value={`${locale}|${currency}`}>
                  {locale} — {currency}
                </option>
              )}
            </select>
            <div className="mt-1.5 text-[11px] text-slate-500">
              {chose ? (
                <>
                  Amounts look like {preview.money(123456.5)} · dates like{" "}
                  {preview.date("2026-03-14")}. Shopify amounts still show in Shopify&rsquo;s own
                  currency, with a rough {currency} figure underneath at today&rsquo;s rate.
                </>
              ) : (
                <>
                  Shopify amounts show in whatever currency the shop recorded them in, and nothing
                  else is put beside them. Pick a country above if you would also like a rough
                  figure in your own currency — it is an estimate at today&rsquo;s rate, not
                  something to reconcile against.
                </>
              )}
            </div>
          </div>

          <div className="border-t border-slate-800 pt-4">
            <div className="text-sm font-semibold text-slate-100">Your own AI</div>
            <label className="mt-2 flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={autoBuild}
                onChange={(e) => setAutoBuild(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-blue-600"
              />
              <span className="text-[11px] leading-relaxed text-slate-300">
                Build new sections without asking me first
              </span>
            </label>
            {/* What it will and will not do, in full, because a
                setting whose limits are a surprise is worse than no
                setting. */}
            <div className="mt-2 space-y-1 rounded-lg bg-slate-800/60 px-2.5 py-2 text-[11px] leading-relaxed text-slate-400">
              <div>
                <span className="text-slate-300">Applies on its own:</span> new sections, and
                example rows in them. Up to five a day.
              </div>
              <div>
                <span className="text-slate-300">Still waits for you:</span> anything that
                changes a section you already have, any rule that runs on every order,
                anything the assistant flagged, and removing a section — which it can
                never do.
              </div>
              <div>Whatever it builds appears in the panel, and you can delete it.</div>
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
            <div className="text-sm font-semibold text-slate-100">People</div>
            <div className="mt-1 text-[11px] text-slate-400">
              Share a link and whoever opens it can use this app — see the
              sections, add rows, update them. They cannot change how the app
              is built, read your conversation with Luke, or delete
              anything.
            </div>

            {seats.length > 0 && (
              <ul className="mt-2.5 space-y-1.5">
                {seats.map((seat) => (
                  <li
                    key={seat.id}
                    className="flex items-center gap-2 rounded-lg bg-slate-800/60 px-2.5 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-200">
                      {seat.email ?? (
                        <span className="text-slate-500">Link not opened yet</span>
                      )}
                    </span>
                    {!seat.joined_at && (
                      <button
                        onClick={() => copyLink(seat)}
                        className="shrink-0 rounded-md border border-slate-600 px-2 py-0.5 text-[11px] text-slate-300 transition-colors hover:border-blue-400 hover:text-blue-300"
                      >
                        {copied === seat.id ? "Copied" : "Copy link"}
                      </button>
                    )}
                    <button
                      onClick={() => removeSeat(seat.id)}
                      aria-label="Remove"
                      className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-slate-500 transition-colors hover:text-rose-400"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <button
              onClick={addSeat}
              className="mt-2.5 w-full rounded-lg border border-slate-600 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-blue-400 hover:text-blue-300"
            >
              + Add someone
            </button>
          </div>

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
