// What happens to a design once there is one, wherever it was asked:
// stored as a request, built if the merchant already said it could be,
// and the assistant's answer about it (lib/client-turn, api/mcp).
//
// Moved out of the MCP route whole so a durable turn can end with it:
// a design an assistant asked for used to be settled only inside the
// request that asked, and one that took longer than that request was lost.
//
// Callers: src/app/api/mcp/route.ts (submit_design), src/lib/client-turn.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { blueprintAsText } from "@/lib/engine";
import { designForView, type ViewDesign } from "@/lib/design-view";
import { projectFormat } from "@/lib/money";
import { describePlan, stepsToFinish } from "@/lib/describe";
import { applyPlans, logClientBuild } from "@/lib/apply";
import { noteJudgement } from "@/lib/judge";
import type { AssistantPlan, ModuleRow, NextStep, ProjectRow } from "@/lib/types";

export type Json = Record<string, unknown>;

/** What settling did: the assistant's answer, and what the thread says of it. */
export type Settled = {
  answer: Json;
  requestId: string | null;
  status: "built" | "partly built" | "waiting" | "error";
  /** What was built, for the undo the thread offers. */
  applied: unknown[];
  /** The build in the panel's own words, when something was built. */
  line?: string;
};

/**
 * Removing a section takes every row in it and does not come back. In
 * the app the owner types the section's name to confirm; there is no
 * such moment in a chat window, so this never travels that way. The
 * database refuses it too — this is only so the answer is a sentence
 * rather than an error.
 */
export const removals = (plans: AssistantPlan[]) =>
  plans.filter((p) => p.changeType === "MODULE_DELETE").map((p) => p.deleteConfirmName ?? "a section");

/**
 * Where the merchant goes, and what is in front of them when they
 * land.
 *
 * Every answer here used to hand back the app's front door and leave
 * them to find the thing: ten links, all of them /app/<id>, opening
 * on a closed bell. With the request named, the panel opens on it —
 * on a phone too, where the panel is a drawer that starts shut and
 * nothing at all was visible.
 */
export const openAt = (origin: string, projectId: string, requestId?: string | null) =>
  `${origin}/app/${projectId}${requestId ? `?waiting=${requestId}` : ""}`;

/**
 * There is no ceiling on automatic builds any more.
 *
 * There used to be five a day, against a client stuck in a loop. But
 * every design already spends one of the merchant's included turns
 * before it is built, so a loop stops itself at the quota — the
 * ceiling only ever stopped the merchant who meant it, and stopped
 * them in the middle of a day's work with no way to raise it.
 *
 * The one account with no quota to stop it is one an admin has
 * deliberately set to unlimited.
 */

/** Change types that only ever add. Everything else waits. */
// What may be built without the merchant reading it first.
//
// The line is not how visible the change is — a whole new section
// appears in the sidebar unasked and has always been on this list. It
// is whether anything can be lost. FIELD_ADD cannot: the validator
// refuses it unless every existing column survives, in its existing
// order, with at least one new one appended. Leaving it off while
// NEW_MODULE was on was an inconsistency, not a safeguard.
//
// Everything else still waits, because it edits what is already
// there — or, for AUTOMATION_ADD, starts something that writes to
// rows on its own afterwards.

/** What went in, in the words the panel already uses for a build. */
export function builtLine(plans: AssistantPlan[], modules: ModuleRow[], errors: string[]): string {
  const titles = plans.map((p) => describePlan(p, modules).title).filter(Boolean);
  const shown = titles.slice(0, 3).join(" · ");
  const rest = titles.length - 3;
  const head = `✅ ${shown}${rest > 0 ? ` · and ${rest} more` : ""}`;
  return errors.length ? `${head} — the rest stopped on an error.` : `${head}.`;
}

/** A tool's answer, as MCP wants it: text the model can read. */
export const text = (value: unknown): Json => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

/**
 * What happens to a design once there is one: stored, shown, and built
 * only if the merchant already said it could be.
 *
 * Both doors end here — the one where Warmluke does the designing, and
 * the one where the merchant's own assistant does. They must agree
 * about approval, and the only way to be sure of that is for there to
 * be one copy of it. check-auto-scope leans on exactly that: it drives
 * the free door, because the decision is the same one.
 */
