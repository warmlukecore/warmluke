"use client";

// ─────────────────────────────────────────────────────────────
// Join — claims a seat in someone else's project.
//
// The token in the URL is the only proof of invitation, so the claim
// runs in the database (abo_join), never here: this page cannot decide
// who gets in, it can only ask. Signed out, it sends you to log in and
// comes back, because the seat is stamped with a user id.
//
// Once in, one short question before the app: what they are called and
// what they do on the team (abo_member_about, 0118). The owner sees it on
// the seat and the accounts screen sees whose app they joined, so nobody
// has to ask afterwards. It can be skipped, and a seat already answered
// goes straight through.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase-client";
import { CenteredCard } from "@/components/CenteredCard";
import { button, field, label, note } from "@/components/ui/controls";
import { MEMBER_ROLE_OPTIONS, NAME_MAX } from "@/lib/onboarding";

type About = { projectId: string; projectName: string | null };

export default function JoinPage() {
  const router = useRouter();
  const { token } = useParams<{ token: string }>();
  const [error, setError] = useState<string | null>(null);
  const [about, setAbout] = useState<About | null>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        router.replace(`/login?next=${encodeURIComponent(`/join/${token}`)}`);
        return;
      }
      const { data: projectId, error } = await supabase.rpc("abo_join", { p_token: token });
      if (error) {
        setError("Something went wrong opening this invite. Try the link again.");
        return;
      }
      if (!projectId) {
        setError("This invite is no longer valid. Ask for a fresh link.");
        return;
      }
      const uid = data.session.user.id;
      const [seat, project, profile] = await Promise.all([
        supabase.from("project_members").select("full_name").eq("project_id", projectId).eq("user_id", uid).maybeSingle(),
        supabase.from("projects").select("name").eq("id", projectId).maybeSingle(),
        supabase.from("profiles").select("full_name").eq("user_id", uid).maybeSingle(),
      ]);
      // Answered before, on this link or another: nothing to ask.
      if (seat.data?.full_name) {
        router.replace(`/app/${projectId}`);
        return;
      }
      setName((profile.data?.full_name as string | undefined) ?? "");
      setAbout({ projectId, projectName: (project.data?.name as string | undefined) ?? null });
    })();
  }, [token, router]);

  async function save() {
    if (!about || !name.trim()) return;
    setSaving(true);
    setSaveError(null);
    const { error: e } = await supabase.rpc("abo_member_about", {
      p_project: about.projectId,
      p_name: name.trim().slice(0, NAME_MAX),
      p_role: role,
    });
    setSaving(false);
    if (e) {
      setSaveError("That didn’t save. Try again, or skip for now.");
      return;
    }
    router.replace(`/app/${about.projectId}`);
  }

  if (about) {
    return (
      <CenteredCard>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h1 className="text-lg font-semibold text-fg">
            You&rsquo;re joining {about.projectName ?? "the team"}
          </h1>
          <p className="mt-1 text-[13px] text-fg-muted">So the team knows who is who. It takes a few seconds.</p>

          <label className={`${label} mt-5`} htmlFor="join-name">
            Your name
          </label>
          <input
            id="join-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={NAME_MAX}
            autoFocus
            required
            className={field}
          />

          <div className={`${label} mt-4`} id="join-role">
            What you do there
          </div>
          <div role="radiogroup" aria-labelledby="join-role" className="grid grid-cols-2 gap-1.5">
            {MEMBER_ROLE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={role === o.value}
                onClick={() => setRole(role === o.value ? "" : o.value)}
                className={`rounded-control border px-3 py-2 text-left text-[13px] transition-colors ${
                  role === o.value
                    ? "border-primary bg-surface-hover font-medium text-fg"
                    : "border-line text-fg-muted hover:border-line-strong hover:text-fg"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>

          {saveError && <div className={`${note.critical} mt-4 text-[13px]`}>{saveError}</div>}

          <div className="mt-5 flex items-center justify-end gap-2">
            <button type="button" onClick={() => router.replace(`/app/${about.projectId}`)} className={button("plain")}>
              Skip for now
            </button>
            <button type="submit" disabled={saving || !name.trim()} className={button("primary")}>
              {saving ? "Saving…" : "Continue"}
            </button>
          </div>
        </form>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      {error ? (
        <div className="text-center">
          <div className="text-fg">{error}</div>
          <button onClick={() => router.replace("/dashboard")} className={`${button("primary")} mt-4`}>
            Go to my apps
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-neutral" />
          Opening the app…
        </div>
      )}
    </CenteredCard>
  );
}
