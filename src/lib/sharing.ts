// Whether one person sees one section, and turning it on or off (0140, 0145).
//
// Four things can decide it: the section is shared with the whole team,
// it is shared with them by name, they built it, or it is hidden from
// them — and hidden wins over the other three. The database is the one
// that decides (abo_can_see_module); this is the same rule, for the
// switches that change it, so that the People list and the Share dialog
// flip it the same way.
//
// Callers: src/components/ProjectSettings.tsx, src/components/ShareSection.tsx.

import type { SupabaseClient } from "@supabase/supabase-js";

export type Access = {
  /** Shared with everyone on the team. */
  team: boolean;
  /** Shared with this person by name. */
  shared: boolean;
  /** Hidden from this person, whatever else shows it. */
  hidden: boolean;
  /** This person built it. */
  builtByThem: boolean;
};

export const sees = (a: Access): boolean => !a.hidden && (a.team || a.shared || a.builtByThem);

const said = (e: { message: string } | null) => ({ error: e ? e.message : null });

/**
 * One person's access to one section, on or off, whatever gave it to them:
 * on takes a hide away and, if nothing else shows it, shares it by name;
 * off takes a share by name away and, if the team or their own build
 * would still show it, hides it from them.
 */
export async function setSees(
  db: SupabaseClient,
  moduleId: string,
  memberId: string,
  access: Access,
  on: boolean
): Promise<{ error: string | null }> {
  const pair = { module_id: moduleId, member_id: memberId };
  if (on) {
    if (access.hidden) {
      const { error } = await db.from("module_hides").delete().eq("module_id", moduleId).eq("member_id", memberId);
      if (error) return said(error);
    }
    if (!sees({ ...access, hidden: false })) {
      const { error } = await db.from("module_shares").insert(pair);
      if (error) return said(error);
    }
    return said(null);
  }
  if (access.shared) {
    const { error } = await db.from("module_shares").delete().eq("module_id", moduleId).eq("member_id", memberId);
    if (error) return said(error);
  }
  if ((access.team || access.builtByThem) && !access.hidden) {
    const { error } = await db.from("module_hides").insert(pair);
    if (error) return said(error);
  }
  return said(null);
}
