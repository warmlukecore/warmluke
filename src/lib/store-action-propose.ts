// ─────────────────────────────────────────────────────────────
// Asking for a change to the merchant's live shop, one way for everyone.
//
// A merchant's own assistant asks over MCP (propose_store_action) and
// Luke asks from the chat; both come here, so the gates are one set:
// the account's switch, a change the registry knows, a connector that
// exists, targets that are Shopify's own ids and not too many, what the
// change itself needs, and what the store has allowed. Then the
// database's own door, abo_action_propose, which checks ownership and
// the switch again. Nothing here changes the shop. It writes a request
// the merchant reads, in words written from the change itself and never
// from the assistant, and it waits for their yes (POST /api/store-actions).
//
// Server only: store-actions.ts is read by the browser, so the database
// and the AI SDK stay out of it.
//
// Callers: src/app/api/mcp/route.ts, src/lib/engine.ts,
// scripts/check-store-action-propose.mjs.
// ─────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { jsonSchema, tool, type JSONSchema7, type Tool } from "ai";
import {
  ACTIONS,
  MOST_TARGETS,
  STORE_ACTIONS,
  actionSpec,
  sameValue,
  setOf,
  wasOf,
  whatOnlyTheMerchantDoes,
  type ActionParams,
  type ActionTarget,
  type StoreActionSpec,
} from "@/lib/store-actions";
import type { StoreBrief } from "@/lib/store-read";
import { hasScope } from "@/lib/shopify-resources";

/**
 * Everything that can be asked for, off the registry.
 *
 * Built here rather than written into a tool's description, so an
 * action added tomorrow is offered tomorrow. It carries what each
 * one needs and whether it can be taken back, because an assistant
 * that knows a change is permanent asks differently.
 */
export const ACTION_CATALOGUE = ACTIONS.map((a) => {
  const spec = STORE_ACTIONS[a];
  return {
    action: a,
    does: spec.label,
    store_must_allow: spec.scopes,
    // A change of fields: what each target may set, by the name its list reads it as.
    ...(spec.ask.kind === "fields"
      ? {
          each_target_sets: Object.fromEntries(
            Object.entries(spec.ask.fields)
              .filter(([, d]) => !d.byHand)
              .map(([f, d]) => [
                f,
                d.choices
                  ? `${d.label}: one of ${d.choices.join(", ")}`
                  : `${d.label}${d.blank ? " (may be emptied)" : ""}`,
              ])
          ),
        }
      : {}),
    ...(spec.undo
      ? { can_be_taken_back: true }
      : { cannot_be_taken_back: spec.undoNote ?? "This one cannot be undone." }),
  };
});

/**
 * What the assistant sent, as targets this can work with.
 *
 * A model asked for a tag on "1234" and on "gid://shopify/Order/1"
 * in the same breath; both are the obvious thing to send and only
 * one of them means anything to Shopify. Strings are lifted into
 * objects, anything without a usable id is named back.
 */
export function readTargets(given: unknown): { targets: ActionTarget[]; wrong: string[] } {
  const list = Array.isArray(given) ? given : [];
  const targets: ActionTarget[] = [];
  const wrong: string[] = [];
  for (const item of list) {
    const t =
      typeof item === "string"
        ? { id: item }
        : item && typeof item === "object"
          ? ({ ...(item as Record<string, unknown>) } as ActionTarget)
          : null;
    const id = t && typeof t.id === "string" ? t.id.trim() : "";
    if (!id) {
      wrong.push(`${JSON.stringify(item).slice(0, 60)} has no id`);
    } else if (!/^gid:\/\/shopify\/[A-Za-z]+\/\d+$/.test(id)) {
      wrong.push(`"${id}" is not a Shopify id — they look like gid://shopify/Order/1234`);
    } else {
      targets.push({ ...t, id });
    }
  }
  return { targets, wrong };
}

