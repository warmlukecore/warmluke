// Who does what, and how long a restock takes (lib/team-facts, 0222):
// asked once in onboarding after the store, skippable, and kept in
// Settings → General. What is said becomes what Luke knows, at both widths.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { expect, test } from "./shop";

const env = Object.fromEntries(
  readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

test("Settings keeps who does what and the restock time, as what Luke knows", async ({ signedIn: page, shop }) => {
  try {
    await page.goto(`/app/${shop.projectId}`);
    await expect(page.getByText("Orders today")).toBeVisible({ timeout: 30_000 });
    const notNow = page.getByRole("button", { name: "Not now" });
    if (await notNow.count()) await notNow.click();
    if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByRole("button", { name: "Open sections" }).click();
    await page.getByRole("button", { name: "Project settings" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Your team and how you work")).toBeVisible();
    await dialog.getByLabel("Who packs and ships orders?").fill("Ravi");
    await dialog.getByLabel("Who answers customers and handles returns?").fill("me");
    await dialog.getByLabel("How many days does a restock usually take to arrive?").fill("10");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByText("Saved. Luke knows this now.")).toBeVisible();
    await dialog.screenshot({
      path: `${process.env.LOOK_DIR ?? "test-results"}/team-settings-${test.info().project.name}.png`,
    });
    const { data: notes } = await shop.admin
      .from("merchant_notes")
      .select("note, kind")
      .eq("project_id", shop.projectId)
      .like("topic", "team: %");
    expect(notes?.map((n) => n.note).sort()).toEqual([
      "Customer messages and returns: the owner themselves",
      "Packing and shipping: Ravi",
    ]);
    const { data: project } = await shop.admin
      .from("projects")
      .select("restock_days")
      .eq("id", shop.projectId)
      .single();
    expect(project?.restock_days).toBe(10);
  } finally {
    await shop.admin
      .from("merchant_notes")
      .delete()
      .eq("project_id", shop.projectId)
      .in("topic", [
        "team: packing",
        "team: customers",
        "team: ads",
        "team: restocking",
        "tools",
        "lead time: restock",
      ]);
    await shop.admin.from("projects").update({ restock_days: null, team_asked_at: null }).eq("id", shop.projectId);
  }
});

test("onboarding asks who does what once the store is in, and Skip moves on", async ({ page, shop }) => {
  // A new owner of their own: answers saved, a store connected, its history chosen.
  const stamp = Date.now();
  const email = `e2e-team-${stamp}@warmluke.test`;
  const password = `pw-${stamp}-aA1!`;
  const { data: made } = await shop.admin.auth.admin.createUser({ email, password, email_confirm: true });
  const userId = made.user!.id;
  try {
    await shop.admin.from("profiles").upsert({
      user_id: userId,
      full_name: "Asha Rao",
      business_name: "Asha Cases",
      role: "founder",
      monthly_orders: "500_2000",
      platform: "shopify",
      website: "ashacases.com",
    });
    const { data: project } = await shop.admin
      .from("projects")
      .insert({ owner_id: userId, name: "Asha Cases" })
      .select("id")
      .single();
    await shop.admin.from("stores").insert({
      project_id: project!.id,
      shop_domain: `e2e-team-${stamp}.myshopify.com`,
      status: "connected",
      history_set_at: new Date().toISOString(),
    });
    const anon = createClient(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL, env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    const { data: signed } = await anon.auth.signInWithPassword({ email, password });
    const key = `sb-${new URL(env.NEXT_PUBLIC_ADAPTIVE_OS_SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [key, JSON.stringify(signed.session)] as const);

    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "Who does what" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByLabel("Who runs your ads?")).toBeVisible();
    await page.screenshot({
      path: `${process.env.LOOK_DIR ?? "test-results"}/team-onboarding-${test.info().project.name}.png`,
    });
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.getByRole("heading", { name: "Who does what" })).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await shop.admin.from("projects").select("team_asked_at").eq("id", project!.id).single()).data?.team_asked_at
      )
      .toBeTruthy();
    // Asked once: a reload does not ask again.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Who does what" })).toHaveCount(0);
  } finally {
    await shop.admin.auth.admin.deleteUser(userId);
  }
});
