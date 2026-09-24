// One door to the decision model (Jev, typesafe.ai), for whoever asks
// it a typed question: the judge that watches designs, the router that
// reads a merchant's question. Both need the same things — the key, a
// timeout, a refusal to throw — and had each grown a copy.
//
// Null whenever there is no answer to be had: no key, a slow reply, a
// refusal, a page instead of JSON. The caller decides what null means;
// here it only means "you have nothing from the model".

import { keyFor, tapeFetch } from "@/lib/model-tape";

export type JevAnswer = {
  choice?: string;
  score?: number;
  noul?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
};

// Which model answers. Read when asked, not when loaded, so a check can
// point it elsewhere; "jev-latest" is what typesafe.ai serves by default.
const model = () => process.env.TYPESAFE_MODEL || "jev-latest";

export async function askJev(
  /** Names the caller in the log line, so "judge: HTTP 429" is not "route: HTTP 429". */
  tag: string,
  state: unknown,
  questions: Record<string, unknown>,
  timeoutMs: number
): Promise<{ answers: Record<string, JevAnswer | undefined>; model: string } | null> {
  // While replaying, a stand-in: the answer comes from the tape (model-tape.ts).
  const key = keyFor(process.env.TYPESAFE_API_KEY);
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await tapeFetch("jev", fetch)(process.env.TYPESAFE_API_URL || "https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: model(), state, questions }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      console.error(`${tag}: HTTP ${r.status}`);
      return null;
    }
    const j = (await r.json()) as { model?: unknown; answers?: unknown };
    if (!j.answers || typeof j.answers !== "object") {
      console.error(`${tag}: the answer did not have the shape asked for`);
      return null;
    }
    return {
      answers: j.answers as Record<string, JevAnswer | undefined>,
      model: typeof j.model === "string" ? j.model : model(),
    };
  } catch (e) {
    console.error(`${tag}: ${e instanceof Error ? e.name : "failed"}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