/** What a change takes, as JSON Schema. MCP adds which store and which app. */
export const PROPOSE_INPUT: JSONSchema7 & { type: "object"; properties: Record<string, JSONSchema7> } = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description: `One of: ${ACTIONS.join(", ")}.`,
    },
    targets: {
      type: "array",
      items: { type: "object" },
      description:
        'What it changes. Each carries Shopify\'s own id — { "id": "gid://shopify/Order/1234" } — plus whatever that change needs for that one line: a quantity, or for a change of fields what it sets, { "set": { "email": "…" } }.',
    },
    params: {
      type: "object",
      description: 'What to set, the same for every target: { "tags": ["rush"] } or { "note": "…" }.',
    },
    undo_of: {
      type: "string",
      description:
        "Instead of action and targets: the action_id of a change that went through, to ask for it to be put back. Warmluke builds the opposite from what it really changed (a stock count goes back only while Shopify's is still the one that change left). It waits for the merchant's yes like any other.",
    },
  },
};

export type Proposal =
  | { ok: true; id: string; action: string; summary: string; targets: ActionTarget[]; spec: StoreActionSpec }
  /** Refused, with the answer the assistant reads. `reconnect`: the store has not allowed it. */
  | { ok: false; answer: Record<string, unknown>; reconnect?: boolean };

/** Asks for one change, as the caller, on one store. Never changes the shop itself. */
/**
 * The opposite of a change that went through (7 Oct), as a change to ask
 * for: on the lines it really changed, as its registry entry puts them
 * back. Read from the row, never from what the caller says it was. An
 * undo of an undo is a redo.
 */
async function undoArgs(
  db: SupabaseClient,
  storeId: string,
  actionId: string
): Promise<{ args: { action: string; targets: ActionTarget[]; params: ActionParams } } | { error: string }> {
  const { data: was } = await db
    .from("store_actions")
    .select("store_id, action, status, targets, params, outcome")
    .eq("id", actionId)
    .maybeSingle();
  if (!was) return { error: "That change is not one you can see." };
  if (was.store_id !== storeId) return { error: "That change was made in another store." };
  if (was.status !== "done" && was.status !== "partly_done") {
    return { error: "Only a change that went through can be put back." };
  }
  const spec = actionSpec(String(was.action));
  if (!spec?.undo) return { error: spec?.undoNote ?? "This change cannot be undone." };
  // The lines it changed: each id as often as it went through.
  const went = [...((was.outcome as { done?: string[] } | null)?.done ?? [])];
  const changed = ((was.targets ?? []) as ActionTarget[]).filter((t) => {
    const at = went.indexOf(t.id);
    if (at < 0) return false;
    went.splice(at, 1);
    return true;
  });
  const back = spec.undo(changed, (was.params ?? {}) as ActionParams);
  if (!back.targets.length) return { error: "Nothing it changed can be put back." };
  return { args: back };
}

