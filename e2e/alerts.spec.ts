// What Luke noticed in the store (0163): found from the shop's own rows,
// shown on its overview and in the bell, put away by the owner, and
// switched off in settings. No model is asked: the asking is a turn
// like any other, and the alert only hands it its words.
import { expect, test } from "./shop";

test.afterEach(async ({ shop }) => {
  // The shop is the worker's: what this left would ring the bell in the next spec.
  await shop.admin.from("alerts").delete().eq("store_id", shop.storeId);
  await shop.admin.from("alert_settings").delete().eq("project_id", shop.projectId);
});

test("an order not sent is noticed, told in the bell and the overview, put away, and can be switched off", async ({
  signedIn: page,
  shop,
}) => {
  // The seeded cash-on-delivery order from three days ago has not gone out.
  const { error } = await shop.admin.rpc("abo_alerts_run", { p_store: shop.storeId });
  expect(error).toBeNull();
  await page.goto(`/app/${shop.projectId}`);
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;

  const card = page.locator("section").filter({ hasText: "What Luke noticed" });
  await expect(card.getByText("1 order not sent after 2 days")).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/#1008/)).toBeVisible();
  await expect(card.getByRole("button", { name: "Ask Luke" })).toBeVisible();

  if (wide) {
    // In the bell, counted, and seen once the bell is shut on it.
    const bell = page.locator('button[title="What needs you"]:visible').first();
    await expect(bell).toHaveAttribute("aria-label", "1 want your attention");
    await bell.click();
    await expect(page.getByRole("tab", { name: /Noticed/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: /Asked for/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bell).toHaveAttribute("aria-label", "Nothing waiting on you");
  }

  // Put away, it stays away.
  await card.getByRole("button", { name: /^Put away:/ }).click();
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible({ timeout: 30_000 });

  // What is watched, in settings: switched off, kept.
  if (!wide) await page.getByRole("button", { name: "Open sections" }).click();
  await page.getByRole("button", { name: "Project settings" }).click();
  await page.getByRole("tab", { name: "Alerts" }).click();
  const late = page.getByRole("switch", { name: "Late to send" });
  await expect(late).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("spinbutton").first()).toBeVisible();
  await late.click();
  await expect(late).toHaveAttribute("aria-checked", "false");
  const { data: kept } = await shop.admin
    .from("alert_settings")
    .select("enabled")
    .eq("project_id", shop.projectId)
    .eq("kind", "dispatch_late")
    .single();
  expect(kept?.enabled).toBe(false);
});
