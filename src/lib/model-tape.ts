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
// between runs become placeholders), without the model's name: a
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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type TapeMode = "record" | "replay";

/** Recording, replaying, or neither. Never either in production. */
export function tapeMode(): TapeMode | null {
  const m = process.env.MODEL_TAPE?.trim();
  if (m !== "record" && m !== "replay") return null;
  if (process.env.VERCEL_ENV === "production") return null;
  return m;
}

export const replaying = () => tapeMode() === "replay";

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
  parts: { system: string; tools: string; conversation: string };
  responses: Array<{ status: number; type: string; body: string }>;
};

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
  const rest: Record<string, unknown> = { ...o };
  for (const k of ["system", "systemInstruction", "tools", "model"]) delete rest[k];
  // The road, without the model: Gemini names it in the path.
  const road = new URL(url).pathname.replace(/\/models\/[^/:]+/, "/models/‹model›");
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

/** Why a replayed request has no recording, as precisely as the tapes can say. */
function diagnose(label: string, fp: ReturnType<typeof fingerprint>): string {
  const all = existsSync(dir()) ? readdirSync(dir()).filter((f) => f.endsWith(".json") && !f.startsWith("_")) : [];
  const kin = all.map((f) => read(join(dir(), f))).filter((k): k is Kept => !!k && k.label === label);
  const same = kin.find((k) => k.parts.conversation === fp.parts.conversation);
  const why = same
    ? same.parts.system !== fp.parts.system
      ? "this conversation was recorded against a different system prompt: what the model is told changed"
      : "this conversation was recorded with different tools"
    : "nothing like this conversation was recorded";
  return `[tape] no recording for a ${label} call (${fp.key}): ${why}. Asked: "${fp.asked.slice(-100)}". Record again with MODEL_TAPE=record.`;
}

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

    if (mode === "replay") {
      if (init?.signal?.aborted) throw stopped();
      const kept = read(file);
      if (!kept?.responses.length) {
        console.error(diagnose(label, fp));
        // Not a busy provider: nothing is worth retrying, and nothing should fall back.
        return new Response(JSON.stringify({ error: { message: "no recording for this request" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      const i = Math.min(cursor.get(fp.key) ?? 0, kept.responses.length - 1);
      cursor.set(fp.key, i + 1);
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
      parts: fp.parts,
      responses: [
        ...(earlier?.responses ?? []),
        { status: res.status, type: res.headers.get("content-type") ?? "application/json", body },
      ],
    };
    writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`);
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
  if (mode === "replay") {
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
