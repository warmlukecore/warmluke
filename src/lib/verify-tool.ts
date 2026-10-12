// test_build: Luke tries what he just built on the store's real data
// before he says it is done (lib/verify.ts). The same description and
// arguments serve the owner's own AI over MCP (src/app/api/mcp/route.ts),
// so the two are tested alike.
//
// Callers: Luke's loop (src/lib/engine.ts, wired by its owner), src/app/api/mcp/route.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { jsonSchema, tool, type Tool } from "ai";
import { fitForModel } from "@/lib/store-tools";
import { testBuild, type Built } from "@/lib/verify";

export const TEST_BUILD = {
  name: "test_build",
  description:
    "Test what was just built on their real data, before saying it is done: each rule runs on the rows it would meet (nothing is written) and says how many it would change, a rule of code runs as it will run, each section is used as they will use it (worked-out columns, counters, filters, links, buttons), and each written screen is read. Name what was built; say what it should do in expect. If it finds a problem, or what it did is not what you expected, fix the build and test again. Tell them what the test showed, in plain words; never say something works that the test did not show working.",
  inputSchema: {
    type: "object",
    properties: {
      sections: {
        type: "array",
        items: { type: "string" },
        description:
          "The sections built or changed, by name. Left out with rules left out: what was built in the last hour.",
      },
      rules: { type: "array", items: { type: "string" }, description: "The rules built or changed, by name." },
      expect: {
        type: "string",
        description:
          'What it should do on their data, e.g. "sets Blank remaining on every Stock row that shares the parent SKU".',
      },
    },
  },
} as const;

type Args = { sections?: unknown; rules?: unknown; expect?: unknown };

/** What test_build was asked, as testBuild takes it. */
export function builtFrom(args: Args): { built: Built; expect?: string } {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  return {
    built: { sections: list(args.sections), rules: list(args.rules) },
    expect: typeof args.expect === "string" && args.expect.trim() ? args.expect.trim().slice(0, 500) : undefined,
  };
}

/** Luke's test_build, on the caller's own client. */
export function verifyTools(
  ctx: { db: SupabaseClient; projectId: string },
  observe?: (h: { tool: string; about: string; args: unknown; result?: unknown }) => void
): Record<string, Tool> {
  return {
    [TEST_BUILD.name]: tool({
      description: TEST_BUILD.description,
      inputSchema: jsonSchema<Args>(TEST_BUILD.inputSchema),
      execute: async (args) => {
        const { built, expect } = builtFrom(args ?? {});
        const result = await testBuild(ctx.db, ctx.projectId, built, expect);
        try {
          observe?.({ tool: TEST_BUILD.name, about: "what was built, on your data", args, result });
        } catch {
          // A listener that throws does not take the test with it.
        }
        return fitForModel(result);
      },
    }),
  };
}
