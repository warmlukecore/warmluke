"use client";

// ─────────────────────────────────────────────────────────────
// ProjectSettings — rename a project, set how it writes money and
// dates, or delete it. Deleting cascades to every section, row, rule
// and conversation, so it asks for the name typed back: an accidental
// click here loses work that cannot be recovered.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import ErrorNote from "@/components/ErrorNote";
import { asError } from "@/lib/errors";
import { apiFetch } from "@/lib/auth";
import { supabase } from "@/lib/supabase-client";
import { makeFormatting } from "@/lib/format";
import { quietClasses } from "@/lib/tone";
import type { ProjectRow } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { Switch } from "@/components/ui/Switch";
import { Group } from "@/components/ui/Group";
import { button, field, hint, iconButton, iconButtonCritical, label, note } from "@/components/ui/controls";
import { Check, Copy, Link2, Trash2, UserPlus } from "lucide-react";

type Tab = "general" | "ai" | "people";

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
  const [seats, setSeats] = useState<MemberRow[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("general");

  async function loadSeats() {
    const { data, error: e } = await supabase
      .from("project_members")
      .select("id, email, token, joined_at")
      .eq("project_id", project.id)
      .order("created_at");
    // A list that failed to load is not a list of nobody.
    if (e) {
      setPeopleError("The people on this project couldn’t be loaded.");
      setSeats((prev) => prev ?? []);
      return;
    }
    setSeats(data ?? []);
  }
  useEffect(() => {
    loadSeats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  /** A new seat is a link; it is copied straight away, since that is the next thing anyone does with it. */
  async function addSeat() {
    setAdding(true);
    setPeopleError(null);
    const { data, error: e } = await supabase
      .from("project_members")
      .insert({ project_id: project.id })
      .select("id, email, token, joined_at")
      .single();
    setAdding(false);
    if (e || !data) {
      setPeopleError("Couldn’t make a link. Try again.");
      return;
    }
    copyLink(data as MemberRow);
    loadSeats();
  }

  async function removeSeat(id: string) {
    setPeopleError(null);
    const { error: e } = await supabase.from("project_members").delete().eq("id", id);
    setRemoving(null);
    if (e) {
      setPeopleError("Couldn’t remove them. Try again.");
      return;
    }
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

  const tabs: Array<{ id: Tab; text: string; count?: number }> = [
    { id: "general", text: "General" },
    { id: "ai", text: "Your own AI" },
    { id: "people", text: "People", count: seats?.length },
  ];

  return (
    <Dialog
      title="Project settings"
      description={project.name}
      onClose={onClose}
      tall
      footer={
        <>
          <span className="text-xs text-fg-muted">{dirty ? "Unsaved changes" : ""}</span>
          <button onClick={onClose} className={`${button("plain")} ml-auto`}>
            Cancel
          </button>
          <button onClick={save} disabled={busy || !dirty || !name.trim()} className={button("primary")}>
            {busy && !confirmingDelete ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      <div role="tablist" aria-label="Settings" className="sticky -top-4 z-10 -mx-5 -mt-4 mb-4 flex gap-4 border-b border-line bg-surface px-5">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 py-2.5 text-[13px] font-medium transition-colors ${
              tab === t.id ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {t.text}
            {t.count ? <span className="ml-1.5 rounded-full bg-surface-hover px-1.5 text-[11px] text-fg-muted">{t.count}</span> : null}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4">
          <ErrorNote error={asError(error)} />
        </div>
      )}

      {tab === "general" && (
        <div className="space-y-4">
          <Group title="Details" description="What the project is called, and how it writes money and dates.">
          <div>
            <label htmlFor="project-name" className={label}>
              Name
            </label>
            <input id="project-name" value={name} onChange={(e) => setName(e.target.value)} className={field} />
          </div>

          <div>
            <label htmlFor="project-locale" className={label}>
              Locale and default currency
            </label>
            <select
              id="project-locale"
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
              className={field}
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
            <div className={hint}>
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
          </Group>

          <Group title="Delete this project" danger>
            {!confirmingDelete ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-fg-muted">Every section, row, rule and conversation goes with it.</p>
                <button onClick={() => setConfirmingDelete(true)} className={button("critical-secondary", "sm")}>
                  Delete project
                </button>
              </div>
            ) : (
              <div className="space-y-2.5">
                <div className={note.critical}>
                  This removes every section, row, rule and conversation in{" "}
                  <b>{project.name}</b>. It cannot be undone.
                </div>
                <input
                  autoFocus
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={`Type "${project.name}" to confirm`}
                  aria-label="Type the project name to confirm"
                  className={field}
                />
                <div className="flex gap-2">
                  <button onClick={remove} disabled={busy || !canDelete} className={button("critical")}>
                    {busy ? "Deleting…" : "Delete permanently"}
                  </button>
                  <button
                    onClick={() => {
                      setConfirmingDelete(false);
                      setConfirm("");
                    }}
                    className={button("plain")}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </Group>
        </div>
      )}

      {tab === "ai" && (
        <Group title="Designs your own AI asks for" description="From Claude or ChatGPT, connected to this project over MCP.">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-[13px] font-medium text-fg">Build without asking me first</div>
              <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                {autoBuild ? "On: designs are built as they arrive." : "Off: every design waits for your yes."}
              </p>
            </div>
            <Switch checked={autoBuild} onChange={setAutoBuild} label="Build without asking me first" />
          </div>
          {/* What it will and will not do, in full, because a
              setting whose limits are a surprise is worse than no
              setting. */}
          <div className="space-y-2 rounded-control bg-surface-subdued px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
            {/* This list has to match ADDITIVE in the MCP route. It
                said "new sections and example rows" for a day after
                adding a field joined them, which made the sentence
                below it — "anything that changes a section you
                already have" — untrue. */}
            <div>
              <span className="font-medium text-fg">Applies on its own:</span> everything your
              AI is allowed to design — new sections, example rows, new fields, changes to
              sections you already have, and rules that run by themselves afterwards.
            </div>
            <div>
              <span className="font-medium text-fg">Still waits for you:</span> nothing. Turn
              this off and every design waits for your yes instead.
            </div>
            <div>
              <span className="font-medium text-fg">Never, either way:</span> removing a
              section. That one is typed out by you, in Warmluke, and your AI cannot ask
              for it at all.
            </div>
            <div>
              Whatever it builds appears in the panel with what was asked for, and you can
              delete it.
            </div>
          </div>
        </Group>
      )}

      {tab === "people" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-sm text-xs leading-relaxed text-fg-muted">
              Share a link and whoever opens it can use this app — see the
              sections, add rows, update them. They cannot change how the app
              is built, read your conversation with Luke, or delete
              anything.
            </p>
            <button onClick={addSeat} disabled={adding} className={button("primary", "sm")}>
              <UserPlus aria-hidden size={14} strokeWidth={2} />
              {adding ? "Making a link…" : "Add someone"}
            </button>
          </div>

          {peopleError && <div className={note.critical}>{peopleError}</div>}

          {seats === null ? (
            <div className="h-14 animate-pulse rounded-card bg-surface-hover" />
          ) : seats.length === 0 ? (
            <div className="rounded-card border border-dashed border-line-strong px-4 py-8 text-center text-xs text-fg-muted">
              Only you, for now. Add someone and send them the link.
            </div>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-card border border-line">
              {seats.map((seat) => (
                <li key={seat.id} className="flex items-center gap-3 px-3 py-2.5">
                  {seat.email ? (
                    <span
                      aria-hidden
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${quietClasses(seat.email)}`}
                    >
                      {seat.email.charAt(0).toUpperCase()}
                    </span>
                  ) : (
                    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-fg-faint">
                      <Link2 size={14} strokeWidth={1.75} />
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-fg">{seat.email ?? "Link not opened yet"}</div>
                    <div className="text-[11px] text-fg-faint">
                      {seat.joined_at
                        ? `Joined ${new Date(seat.joined_at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })} · can use the app`
                        : "Waiting for them to open it"}
                    </div>
                  </div>
                  {removing === seat.id ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <button onClick={() => removeSeat(seat.id)} className={button("critical", "sm")}>
                        Remove
                      </button>
                      <button onClick={() => setRemoving(null)} className={button("plain", "sm")}>
                        Keep
                      </button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center">
                      {!seat.joined_at && (
                        <button
                          onClick={() => copyLink(seat)}
                          aria-label="Copy their link"
                          title={copied === seat.id ? "Copied" : "Copy link"}
                          className={iconButton}
                        >
                          {copied === seat.id ? (
                            <Check aria-hidden size={15} strokeWidth={2} className="text-signal-success" />
                          ) : (
                            <Copy aria-hidden size={15} strokeWidth={1.75} />
                          )}
                        </button>
                      )}
                      <button
                        onClick={() => setRemoving(seat.id)}
                        aria-label={`Remove ${seat.email ?? "this link"}`}
                        title="Remove"
                        className={iconButtonCritical}
                      >
                        <Trash2 aria-hidden size={15} strokeWidth={1.75} />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
