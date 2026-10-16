// What Luke read on their website, and what Luke may do (0223): Settings →
// General shows the site's lines in its own words; Settings → Luke lists
// what he may do and gives or takes back the standing yes a section at a
// time, kept in the database, at both widths.
import type { Page } from "@playwright/test";
import { expect, test } from "./shop";

async function settings(page: Page, projectId: string) {
  await page.goto(`/app/${projectId}`);
  await expect(page.getByText("Orders today")).toBeVisible({ timeout: 30_000 });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.count()) await notNow.click();
  if ((page.viewportSize()?.width ?? 0) < 1024) await page.getByRole("button", { name: "Open sections" }).click();
  await page.getByRole("button", { name: "Project settings" }).click();
  return page.getByRole("dialog");
}

test("Settings shows what their website says, in its words, and says when it cannot read again yet", async ({
  signedIn: page,
  shop,
}) => {
  await shop.admin.from("merchant_notes").insert([
    {
      project_id: shop.projectId,
      note: "You can return or exchange within 7 days of delivery.",
      kind: "policy",
      topic: "policy: returns",
      source: "website",
    },
    {
      project_id: shop.projectId,
      note: "Cash on delivery available on all orders.",
      kind: "policy",
      topic: "policy: cash on delivery",
      source: "website",
    },
  ]);
  try {
    // The read itself is checked against the server in check-site-read; here, what a refusal says.
    await page.route("**/api/site-read", (r) =>
      r.fulfill({ status: 429, json: { error: "Read a moment ago; try again in a couple of minutes." } })
    );
    const dialog = await settings(page, shop.projectId);
    const site = dialog.locator("section").filter({ hasText: "What your website says" });
    await expect(site.getByText("You can return or exchange within 7 days of delivery.")).toBeVisible();
    await expect(site.getByText("Cash on delivery", { exact: true })).toBeVisible();
    await site.getByRole("button", { name: "Read it again" }).click();
    await expect(site.getByRole("alert")).toHaveText("Read a moment ago; try again in a couple of minutes.");
    await site.screenshot({
      path: `${process.env.LOOK_DIR ?? "test-results"}/site-facts-${test.info().project.name}.png`,
    });
  } finally {
    await shop.admin.from("merchant_notes").delete().eq("project_id", shop.projectId).eq("source", "website");
  }
});

test("Settings → Luke says what he may do, and a section's standing yes is given and taken back", async ({
  signedIn: page,
  shop,
}) => {
  // A section of their own, whose rows Luke could change.
  const stamp = Date.now();
  const { data: mod } = await shop.admin
    .from("modules")
    .insert({ project_id: shop.projectId, name: `blanks_${stamp}`, nav_label: "Blanks", route: `/blanks_${stamp}` })
    .select("id")
    .single();
  try {
    const dialog = await settings(page, shop.projectId);
    await dialog.getByRole("tab", { name: "Luke" }).click();
    const may = dialog.getByRole("list", { name: "What Luke may do" });
    await expect(may.getByText("Read your store and your sections")).toBeVisible();
    await expect(may.getByText("Build or change sections and rules")).toBeVisible();
    await expect(may.locator("li").filter({ hasText: "Change values in your rows" })).toContainText("Asks you first");
    const name = "Luke changes rows in Blanks without asking";
    const first = dialog.getByRole("switch", { name });
    await first.click();
    await expect(first).toHaveAttribute("aria-checked", "true");
    await expect(may.locator("li").filter({ hasText: "Change values in your rows" })).toContainText(
      "Without asking in"
    );
    await expect
      .poll(
        async () =>
          (await shop.admin.from("luke_grants").select("module_id").eq("project_id", shop.projectId)).data?.length
      )
      .toBe(1);
    await dialog.screenshot({
      path: `${process.env.LOOK_DIR ?? "test-results"}/luke-may-${test.info().project.name}.png`,
    });
    await dialog.getByRole("switch", { name }).click();
    await expect
      .poll(
        async () =>
          (await shop.admin.from("luke_grants").select("module_id").eq("project_id", shop.projectId)).data?.length
      )
      .toBe(0);
  } finally {
    await shop.admin.from("modules").delete().eq("id", mod!.id);
  }
});
