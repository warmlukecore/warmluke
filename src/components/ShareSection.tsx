"use client";

// ─────────────────────────────────────────────────────────────
// ShareSection — who on the team sees a section (0140).
//
// A section is the owner's until it is shared: with everyone on the
// team, or with the people switched on here. The database decides
// (abo_can_see_module); this only writes what the owner chose. A
// section under another is shared as its parent is, so this is offered
// on top-level sections only.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase-client";
import { Dialog } from "@/components/ui/Dialog";
import { Switch } from "@/components/ui/Switch";
import { button, note } from "@/components/ui/controls";
import { quietClasses } from "@/lib/tone";
import { MEMBER_ROLE_OPTIONS, labelOf } from "@/lib/onboarding";
import { UserPlus } from "lucide-react";
import { sees, setSees, type Access } from "@/lib/sharing";

type Seat = {
  id: string;
  user_id: string | null;
  email: string | null;
  full_name: string | null;
  team_role: string | null;
  joined_at: string | null;
  can_see_store: boolean;
};

export default function ShareSection({
  projectId,
  isOwner,
  section,
  onClose,
  onChanged,
  onAddPeople,
}: {
  projectId: string;
  /** Only the owner lets someone see the store; a builder shares what they built. */
  isOwner: boolean;
  section: {
    id: string;
    nav_label: string;
    shared_with_team?: boolean;
    source_table: string | null;
    created_by?: string | null;
  };
  onClose: () => void;
  /** Something was shared or unshared; the shell reads its sections again. */
  onChanged: () => void;
  onAddPeople: () => void;
}) {
  const [seats, setSeats] = useState<Seat[] | null>(null);
  const [shared, setShared] = useState<Set<string>>(new Set());
  // Hidden from one person, whatever else would show it to them (0145).
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [team, setTeam] = useState(section.shared_with_team !== false);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    Promise.all([
      // The seats without their links, so someone the owner lets build can share too (0146).
      supabase.rpc("abo_teammates", { p_project: projectId }),
      supabase.from("module_shares").select("member_id").eq("module_id", section.id),
      supabase.from("module_hides").select("member_id").eq("module_id", section.id),
    ]).then(([s, m, h]) => {
      if (s.error || m.error) setError("Who can see this couldn’t be read. Close this and try again.");
      // Someone sharing what they built is not in their own list: it is theirs whatever they switch.
      setSeats(((s.data as Seat[] | null) ?? []).filter((x) => isOwner || x.user_id !== section.created_by));
      setShared(new Set((m.data ?? []).map((r) => r.member_id as string)));
      // Before 0145 there is no such table: nobody is hidden from anything.
      setHidden(new Set(h.error ? [] : (h.data ?? []).map((r) => r.member_id as string)));
    });
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, section.id]);

  const accessFor = (seat: Seat): Access => ({
    team,
    shared: shared.has(seat.id),
    hidden: hidden.has(seat.id),
    builtByThem: !!seat.user_id && section.created_by === seat.user_id,
  });

  async function setForTeam(next: boolean) {
    setError(null);
    setTeam(next);
    const { error: e } = await supabase.from("modules").update({ shared_with_team: next }).eq("id", section.id);
    if (e) {
      setTeam(!next);
      setError("That didn’t save. Try again.");
      return;
    }
    onChanged();
  }

  // One person on or off, whatever gave it to them (lib/sharing): with the
  // whole team sharing it, switching one off hides it from just them.
  async function setForSeat(seat: Seat, next: boolean) {
    setError(null);
    const { error: e } = await setSees(supabase, section.id, seat.id, accessFor(seat), next);
    if (e) setError("That didn’t save. Try again.");
    await load();
    onChanged();
  }

  /** A store section shown to someone without the store is an empty table; say so where it is fixed. */
  async function letSeeStore(seat: Seat) {
    setError(null);
    const { error: e } = await supabase.from("project_members").update({ can_see_store: true }).eq("id", seat.id);
    if (e) {
      setError("That didn’t save. Try again.");
      return;
    }
    setSeats((prev) => prev?.map((s) => (s.id === seat.id ? { ...s, can_see_store: true } : s)) ?? prev);
  }

  const who = (s: Seat) => s.full_name ?? s.email ?? "Link not opened yet";
  const seeing = (seats ?? []).filter((s) => sees(accessFor(s))).length;
  const everyone = !!seats && seats.length > 0 && seeing === seats.length;

  return (
    <Dialog
      title={`Who can see ${section.nav_label}`}
      description={
        seeing === 0
          ? "Only you, for now."
          : team && everyone
            ? "Everyone on your team."
            : `You and ${seeing} ${seeing === 1 ? "person" : "people"} on your team.`
      }
      onClose={onClose}
      footer={
        <button onClick={onClose} className={`${button("secondary")} ml-auto`}>
          Done
        </button>
      }
    >
      <div className="space-y-4">
        {error && <div className={note.critical}>{error}</div>}

        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[13px] font-medium text-fg">Everyone on the team</div>
            <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
              {team
                ? "On: everyone you add later sees it too, except anyone you switch off below."
                : "Off: only the people switched on below, and you."}
            </p>
          </div>
          <Switch checked={team} onChange={setForTeam} label="Share with everyone on the team" />
        </div>

        {seats === null ? (
          <div className="h-14 animate-pulse rounded-card bg-surface-hover" aria-busy />
        ) : seats.length === 0 ? (
          <div className="rounded-card border border-dashed border-line-strong px-4 py-6 text-center">
            <p className="text-xs text-fg-muted">Nobody on your team yet.</p>
            <button onClick={onAddPeople} className={`${button("secondary", "sm")} mt-3`}>
              <UserPlus aria-hidden size={14} strokeWidth={2} />
              Add people
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-card border border-line">
            {seats.map((seat) => {
              const access = accessFor(seat);
              const on = sees(access);
              const storeMissing = on && !!section.source_table && !seat.can_see_store;
              return (
                <li key={seat.id} className="px-3 py-2.5">
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${quietClasses(seat.email ?? seat.id)}`}
                    >
                      {who(seat).charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-fg">
                        {who(seat)}
                        {seat.team_role && (
                          <span className="text-fg-muted"> · {labelOf(MEMBER_ROLE_OPTIONS, seat.team_role)}</span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-fg-faint">
                        {access.hidden
                          ? "Hidden from them"
                          : access.builtByThem
                            ? "They built it"
                            : seat.joined_at
                              ? on
                                ? "Can see it"
                                : "Can’t see it"
                              : on
                                ? "Sees it once they join"
                                : "Won’t see it when they join"}
                      </div>
                    </div>
                    <Switch
                      checked={on}
                      onChange={(next) => setForSeat(seat, next)}
                      label={`Share ${section.nav_label} with ${who(seat)}`}
                    />
                  </div>
                  {storeMissing && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-control bg-surface-subdued px-3 py-2 text-xs text-fg-muted">
                      <span>
                        This comes from the store, which they can&rsquo;t see yet, so it will look empty to them.
                      </span>
                      {isOwner && (
                        <button onClick={() => letSeeStore(seat)} className={button("secondary", "sm")}>
                          Let them see the store
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <p className="text-xs leading-relaxed text-fg-muted">
          Sections inside this one are shared the same way. Whoever can see it can add and update rows, not change how
          it is built or delete anything.
        </p>
      </div>
    </Dialog>
  );
}