export async function settleDesign(opts: {
  db: SupabaseClient;
  origin: string;
  project: ProjectRow;
  moduleList: ModuleRow[];
  plans: AssistantPlan[];
  design: string | null;
  unmet: string[];
  request: string;
  /**
   * What the design offered to do after this one, in the merchant's
   * words. Luke has produced these since follow-ups were added and
   * this door threw them away, so a build through their own
   * assistant ended in silence while the same build in the app ended
   * with two things worth doing next.
   */
  next?: NextStep[];
  store: Parameters<typeof blueprintAsText>[2];
  /** Told once the request row is written, so the caller can stop treating the turn as refundable. */
  charged?: () => void;
  /** What may run after the answer: next/server's after() in a request, awaited in a durable step. */
  later: (fn: () => Promise<unknown>) => void;
  /**
   * Asked in a thread of its own (lib/client-turn), which records the
   * build with its undo on the answer's line. Otherwise it is logged in
   * "Changes from your AI", as it always was.
   */
  inThread?: boolean;
}): Promise<Settled> {
  const { db, origin, project, moduleList, plans, design, unmet, next, request, store, charged, later, inThread } =
    opts;
  // Offered, never done from here: each is a sentence the merchant
  // might say, not a button this can press. Not named `after`, which
  // is next/server's — shadowing it turns the judge below into a
  // type error, and would have turned it into silence.
  const followUps = (next ?? []).filter((n) => n?.label && n?.prompt).slice(0, 2);
  const whatNext = followUps.length
    ? {
        next_steps: followUps.map((n) => ({ say: n.label, as: n.prompt })),
        next_steps_note:
          "Offer these in their own words and wait. Each is another change, so it needs proposing and approving like this one did.",
      }
    : {};

  // ── Does this one get to skip the merchant? ──────────────
  //
  // The switch says they are willing; this decides whether THIS
  // design qualifies. The setting says everything, so the only
  // thing left to decide is whether there is anything to build.
  // The switch means everything now, so the only design that
  // cannot be built on its own is one with nothing in it.
  const autoReason = plans.length === 0 ? "there is nothing to build" : null;
  const wantsAuto = project.auto_build === true;

  // A design that removes a section is now proposed like any
  // other, and built like no other.
  //
  // It used to be refused here outright, so "delete the Variants
  // section" was a dead end: no request, no card, nothing for the
  // merchant to act on but a sentence telling them to go and find
  // it themselves. The refusal was aimed at the right thing —
  // removal takes every row and does not come back, and the one
  // confirmation that guards it is typing the section's name,
  // which a chat window cannot ask for. But refusing the REQUEST
  // was never what protected them; refusing the BUILD is.
  //
  // So it waits in Warmluke, where that name is typed. Never
  // automatically, whatever the project's setting says, and
  // approve_change still refuses it.
  const gone = removals(plans);

  // And one that leaves a rule waiting on a rule it turns off (heads_up,
  // lib/ai.ts) is put to the merchant first: with automatic builds on,
  // an assistant turned off the two rules that flagged repeat orders,
  // and nothing flagged one for a day (4 Oct).
  const headsUp = plans.flatMap((p) => p.heads_up ?? []);
  const automatic = wantsAuto && autoReason === null && gone.length === 0 && headsUp.length === 0;
  // Why an automatic build did not happen, when it was meant to.
  let autoFailed: string[] = [];

  const { data: requestId, error: err } = await db.rpc("abo_mcp_propose", {
    p_project: project.id,
    p_request: request,
    p_plans: plans,
    p_summary: design,
    // Stored apart from the rendered text because the card keeps
    // this visible while the details fold away: everything else
    // can be rebuilt from the plans, this cannot.
    p_unmet: unmet,
    // And the follow-ups, for the same reason. With auto-build
    // off the build happens in approve_change hours later, and
    // nothing there could have known what this design offered.
    p_next: followUps.length ? followUps : null,
  });
  if (err) return { answer: text({ error: err.message }), requestId: null, status: "error", applied: [] };
  charged?.();
  // What the merchant's AI draws beside this answer, when it can (lib/design-view).
  const { data: shop } = await db
    .from("stores")
    .select("currency, country")
    .eq("project_id", project.id)
    .in("status", ["connected", "uninstalled"])
    .maybeSingle();
  const viewOf = async (status: ViewDesign["status"]) => ({
    design: await designForView(db, project.id, moduleList, plans, {
      status,
      request,
      open: typeof requestId === "string" ? openAt(origin, project.id, requestId) : openAt(origin, project.id),
      notCovered: unmet,
      format: projectFormat(project, shop),
    }),
  });

  // A second opinion on the design — Luke's or the assistant's own
  // — taken after this answer has gone out, and written down where
  // nothing reads it yet.
  later(() =>
    noteJudgement(db, {
      projectId: project.id,
      source: "mcp",
      ref: requestId as string,
      request,
      plans,
      modules: moduleList,
      store,
      unmet,
    })
  );

  if (automatic) {
    // auto-build IS the approval — given in Warmluke, on this
    // project, before any of this was asked for. The stamp records
    // that, so the row says who agreed and when.
    //
    // And the answer is read. It was not: abo_approve_request can
    // refuse — it is the only place that decides whether a client
    // may stamp anything — and this went straight on to apply
    // plans that abo_build then rejected one by one for want of an
    // approved_at. The failure arrived as a list of write errors
    // about permissions, never as the reason it was actually
    // refused.
    const { data: nod } = await db.rpc("abo_approve_request", { p_request: requestId });
    const approval = nod as { approved: boolean; reason?: string } | null;
    if (!approval?.approved) {
      return {
        requestId: requestId as string,
        status: "waiting",
        applied: [],
        answer: text({
          status: "waiting for approval",
          request_id: requestId,
          design,
          not_automatic_because: approval?.reason ?? "the merchant has to approve this one in Warmluke",
          note: "Nothing has changed yet. Read this design back to the merchant, then read them what_the_merchant_does — it is what actually finishes this.",
          what_the_merchant_does: stepsToFinish(
            { status: "pending", plans },
            openAt(origin, project.id, requestId as string)
          ),
          open: openAt(origin, project.id, requestId as string),
        }),
      };
    }
    const { applied, errors } = await applyPlans(db, project.id, plans, requestId as string);
    if (applied.length > 0) {
      await db.rpc("abo_build", {
        p_project: project.id,
        p_request: requestId,
        p_op: "request_built",
        // What really happened, not that something happened. With
        // errors in it the row lands as partly_built. And that
        // nobody tapped anything — inside the same write, because
        // this used to be a second one straight at the table, and
        // a connected client is not allowed to write at the table.
        // For every build a real assistant made, it silently did
        // not land, and the row read as approved by the merchant.
        p_payload: { applied, errors, auto_built: true },
      });
      // Written here, not by the browser. Nobody tapped anything —
      // that is the whole point of automatic builds — so if this
      // did not record it, the app would change and the merchant's
      // history would stay blank.
      if (!inThread) await logClientBuild(db, project.id, request, builtLine(plans, moduleList, errors), applied);
      return {
        requestId: requestId as string,
        status: errors.length ? "partly built" : "built",
        applied,
        line: builtLine(plans, moduleList, errors),
        answer: {
          ...text({
            status: errors.length ? "partly built" : "built",
            note: "This app builds without waiting for approval. Tell the merchant what was built — it is already live and shows in their panel. They can carry on here, or open Warmluke and ask Luke inside it; both reach the same app.",
            ...whatNext,
            // Named even though nobody has to approve it. An
            // automatic build was the one answer that came back
            // without an id, so an assistant that built something
            // had no way to refer to it afterwards — not in
            // build_history, not to the merchant. It is the same id
            // every other answer here carries.
            request_id: requestId,
            built: applied,
            ...(errors.length ? { not_built: errors.slice(0, 3) } : {}),
            design,
            // Built already, so there is nothing to finish — but a
            // half-built one has a card worth opening, and this
            // says so or stays quiet, from the row itself.
            ...(errors.length
              ? {
                  what_the_merchant_does: stepsToFinish(
                    { status: "partly_built", plans },
                    openAt(origin, project.id, requestId as string)
                  ),
                }
              : {}),
            open: openAt(origin, project.id, requestId as string),
          }),
          structuredContent: await viewOf("built"),
        },
      };
    }
    // Nothing applied. It stays a request for a person to look at
    // rather than being reported as done — but the reason it could
    // not be built used to be dropped right here, and the answer
    // was an ordinary "waiting for approval". So a merchant with
    // automatic builds switched on saw it silently stop working,
    // and nothing anywhere said why. Carried out instead.
    autoFailed = errors;
    // Recorded on the request, not only returned to the assistant.
    // The merchant looks at a card in Warmluke, not at the tool's
    // answer — and a card that asks with the setting on has to be
    // able to say why, or it reads as the setting not working.
    // Through abo_build, not at the table: a client cannot write
    // there, and this reason was never landing for the one kind
    // of caller that produces it.
    await db.rpc("abo_build", {
      p_project: project.id,
      p_request: requestId,
      p_op: "request_outcome",
      p_payload: { applied: [], errors },
    });
  }

  return {
    requestId: requestId as string,
    status: "waiting",
    applied: [],
    answer: {
      ...text({
        // Said plainly so the model reports it plainly: nothing has
        // been built, and somebody still has to say yes.
        status: "waiting for approval",
        note: "Nothing has changed yet. Read this design back to the merchant word for word. If they approve, call approve_change with the request_id. If they leave it and come back later, check pending_changes rather than trusting this id — they may have dealt with it in Warmluke.",
        request_id: requestId,
        design,
        ...whatNext,
        ...(gone.length
          ? {
              cannot_be_approved_from_here: `This removes ${gone.join(", ")}, and removal takes every row in it. It is waiting in Warmluke, where the merchant types the section's name to confirm. Do not call approve_change for it — say plainly that this one they have to confirm themselves.`,
            }
          : {}),
        // When the merchant has asked for automatic builds, say why
        // this one still needs them. Otherwise they are left
        // wondering why the setting did nothing.
        ...(autoFailed.length > 0
          ? {
              not_automatic_because: `it could not be built: ${autoFailed.slice(0, 3).join("; ")}`,
            }
          : wantsAuto && autoReason
            ? { not_automatic_because: autoReason }
            : wantsAuto && headsUp.length
              ? { not_automatic_because: "it turns off a rule another one waits on (heads_up): the merchant decides" }
              : {}),
        ...(headsUp.length ? { heads_up: headsUp } : {}),
        what_the_merchant_does: stepsToFinish(
          { status: "pending", plans },
          openAt(origin, project.id, requestId as string)
        ),
        open: openAt(origin, project.id, requestId as string),
      }),
      structuredContent: await viewOf("waiting"),
    },
  };
}
