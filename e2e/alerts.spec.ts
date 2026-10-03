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

  // Asked once what to watch, in a line at the foot: all of it ticked,
  // what is coming shown and not offered.
  const choose = page.getByRole("button", { name: "Choose what" });
  await choose.click();
  const picker = page.getByRole("dialog", { name: "What should Luke keep an eye on?" });
  await expect(picker.getByRole("checkbox", { name: /Running low/ })).toHaveAttribute("aria-checked", "true");
  await expect(picker.getByRole("checkbox", { name: /Conversion changes/ })).toBeDisabled();
  await picker.getByRole("checkbox", { name: /Returns rising/ }).click();
  await picker.getByRole("button", { name: "Watch these" }).click();
  await expect(picker).toHaveCount(0);
  await expect(choose).toHaveCount(0);
  const { data: chosen } = await shop.admin
    .from("alert_settings")
    .select("kind, enabled")
    .eq("project_id", shop.projectId)
    .order("kind");
  expect(chosen?.map((c) => `${c.kind}:${c.enabled}`)).toEqual([
    "dispatch_late:true",
    "low_stock:true",
    "return_reason:true",
    "returns_spike:false",
  ]);

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

  // Put away, it stays away. Kept before the reload: a reload the same
  // instant cancelled the request once, and the alert came back.
  await Promise.all([
    page.waitForResponse((r) => r.url().includes("/rpc/abo_alerts_seen") && r.ok()),
    card.getByRole("button", { name: /^Put away:/ }).click(),
  ]);
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible({ timeout: 30_000 });
  // Answered, it is not asked again.
  await expect(choose).toHaveCount(0);

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

test("anything else to watch goes to Luke in the merchant's own words", async ({ signedIn: page, shop }) => {
  // Answered here: what is asked is the point, and no model need hear it.
  let asked: Record<string, unknown> | null = null;
  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    asked = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 402, json: { error: "No turns left in this test." } });
  });
  await page.goto(`/app/${shop.projectId}`);
  await page.getByRole("button", { name: "Choose what" }).click();
  const picker = page.getByRole("dialog", { name: "What should Luke keep an eye on?" });
  await picker.getByRole("textbox", { name: "Anything else?" }).fill("jab COD order 5000 se upar aaye");
  await picker.getByRole("button", { name: "Ask Luke to watch for it" }).click();
  await expect.poll(() => asked?.message).toBe("Alert me: jab COD order 5000 se upar aaye");
  // What was ticked is kept as well, so the question is not asked again.
  await expect(picker).toHaveCount(0);
  const { count } = await shop.admin
    .from("alert_settings")
    .select("kind", { count: "exact", head: true })
    .eq("project_id", shop.projectId);
  expect(count).toBe(4);
});

test("the cross keeps what Luke watches as it is, and the question is not asked again", async ({
  signedIn: page,
  shop,
}) => {
  await page.goto(`/app/${shop.projectId}`);
  const choose = page.getByRole("button", { name: "Choose what" });
  await expect(choose).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Keep these and hide" }).click();
  await expect(choose).toHaveCount(0);
  const { data: chosen } = await shop.admin
    .from("alert_settings")
    .select("kind, enabled")
    .eq("project_id", shop.projectId)
    .order("kind");
  expect(chosen?.map((c) => `${c.kind}:${c.enabled}`)).toEqual([
    "dispatch_late:true",
    "low_stock:true",
    "return_reason:true",
    "returns_spike:true",
  ]);
  await page.reload();
  await expect(page.getByText("Orders today")).toBeVisible({ timeout: 30_000 });
  await expect(choose).toHaveCount(0);
});
