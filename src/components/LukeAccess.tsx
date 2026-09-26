"use client";

// ─────────────────────────────────────────────────────────────
// LukeAccess — which models an account's Luke may answer on, and what
// each reply shows them about it (0127).
//
// Opened from the account's row, beside the switch that turns Luke on.
// Every model on offer, or only the ones ticked; and under each reply
// nothing, the model, the model and its tokens, or all that and the
// cost. Saved only when Save is pressed: a spend control does not save
// because somebody clicked elsewhere. The chat route enforces the list
// whatever the panel shows, and the account's trail records each change.
//
// Callers: src/app/admin/page.tsx.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Square, SquareCheck } from "lucide-react";
import { supabase } from "@/lib/supabase-client";
import { apiFetch } from "@/lib/auth";
import { Dialog } from "@/components/ui/Dialog";
import { Switch } from "@/components/ui/Switch";
import { button, note } from "@/components/ui/controls";
import { Choices } from "@/components/AdminParts";
import { modelName } from "@/lib/model-prices";
import type { OfferedModel } from "@/lib/luke-models";
import type { LukeShows } from "@/lib/types";

export const SHOWS_WORDS: Array<[LukeShows, string]> = [
  ["nothing", "Nothing"],
  ["model", "The model"],
  ["tokens", "Model and tokens"],
  ["cost", "Model, tokens and cost"],
];

type Held = { models: string[] | null; shows: LukeShows };

export function LukeAccess({ userId, email, onClose }: { userId: string; email: string; onClose: () => void }) {
  const [offered, setOffered] = useState<OfferedModel[] | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [shows, setShows] = useState<LukeShows>("cost");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let current = true;
    Promise.all([supabase.rpc("abo_admin_luke", { p_user: userId }), apiFetch("/api/models", null, "GET")]).then(
      ([{ data, error: err }, list]) => {
        if (!current) return;
        if (err) {
          setError(
            err.code === "PGRST202"
              ? "This database does not have these settings yet: apply migration 0127."
              : err.message
          );
          return;
        }
        const h = data as Held;
        setHeld(h);
        setModels(h.models);
        setShows(h.shows);
        setOffered((list.data.offered as OfferedModel[] | undefined) ?? []);
      }
    );
    return () => {
      current = false;
    };
  }, [userId]);

  // What they hold that is no longer on offer is still listed, so an
  // administrator sees it and can take it off.
  const rows: OfferedModel[] = [
    ...(offered ?? []),
    ...(models ?? [])
      .filter((id) => !offered?.some((m) => m.id === id))
      .map((id) => ({ id, name: `${modelName(id)} (no longer on offer)`, price: null })),
  ];
  const every = models === null;
  const changed =
    !!held && (held.shows !== shows || JSON.stringify(held.models ?? null) !== JSON.stringify(models ?? null));
  const empty = !every && (models?.length ?? 0) === 0;

  async function save() {
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.rpc("abo_admin_set_luke", {
      p_user: userId,
      p_models: models,
      p_shows: shows,
    });
    setSaving(false);
    if (err) {
      setError(err.message);
      return;
    }
    setHeld({ models, shows });
    setSaved(true);
  }

  return (
    <Dialog
      title="Luke's models"
      description={email}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          {saved && !changed && <span className="text-xs text-fg-muted">Saved</span>}
          <button onClick={onClose} className={button("plain", "md")}>
            Close
          </button>
          <button onClick={save} disabled={!changed || saving || empty} className={button("primary", "md")}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      }
    >
      {error ? (
        <div role="alert" className={note.critical}>
          {error}
        </div>
      ) : !held || !offered ? (
        <div aria-busy className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-control bg-surface-hover" />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          <section>
            <h3 className="mb-2 text-xs font-medium text-fg-muted">Models they can choose</h3>
            <div className="flex items-center gap-2 text-[13px] text-fg">
              <Switch
                checked={every}
                onChange={(on) => setModels(on ? null : offered.map((m) => m.id))}
                label={`Every model on offer for ${email}`}
              />
              Every model on offer
            </div>
            {!every && (
              <div role="group" aria-label="Models they can choose" className="mt-2 space-y-1">
                {rows.map((m) => {
                  const on = models?.includes(m.id) ?? false;
                  return (
                    <button
                      key={m.id}
                      role="checkbox"
                      aria-checked={on}
                      onClick={() =>
                        setModels((prev) => (on ? (prev ?? []).filter((x) => x !== m.id) : [...(prev ?? []), m.id]))
                      }
                      className="flex w-full items-center gap-2 rounded-control border border-line px-2.5 py-1.5 text-left text-[13px] text-fg transition-colors hover:border-line-strong"
                    >
                      {on ? (
                        <SquareCheck aria-hidden size={15} strokeWidth={1.75} className="shrink-0" />
                      ) : (
                        <Square aria-hidden size={15} strokeWidth={1.75} className="shrink-0 text-fg-faint" />
                      )}
                      <span className="min-w-0 flex-1">{m.name}</span>
                      {m.price && (
                        <span className="shrink-0 text-xs text-fg-faint tabular-nums">
                          ${m.price.input} in · ${m.price.output} out per M
                        </span>
                      )}
                    </button>
                  );
                })}
                {empty && (
                  <p className="text-xs text-tone-attention-fg">Tick at least one, or turn Luke off instead.</p>
                )}
              </div>
            )}
          </section>
          <section>
            <h3 className="mb-2 text-xs font-medium text-fg-muted">Under each reply they see</h3>
            <Choices options={SHOWS_WORDS} value={shows} onChange={setShows} />
          </section>
        </div>
      )}
    </Dialog>
  );
}