export async function proposeStoreAction(
  db: SupabaseClient,
  store: StoreBrief,
  args: Record<string, unknown>,
  /** Typed by the merchant on a list in Warmluke: never set for Luke or their AI. */
  opts: { byHand?: boolean } = {}
): Promise<Proposal> {
  // Refused here as well as in SQL. The database is what makes it
  // true; this is what makes it a sentence the assistant can read
  // out instead of an error code.
  // The owner's account switch, whoever asks (0195): a teammate's own
  // account was never turned on for a store that is not theirs.
  const { data: allowed } = await db.rpc("abo_store_actions_on", { p_project: store.project_id });
  if (allowed !== true) {
    return {
      ok: false,
      answer: {
        error: "Changing the shop from Warmluke is not turned on for this account.",
        note: "Reading everything still works, and designs can still be proposed and built. Ask Warmluke to turn this on for them.",
      },
    };
  }

  // Put back: built here, so its targets already say what each line
  // changes from (what that change left), and are not read again from
  // Warmluke's copy, which may not have caught up yet.
  const undoing = typeof args.undo_of === "string" && args.undo_of.trim() !== "";
  if (undoing) {
    const back = await undoArgs(db, store.id, String(args.undo_of).trim());
    if ("error" in back) return { ok: false, answer: { error: back.error } };
    args = back.args;
  }

  const wantedAction = String(args.action ?? "").trim();
  const spec = actionSpec(wantedAction);
  if (!spec) {
    return {
      ok: false,
      answer: {
        error: wantedAction ? `There is no change called "${wantedAction}".` : "Say which change to ask for.",
        what_can_be_asked_for: ACTION_CATALOGUE,
      },
    };
  }
  // A second connector's actions will be in the same registry and
  // must not be attempted down this road.
  if (spec.connector !== "shopify") {
    return { ok: false, answer: { error: `Nothing here can reach ${spec.connector} yet.` } };
  }

  const { targets, wrong } = readTargets(args.targets);
  if (wrong.length) {
    return {
      ok: false,
      answer: {
        error: "Some of what you named cannot be acted on.",
        these: wrong.slice(0, 5),
        note: "Shopify's own ids, as they come back from the reading tools.",
      },
    };
  }
  if (targets.length > MOST_TARGETS) {
    return {
      ok: false,
      answer: {
        error: `That is ${targets.length} things at once, and ${MOST_TARGETS} is the most one change may touch.`,
        note: "Ask for it in smaller pieces, so the merchant can read what they are agreeing to.",
      },
    };
  }

  // A price or a status is the merchant's own hand, never an assistant's ask (NEVER_DOES).
  if (spec.ask.kind === "fields" && !opts.byHand) {
    const ask = spec.ask;
    const hand = [...new Set(targets.flatMap((t) => Object.keys(setOf(t)).filter((f) => ask.fields[f]?.byHand)))];
    if (hand.length) {
      return {
        ok: false,
        answer: {
          error: `Only the merchant changes ${hand.map((f) => `a ${ask.noun}'s ${ask.fields[f].label.toLowerCase()}`).join(" or ")}, by typing it on the list in Warmluke: Luke and their own AI never ${whatOnlyTheMerchantDoes()} anything.`,
          note: "Nothing was asked for. Tell them where: the list, Edit, then type it in.",
        },
      };
    }
  }

  const params = (args.params && typeof args.params === "object" ? args.params : {}) as Record<string, unknown>;
  const wrongHow = spec.check(targets, params);
  if (wrongHow) {
    return {
      ok: false,
      answer: { error: wrongHow, what_can_be_asked_for: [ACTION_CATALOGUE.find((c) => c.action === wantedAction)] },
    };
  }

  // What the store has actually allowed, when anybody has recorded
  // it. Null means nobody has looked since the grant, and refusing
  // on that would lock out every store connected before the column
  // existed — so the executor is left to find out instead.
  const { data: grantRow } = await db.from("stores").select("granted_scopes").eq("id", store.id).maybeSingle();
  const granted = (grantRow?.granted_scopes ?? null) as string[] | null;
  const short = granted ? spec.scopes.filter((sc) => !hasScope(granted, sc)) : [];
  if (short.length) {
    return {
      ok: false,
      reconnect: true,
      answer: {
        error: `${store.shop_domain} has not allowed Warmluke to ${short.join(", ")}.`,
        note: "Nothing was asked for. The merchant reconnects the store in Warmluke to grant it, and then this can be proposed.",
      },
    };
  }

  // What the server knows about each target, added before anybody is
  // asked: the count a stock line changes from, read from Warmluke's
  // copy. It replaces anything the caller sent under the same name.
  let prepared = targets;
  if (spec.prepare && !undoing) {
    const got = await spec.prepare(db, store.id, targets);
    if ("error" in got) return { ok: false, answer: { error: got.error } };
    prepared = got.targets;
  } else if (spec.prepare && undoing && spec.ask.kind === "fields") {
    // Put back only what nobody has changed since: the copy says what the
    // change left (or, not caught up yet, what it replaced), else it is refused.
    const fields = spec.ask.fields;
    const now = await spec.prepare(db, store.id, targets);
    if ("error" in now) return { ok: false, answer: { error: now.error } };
    const moved = targets.filter((t, i) =>
      Object.entries(wasOf(t)).some(([f, left]) => {
        const there = wasOf(now.targets[i])[f];
        return !sameValue(fields[f], there, left) && !sameValue(fields[f], there, setOf(t)[f]);
      })
    );
    if (moved.length) {
      return {
        ok: false,
        answer: {
          error: `${moved.length === 1 ? "It was" : `${moved.length} of them were`} changed again since, in Shopify or here, so nothing was put back.`,
        },
      };
    }
    prepared = targets.map((t, i) => ({ ...now.targets[i], set: setOf(t), was: wasOf(t) }));
  }

  // The sentence on the card is written from the change itself,
  // never from the assistant. Whatever it told the merchant this
  // does, what they agree to is this line.
  const summary = spec.say(prepared, params);
  const { data: actionId, error: proposeError } = await db.rpc("abo_action_propose", {
    p_project: store.project_id,
    p_store: store.id,
    p_action: wantedAction,
    p_targets: prepared,
    p_params: params,
    p_summary: summary,
  });
  if (proposeError) return { ok: false, answer: { error: proposeError.message } };
  return { ok: true, id: actionId as string, action: wantedAction, summary, targets: prepared, spec };
}

