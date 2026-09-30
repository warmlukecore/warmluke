// ─────────────────────────────────────────────────────────────
// Model calls, recorded once and played back.
//
// Luke's checks talk to real models: that costs money, needs keys CI
// does not hold, and the answer differs every time. With MODEL_TAPE set,
// every model call (Anthropic, Gemini, Jev) goes through here:
//
//   record   the real call is made, and what came back is kept in
//            tapes/<key>.json, where <key> is the request itself
//   replay   the kept answer comes back instead: no network, no key
//
// The key is the whole request (system prompt, conversation, tools, as
// normalised text: the ids, dates and store addresses that differ
// between runs become placeholders, and tool calls are numbered by
// position, since Gemini's are made up by the SDK), without the model's name: a
// recording answers only the request it was made for. Change what Luke
// is told and the old answer no longer matches, and the miss says what
// changed. A hand-written fixture matched on a line of the question, as
// CopilotKit's aimock does and says itself, goes on answering an old
// prompt with an old answer, and the test goes on passing.
//
// Which models answered is kept beside the recordings, and replay uses
// those, so the calls go down the same roads they were recorded on.
// A request made again in one run (a retry) gets the next recording of
// it, then the last one again, so a provider that was busy twice and
// then gave way is played back busy twice and then giving way.
//
// Never in production: VERCEL_ENV=production switches it off whatever
// the setting says. Only answers and fingerprints are kept, never a key
// or a header; the answers are about the checks' own throwaway stores.
//
// Callers: src/lib/ai.ts (reaching, modelFor, the key checks),
// src/lib/jev.ts, scripts/check-model-tape.mjs.
// ─────────────────────────────────────────────────────────────

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { jobNow } from "@/lib/usage";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * record: every call is made and kept. replay: every call is played, and
 * one never recorded fails. fill: played as replay, and only a call with
 * no recording is made and kept, so a change that alters one request
 * costs that request and not the whole check again.
 */
export type TapeMode = "record" | "replay" | "fill";

/** Recording, replaying, or neither. Never either in production. */
export function tapeMode(): TapeMode | null {
  const m = process.env.MODEL_TAPE?.trim();
  if (m !== "record" && m !== "replay" && m !== "fill") return null;
  if (process.env.VERCEL_ENV === "production") return null;
  return m;
}

/** Replaying, or filling in: what was recorded plays, as it would in CI. */
export const replaying = () => tapeMode() === "replay" || tapeMode() === "fill";

/**
 * Says on a response whether this server's model calls are recorded or
 * played back, so a check can tell it is talking to the server it thinks
 * it is. Nothing at all when taping is off, which production always is.
 */
export const tapeHeaders = (): Record<string, string> => {
  const mode = tapeMode();
  return mode ? { "x-model-tape": mode } : {};
};

/**
 * Where the tapes are: MODEL_TAPE_DIR, relative to the working directory or absolute.
 * turbopackIgnore: a path worked out at run time otherwise makes the build ship the
 * whole project with every route; production never reads a tape.
 */
const dir = () => resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.MODEL_TAPE_DIR ?? "tapes");

/** What differs between two runs of the same check, and says nothing about the request. */
const VOLATILE: ReadonlyArray<[RegExp, string]> = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "‹id›"],
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, "‹time›"],
  [/\d{4}-\d{2}-\d{2}/g, "‹date›"],
  [/(gid:\/\/shopify\/[A-Za-z]+\/)\d+/g, "$1‹n›"],
  [/[a-z0-9-]+\.myshopify\.com/gi, "‹shop›"],
  [/\b(toolu|call|msg)_[A-Za-z0-9]+/g, "‹$1›"],
];

export const normalise = (text: string) => VOLATILE.reduce((t, [re, to]) => t.replace(re, to), text);

const hash = (v: unknown) =>
  createHash("sha256")
    .update(normalise(JSON.stringify(v ?? null)))
    .digest("hex")
    .slice(0, 16);

type Kept = {
  label: string;
  /** The last thing the user said, for a person reading the tape. */
  asked: string;
  /** tag: what the call was for (the road for a reply, else its job), read when a prompt that changed falls back. */
  parts: { system: string; tools: string; conversation: string; tag?: string };
  responses: Array<{ status: number; type: string; body: string }>;
};

/**
 * Tool calls by where they fall in the conversation, not by their ids.
 * Gemini sends a call with no id and the SDK makes one up at random, so
 * a turn that went through Gemini carried a new id into every request
 * after it, on every run, and matched no recording from the second step
 * on. Renumbered in the order they appear, a call and its result still
 * pair up, and nothing random is left in the key.
 */
