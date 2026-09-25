// What every spec stands on: the check user, signed in, on a throwaway
// project with the seeded shop in it, and a page that fails the test on
// any uncaught error.
//
// The shop is made per worker and removed after it, the same one the
// store checks read (scripts/fixtures/seed-shop.ts), saved through the
// import's own savers. Only the check project: the env file has to say
// CHECK_PROJECT=1, because this writes.

import { readFileSync } from "node:fs";
import { test as base, expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { signInAsCheckUser, throwawayProject } from "../scripts/owner-session.mjs";
import { SEED_CURRENCY, SEED_TIMEZONE, seedNodes, seedShop } from "../scripts/fixtures/seed-shop";
import { RESOURCES } from "@/lib/shopify-resources";

const envFile = process.env.ENV_FILE ?? ".env.local";
const env = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (env.CHECK_PROJECT !== "1") {
  throw new Error(
    `${envFile} does not declare CHECK_PROJECT=1, and these specs write; point ENV_FILE at the check project's file`
  );
}

/** How the server is expected to answer for its models: what the specs were recorded against. */
export const TAPE = process.env.MODEL_TAPE ?? "replay";

type Shop = {
  admin: SupabaseClient;
  userId: string;
  projectId: string;
  storeId: string;
  session: unknown;
};

export const test = base.extend<{ signedIn: Page }, { shop: Shop }>({
  shop: [
    async ({}, use, workerInfo) => {
      const admin = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.ADAPTIVE_OS_SERVICE_ROLE_KEY);
      const anon = createClient(
        env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL,
        env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY
      );
      const me = await signInAsCheckUser(anon, env);
      if (!me.session) throw new Error(`no check user: ${me.why}`);
      // Named for the width, which Luke is told: desktop and phone then ask
      // different requests and replay their own answers. With one name
      // they shared recordings, and a turn could replay the other width's.
      const project = await throwawayProject(admin, me.user.id, `e2e ${workerInfo.project.name}`);
      try {
        const now = new Date().toISOString();
        const { data: store, error } = await admin
          .from("stores")
          .insert({
            project_id: project.id,
            provider: "shopify",
            status: "connected",
            // Unique per run, and the same to the model: a shop address is a placeholder on a tape.
            shop_domain: `e2e-${project.id.slice(0, 8)}.myshopify.com`,
            access_token: "e2e-token-opens-nothing",
            currency: SEED_CURRENCY,
            timezone: SEED_TIMEZONE,
            country: "IN",
            connected_at: now,
            last_synced_at: now,
            granted_scopes: [
              "read_orders",
              "write_orders",
              "read_products",
              "write_products",
              "read_customers",
              "write_customers",
            ],
          })
          .select("id")
          .single();
        if (error) throw new Error(`could not make the e2e store: ${error.message}`);
        await seedShop(admin, store.id);
        const nodes = seedNodes();
        await admin.from("import_runs").insert(
          RESOURCES.map((resource) => ({
            store_id: store.id,
            resource,
            status: "done",
            imported: nodes[resource].length,
            finished_at: now,
          }))
        );
        await use({ admin, userId: me.user.id, projectId: project.id, storeId: store.id, session: me.session });
      } finally {
        await project.remove();
      }
    },
    { scope: "worker", timeout: 120_000 },
  ],

  signedIn: async ({ page, shop }, use) => {
    // The session the app would have stored after a sign-in, where supabase-js looks for it.
    const key = `sb-${new URL(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [key, JSON.stringify(shop.session)] as const);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await use(page);
    expect(errors, "uncaught errors in the page").toEqual([]);
  },
});

export { expect };
