// What each Claude model costs, and what a reply's tokens came to.
//
// Anthropic's Models API says which models a key can use, never what
// they cost, so the price is kept here as data, the way LiteLLM and
// OpenRouter keep theirs: per million tokens, in dollars, as listed at
// https://platform.claude.com/docs/en/about-claude/pricing (read
// 2026-09-26). When Anthropic changes a price, this table changes with
// it; a reply already written keeps the dollars it was priced at.
//
// A model not here is shown with its tokens and no price. A price is
// never guessed: "claude-opus-5-7" is not Opus 5's, so a name matches a
// row only as itself or as that row with a snapshot date after it.
//
// No imports, so the panel, the server and the checks read one table.

export type Price = {
  /** What the panel calls it. */
  name: string;
  input: number;
  /** Luke caches for five minutes, so this is the five-minute write. */
  cacheWrite: number;
  cacheRead: number;
  output: number;
};

const same = (name: string, p: Omit<Price, "name">): Price => ({ name, ...p });
const OPUS_4 = { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 };
const SONNET_4 = { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 };

export const PRICES: Readonly<Record<string, Price>> = {
  "claude-fable-5-1": same("Fable 5.1", { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 }),
  "claude-mythos-5-1": same("Mythos 5.1", { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 }),
  "claude-fable-5": same("Fable 5", { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 }),
  "claude-mythos-5": same("Mythos 5", { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 }),
  "claude-opus-5-5": same("Opus 5.5", { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 }),
  "claude-opus-5": same("Opus 5", OPUS_4),
  "claude-opus-4-8": same("Opus 4.8", OPUS_4),
  "claude-opus-4-7": same("Opus 4.7", OPUS_4),
  "claude-opus-4-6": same("Opus 4.6", OPUS_4),
  "claude-opus-4-5": same("Opus 4.5", OPUS_4),
  "claude-sonnet-5": same("Sonnet 5", { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 }),
  "claude-sonnet-4-6": same("Sonnet 4.6", SONNET_4),
  "claude-sonnet-4-5": same("Sonnet 4.5", SONNET_4),
  "claude-haiku-4-5": same("Haiku 4.5", { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }),
};

/**
 * Offered when the Models API cannot be asked (no key, a replayed run):
 * the newest of each line, newest first, as that API would list them.
 */
export const CURRENT_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5", "claude-haiku-4-5"];

/** The row a model is priced by: itself, or a row it is a dated snapshot of. */
export function priceOf(model: string | null | undefined): Price | null {
  if (!model) return null;
  if (PRICES[model]) return PRICES[model];
  const dated = /^(.*)-\d{8}$/.exec(model);
  return dated && PRICES[dated[1]] ? PRICES[dated[1]] : null;
}

/** What the panel calls a model: its row's name, or its id as the provider gave it. */
export const modelName = (model: string) => priceOf(model)?.name ?? model;

export type Tokens = {
  /** Every input token, cached ones included, as the SDK counts them. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

/** Dollars for these tokens on this model, or null when its price is not known. */
export function costOf(model: string, t: Tokens): number | null {
  const p = priceOf(model);
  if (!p) return null;
  const fresh = Math.max(0, t.input - t.cacheRead - t.cacheWrite);
  return (fresh * p.input + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite + t.output * p.output) / 1e6;
}

/** "$0.042", "$0.0031", "<$0.0001": enough places to tell two small replies apart. */
export function dollars(usd: number): string {
  if (usd > 0 && usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(usd >= 1 ? 2 : usd >= 0.01 ? 3 : 4)}`;
}

/** "12.4k", "820", "1.2M". */
export function tokensShort(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