function renumberCalls<T>(value: T): T {
  const seen = new Map<string, string>();
  const as = (id: unknown) => {
    if (typeof id !== "string") return id;
    if (!seen.has(id)) seen.set(id, `‹call${seen.size + 1}›`);
    return seen.get(id);
  };
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== "object") return x;
    const o: Record<string, unknown> = {};
    const named = (x as Record<string, unknown>).type === "tool_use";
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      // Anthropic's tool_use id and tool_result's pointer to it; Gemini's
      // functionCall and functionResponse, when they carry one.
      if ((k === "id" && named) || k === "tool_use_id") o[k] = as(v);
      else if ((k === "functionCall" || k === "functionResponse") && v && typeof v === "object" && "id" in v)
        o[k] = walk({ ...(v as Record<string, unknown>), id: as((v as { id: unknown }).id) });
      else o[k] = walk(v);
    }
    return o;
  };
  return walk(value) as T;
}

/** The cap every recording was made under (lib/ai.ts MAX_OUTPUT_TOKENS on 2026-09-28). */
const KEYED_CAP = 12000;

/** A request, as the parts it is known by. */
export function fingerprint(label: string, url: string, body: string) {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(body) as Record<string, unknown>;
  } catch {
    o = { raw: body };
  }
  const system = o.system ?? o.systemInstruction ?? null;
  const tools = o.tools ?? null;
  const rest: Record<string, unknown> = renumberCalls({ ...o });
  for (const k of ["system", "systemInstruction", "tools", "model"]) delete rest[k];
  // The output cap is a setting, not the conversation. Keyed as the cap
  // the recordings were made under, so moving it changes no key: moving
  // it from 6000 to 12000 once cost every recording there was.
  if (typeof rest.max_tokens === "number") rest.max_tokens = KEYED_CAP;
  // How hard it thinks is a setting too (lib/ai.ts EFFORT): recordings
  // made before it was sent still play.
  const oc = rest.output_config as Record<string, unknown> | undefined;
  if (oc && "effort" in oc) {
    const { effort: _effort, ...kept } = oc;
    if (Object.keys(kept).length) rest.output_config = kept;
    else delete rest.output_config;
  }
  const gen = rest.generationConfig as Record<string, unknown> | undefined;
  if (gen && typeof gen.maxOutputTokens === "number") rest.generationConfig = { ...gen, maxOutputTokens: KEYED_CAP };
  // The road, without the model: Gemini names it in the path. And
  // without a proxy's prefix: a router serving Anthropic's API at
  // /api/v1/messages answers the same request as /v1/messages, and a
  // recording made through one must play back through the other.
  const road = new URL(url).pathname.replace(/^.*?(\/v1\/)/, "$1").replace(/\/models\/[^/:]+/, "/models/‹model›");
  const parts = { system: hash(system), tools: hash(tools), conversation: hash({ road, rest }) };
  return { key: hash([label, parts]), parts, asked: lastSaid(rest) };
}

/** The last user words in an Anthropic, Gemini or Jev request. */
function lastSaid(rest: Record<string, unknown>): string {
  const turns = (rest.messages ?? rest.contents) as Array<Record<string, unknown>> | undefined;
  const user = Array.isArray(turns) ? [...turns].reverse().find((t) => t.role === "user") : undefined;
  const content = user?.content ?? user?.parts;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((c) => (c as { text?: string }).text ?? "").join(" ")
        : typeof (rest.state as { question?: unknown } | undefined)?.question === "string"
          ? String((rest.state as { question: string }).question)
          : "";
  return normalise(text).replace(/\s+/g, " ").trim().slice(-200);
}

const read = (file: string): Kept | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Kept;
  } catch {
    return null;
  }
};

/**
 * Which road a reply call is on, said by the engine around the call: the
 * talk road and the design road can send the very same conversation, and
 * a prompt that changed must still play the one made on its own road.
 */
export const tapeRoad = new AsyncLocalStorage<string>();
const tagNow = () => {
  const job = jobNow();
  return job && job !== "reply" ? job : (tapeRoad.getStore() ?? "reply");
};

/** Why a replayed request has no recording: its conversation was never recorded, under any prompt. */
function diagnose(label: string, fp: ReturnType<typeof fingerprint>): string {
  return `[tape] no recording for a ${label} call (${fp.key}): nothing like this conversation was recorded. Asked: "${fp.asked.slice(-100)}". Record again with MODEL_TAPE=record.`;
}

// The recordings by conversation, read once a process (and again after
// a recording is written): what a prompt that changed falls back on.
let byConversation: Map<string, Array<{ key: string; kept: Kept }>> | null = null;

/**
 * This very conversation, recorded under another prompt or other tools.
 * What the model is told changes with every prompt edit, and a tape keyed
 * on it died with each one: a paid re-record for replies that test the
 * same plumbing. So a prompt that changed plays the conversation's
 * recording anyway, and says so once. Tapes test the code around the
 * model; how good its answers are is for evals on the real model.
 * Recorded under two prompts: the one made for the same thing (its road
 * or job), else the one with the same tools, else the first by name.
 */