/**
 * The same ask, as a tool Luke may call from the chat. `observe` hears
 * each change asked for. The same change asked for twice in one turn
 * (a provider that failed halfway and was tried again) is one request,
 * not two cards to agree to.
 */
export function aiProposeTool(
  ctx: { db: SupabaseClient; store: StoreBrief },
  observe?: (asked: { id: string; summary: string }) => void
): Tool {
  const asked = new Map<string, Record<string, unknown>>();
  return tool({
    description:
      "Ask for a change IN the merchant's Shopify shop itself: a tag on some orders, a note, a stock count. Only when they ask for one. Find the Shopify ids first with search_store: orders, products and customers carry shopify_id, stock carries inventory_item_id and location_id. Warmluke writes the sentence they will read, from the change, not from you. Nothing happens until they agree to it on the card that appears below this conversation, and you cannot agree for them, even for a kind they send straight to Shopify from their own lists (Settings → Store), which covers only changes they make themselves; for many rows, they can also tick them on the store list, or press Edit and type into the cells, and change them there. What can be asked for: " +
      ACTION_CATALOGUE.map((c) => `${c.action} (${c.does})`).join(", ") +
      ".",
    inputSchema: jsonSchema<Record<string, unknown>>(PROPOSE_INPUT),
    execute: async (input: Record<string, unknown>) => {
      const args = input && typeof input === "object" ? input : {};
      const key = JSON.stringify([args.action, args.targets, args.params]);
      const earlier = asked.get(key);
      if (earlier) return earlier;
      const p = await proposeStoreAction(ctx.db, ctx.store, args);
      if (!p.ok) return p.answer;
      const answer = {
        status: "waiting for the merchant",
        action_id: p.id,
        changes: p.summary,
        touches: p.targets.length,
        ...(p.spec.undo
          ? { can_be_taken_back: true }
          : { cannot_be_taken_back: p.spec.undoNote ?? "This one cannot be undone." }),
        note: "Nothing has changed in the shop. In your reply, say what it will do and that it is waiting for their yes on the card below. Never say it is done.",
      };
      asked.set(key, answer);
      try {
        observe?.({ id: p.id, summary: p.summary });
      } catch {
        // A listener that throws does not take the request with it.
      }
      return answer;
    },
  });
}