function sameConversation(label: string, fp: ReturnType<typeof fingerprint>, tag: string) {
  if (!byConversation) {
    byConversation = new Map();
    const all = existsSync(dir()) ? readdirSync(dir()).filter((f) => f.endsWith(".json") && !f.startsWith("_")) : [];
    for (const f of all.sort()) {
      const kept = read(join(dir(), f));
      if (!kept?.responses?.length) continue;
      const at = `${kept.label}|${kept.parts.conversation}`;
      byConversation.set(at, [...(byConversation.get(at) ?? []), { key: f.slice(0, -5), kept }]);
    }
  }
  const found = byConversation.get(`${label}|${fp.parts.conversation}`) ?? [];
  return (
    found.find((c) => c.kept.parts.tag === tag) ??
    found.find((c) => c.kept.parts.tools === fp.parts.tools) ??
    found[0] ??
    null
  );
}
const toldOnce = new Set<string>();

// Per process: how far through each recording replay has got, and which
// recordings this run has started over.
const cursor = new Map<string, number>();
const begun = new Set<string>();

const stopped = () => Object.assign(new Error("The call was stopped."), { name: "AbortError" });

/**
 * A fetch that records or replays when MODEL_TAPE says so, and is
 * `real` untouched otherwise. `label` is which provider this is.
 */
export function tapeFetch(label: string, real: typeof fetch): typeof fetch {
  return async (input, init) => {
    const mode = tapeMode();
    if (!mode) return real(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const fp = fingerprint(label, url, typeof init?.body === "string" ? init.body : "");
    const file = join(dir(), `${fp.key}.json`);
    // MODEL_TAPE_DUMP=<dir> keeps each request as sent, named by its key,
    // so a key that never matches can be read side by side with the one
    // that was recorded, part by part.
    if (process.env.MODEL_TAPE_DUMP)
      writeFileSync(
        join(process.env.MODEL_TAPE_DUMP, `${fp.key}.request.json`),
        JSON.stringify({ label, url, parts: fp.parts, body: init?.body ?? null }, null, 1)
      );

    const exact = mode === "record" ? null : read(file);
    const played =
      mode === "record"
        ? null
        : exact?.responses?.length
          ? { key: fp.key, kept: exact }
          : sameConversation(label, fp, tagNow());
    if (mode === "fill" && !played)
      console.error(`[tape] ${label} call ${fp.key} has no recording: asking the model, and keeping it`);
    if (mode === "replay" || (mode === "fill" && played)) {
      if (init?.signal?.aborted) throw stopped();
      if (!played) {
        console.error(diagnose(label, fp));
        // Not a busy provider: nothing is worth retrying, and nothing should fall back.
        return new Response(JSON.stringify({ error: { message: "no recording for this request" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (played.key !== fp.key && !toldOnce.has(fp.key)) {
        toldOnce.add(fp.key);
        console.error(`[tape] ${label} call ${fp.key} played ${played.key}, recorded under another prompt`);
      }
      const kept = played.kept;
      const i = Math.min(cursor.get(played.key) ?? 0, kept.responses.length - 1);
      cursor.set(played.key, i + 1);
      // Which recordings a run actually plays, one key a line, when asked
      // (MODEL_TAPE_HITS=<file>): the list a prune of stale tapes is cut by.
      if (process.env.MODEL_TAPE_HITS) appendFileSync(process.env.MODEL_TAPE_HITS, `${played.key}\n`);
      const r = kept.responses[i];
      return new Response(r.body, { status: r.status, headers: { "content-type": r.type } });
    }

    const res = await real(input, init);
    const body = await res.text();
    mkdirSync(dir(), { recursive: true });
    const earlier = begun.has(fp.key) ? read(file) : null;
    begun.add(fp.key);
    const kept: Kept = {
      label,
      asked: fp.asked,
      parts: { ...fp.parts, tag: tagNow() },
      responses: [
        ...(earlier?.responses ?? []),
        { status: res.status, type: res.headers.get("content-type") ?? "application/json", body },
      ],
    };
    writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`);
    byConversation = null;
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

const SETTINGS = "_models.json";

/**
 * The model a setting names: while recording, what the environment
 * says, written down beside the tapes; while replaying, what was written
 * down, so every call takes the road it was recorded on.
 */
export function tapedSetting(name: string, fromEnv: string | undefined): string | undefined {
  const mode = tapeMode();
  if (mode === "replay" || mode === "fill") {
    const kept = (() => {
      try {
        return JSON.parse(readFileSync(join(dir(), SETTINGS), "utf8")) as Record<string, string>;
      } catch {
        return {};
      }
    })();
    return kept[name] ?? fromEnv;
  }
  if (mode === "record" && fromEnv) {
    mkdirSync(dir(), { recursive: true });
    const file = join(dir(), SETTINGS);
    const kept = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
    if (kept[name] !== fromEnv) writeFileSync(file, `${JSON.stringify({ ...kept, [name]: fromEnv }, null, 2)}\n`);
  }
  return fromEnv;
}

/**
 * A key that has to be there: the real one, or, while replaying, a
 * stand-in, since nothing leaves the machine. Set but empty still means
 * none, so a check can switch a provider off in replay too.
 */
export const keyFor = (value: string | undefined) => value ?? (replaying() ? "replay" : undefined);
